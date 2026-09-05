'use strict';

// A real voicemail box for ordinary phone calls, driven by Twilio.
//
//   caller rings your Twilio number (or your mobile forwards to it)
//     -> Twilio answers and asks this server what to do
//     -> your recorded greeting plays
//     -> the caller's message is recorded
//     -> this server downloads it into data/voicemails/, next to the
//        WhatsApp ones, and deletes Twilio's copy
//
// Run with: npm run phone

const fs = require('fs');
const path = require('path');
const express = require('express');
const twilio = require('twilio');

const { loadConfig } = require('../config');
const { log } = require('../logger');
const { writeVoicemail, recent } = require('../voicemail');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const INSECURE = process.argv.includes('--insecure');

function digitsOf(value) {
  return String(value || '').replace(/\D/g, '');
}

function isBlocked(cfg, from) {
  const caller = digitsOf(from);
  if (!caller && cfg.phone.rejectAnonymous) return 'anonymous caller';
  const hit = (cfg.phone.blocklist || []).some((entry) => digitsOf(entry) === caller);
  return hit ? 'blocklisted number' : null;
}

// Twilio signs every webhook. Without this check anyone who finds the public URL
// could post fake recordings at you.
function verifyTwilio(cfg) {
  return (req, res, next) => {
    if (INSECURE) return next();
    const signature = req.headers['x-twilio-signature'];
    const url = cfg.phone.publicUrl.replace(/\/$/, '') + req.originalUrl;
    if (signature && twilio.validateRequest(AUTH_TOKEN, signature, url, req.body)) return next();
    log.warn(`rejected an unsigned request to ${req.originalUrl}`);
    return res.status(403).type('text/plain').send('Forbidden');
  };
}

function greeting(twiml, cfg) {
  const { greetingAudio, greetingText, greetingVoice, greetingLanguage } = cfg.phone;
  if (greetingAudio) {
    twiml.play(`${cfg.phone.publicUrl.replace(/\/$/, '')}/greeting`);
  } else {
    twiml.say({ voice: greetingVoice, language: greetingLanguage }, greetingText);
  }
}

// Twilio can take a moment to finalise the audio, so a 404 right after the call
// is normal rather than fatal.
async function fetchRecording(url, attempt = 1) {
  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
  const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });

  if (response.ok) return Buffer.from(await response.arrayBuffer());
  if (attempt >= 5) throw new Error(`Twilio returned ${response.status} for the recording`);

  await new Promise((r) => setTimeout(r, attempt * 1000));
  return fetchRecording(url, attempt + 1);
}

async function storeRecording(cfg, body) {
  const url = `${body.RecordingUrl}.mp3`;
  const buffer = await fetchRecording(url);

  const entry = await writeVoicemail(cfg, {
    buffer,
    extension: 'mp3',
    channel: 'phone',
    from: body.From || 'unknown',
    number: digitsOf(body.From) || 'unknown',
    name: [body.CallerName, body.FromCity, body.FromCountry].filter(Boolean).join(' '),
    seconds: Number(body.RecordingDuration || 0),
    reason: 'phone-call',
    extra: { callSid: body.CallSid, recordingSid: body.RecordingSid },
  });

  const heard = entry.transcript ? `\n    "${entry.transcript.slice(0, 200)}"` : '';
  log.ok(`VOICEMAIL (phone) from ${entry.from} - ${entry.seconds}s -> ${entry.file}${heard}`);

  if (cfg.phone.deleteFromTwilio && ACCOUNT_SID && AUTH_TOKEN && body.RecordingSid) {
    try {
      await twilio(ACCOUNT_SID, AUTH_TOKEN).recordings(body.RecordingSid).remove();
      log.dim('deleted the copy on Twilio');
    } catch (err) {
      log.warn(`could not delete the Twilio copy: ${err.message}`);
    }
  }
  return entry;
}

function buildApp(cfg) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const verify = verifyTwilio(cfg);

  app.get('/health', (req, res) => {
    res.json({ ok: true, voicemails: recent(cfg, 1).length ? 'present' : 'none' });
  });

  // Twilio fetches the greeting from here when greetingAudio is set.
  app.get('/greeting', (req, res) => {
    const file = cfg.phone.greetingAudio ? path.resolve(cfg.paths.root, cfg.phone.greetingAudio) : '';
    if (!file || !fs.existsSync(file)) return res.status(404).send('No greeting recorded');
    res.type(path.extname(file) === '.wav' ? 'audio/wav' : 'audio/mpeg');
    fs.createReadStream(file).pipe(res);
  });

  // 1. Someone calls: answer, greet, record.
  app.post('/voice', verify, (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const from = req.body.From || 'unknown';

    const blocked = isBlocked(cfg, from);
    if (blocked) {
      log.warn(`rejected call from ${from} - ${blocked}`);
      twiml.reject();
      return res.type('text/xml').send(twiml.toString());
    }

    log.info(`INCOMING phone call from ${from} - answering`);
    greeting(twiml, cfg);
    twiml.record({
      action: '/recording',
      method: 'POST',
      maxLength: cfg.phone.maxRecordingSeconds,
      playBeep: cfg.phone.playBeep,
      finishOnKey: '#',
      trim: 'trim-silence',
    });
    // Only reached if the caller hung up without leaving anything.
    twiml.say({ voice: cfg.phone.greetingVoice, language: cfg.phone.greetingLanguage }, cfg.phone.noMessageText);
    twiml.hangup();

    res.type('text/xml').send(twiml.toString());
  });

  // 2. Recording finished: thank the caller, then fetch the audio.
  app.post('/recording', verify, (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: cfg.phone.greetingVoice, language: cfg.phone.greetingLanguage }, cfg.phone.thanksText);
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());

    // Downloading takes a second or two - don't make the caller wait on it.
    storeRecording(cfg, req.body).catch((err) => {
      log.error(`could not save the phone voicemail: ${err.message}`);
    });
  });

  app.post('/status', verify, (req, res) => {
    if (req.body.CallStatus === 'no-answer' || req.body.CallStatus === 'failed') {
      log.dim(`call ${req.body.CallSid} ended as ${req.body.CallStatus}`);
    }
    res.sendStatus(204);
  });

  return app;
}

function start() {
  const cfg = loadConfig();

  if (!INSECURE) {
    if (!AUTH_TOKEN) {
      log.error('TWILIO_AUTH_TOKEN is not set - put it in .env (needed to verify Twilio requests)');
      process.exit(1);
    }
    if (!cfg.phone.publicUrl) {
      log.error('phone.publicUrl is empty in config.json - set it to your public https URL');
      process.exit(1);
    }
  }

  const app = buildApp(cfg);
  const server = app.listen(cfg.phone.port, () => {
    log.banner('Phone voicemail server');
    log.dim(`listening on   : http://localhost:${cfg.phone.port}`);
    log.dim(`public url     : ${cfg.phone.publicUrl || '(not set - running insecure)'}`);
    log.dim(`greeting       : ${cfg.phone.greetingAudio || `text-to-speech (${cfg.phone.greetingVoice})`}`);
    log.dim(`max message    : ${cfg.phone.maxRecordingSeconds}s`);
    log.dim(`saving to      : ${cfg.voicemail.saveDir}`);
    if (INSECURE) log.warn('running with --insecure: Twilio signatures are NOT checked');
    log.info(`point your Twilio number's Voice webhook at ${cfg.phone.publicUrl || '<public url>'}/voice`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log.warn('shutting down...');
      server.close(() => process.exit(0));
    });
  }
}

if (require.main === module) start();

module.exports = { buildApp, storeRecording, isBlocked };
