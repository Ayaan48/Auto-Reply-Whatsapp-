'use strict';

// Pulls voicemails down from Twilio into data/voicemails/.
//
// Use this with the no-server setup: Twilio answers the call by itself using a
// TwiML Bin, and this fetches whatever it recorded. No public URL, no tunnel,
// nothing exposed — it only ever makes outbound calls to Twilio's API.
//
//   npm run phone:pull            fetch anything new, then exit
//   npm run phone:pull -- --watch check every few minutes and keep running

const { loadConfig } = require('../config');
const { log } = require('../logger');
const { writeVoicemail, readIndex } = require('../voicemail');
const { client, recordingMediaUrl, fetchRecording, deleteRecording } = require('./twilio-api');

function digitsOf(value) {
  return String(value || '').replace(/\D/g, '');
}

const REAL_API = { client, recordingMediaUrl, fetchRecording, deleteRecording };

async function callerFor(api, callSid) {
  if (!callSid) return {};
  try {
    const call = await api.client().calls(callSid).fetch();
    return { from: call.from, name: [call.fromFormatted].filter(Boolean).join(' ') };
  } catch {
    return {};
  }
}

async function pullOnce(cfg, { limit = 50, api = REAL_API } = {}) {
  const alreadyHave = new Set(
    readIndex(cfg.paths.voicemails)
      .map((v) => v.recordingSid)
      .filter(Boolean),
  );

  const recordings = await api.client().recordings.list({ limit });
  const fresh = recordings.filter((r) => !alreadyHave.has(r.sid)).reverse();

  if (fresh.length === 0) return [];

  const saved = [];
  for (const rec of fresh) {
    try {
      const buffer = await api.fetchRecording(api.recordingMediaUrl(rec.sid));
      const caller = await callerFor(api, rec.callSid);

      const entry = await writeVoicemail(cfg, {
        buffer,
        extension: 'mp3',
        channel: 'phone',
        from: caller.from || 'unknown',
        number: digitsOf(caller.from) || 'unknown',
        name: caller.name || '',
        seconds: Number(rec.duration || 0),
        reason: 'phone-call',
        receivedAt: rec.dateCreated ? new Date(rec.dateCreated) : new Date(),
        extra: { callSid: rec.callSid, recordingSid: rec.sid },
      });

      const heard = entry.transcript ? `\n    "${entry.transcript.slice(0, 200)}"` : '';
      log.ok(`VOICEMAIL (phone) from ${entry.from} - ${entry.seconds}s -> ${entry.file}${heard}`);
      saved.push(entry);

      if (cfg.phone.deleteFromTwilio) {
        await api.deleteRecording(rec.sid);
        log.dim('deleted the copy on Twilio');
      }
    } catch (err) {
      log.error(`could not pull recording ${rec.sid}: ${err.message}`);
    }
  }
  return saved;
}

async function main() {
  const cfg = loadConfig();
  const watch = process.argv.includes('--watch');
  const everyMinutes = Number(cfg.phone.pullEveryMinutes) || 5;

  log.banner('Twilio voicemail pull');

  const run = async () => {
    try {
      const saved = await pullOnce(cfg);
      if (saved.length === 0) log.dim('nothing new on Twilio');
      else log.ok(`saved ${saved.length} new voicemail(s)`);
    } catch (err) {
      log.error(err.message);
      if (!watch) process.exitCode = 1;
    }
  };

  await run();

  if (watch) {
    log.info(`watching - checking again every ${everyMinutes} min (Ctrl+C to stop)`);
    setInterval(run, everyMinutes * 60000);
  }
}

if (require.main === module) main();

module.exports = { pullOnce };
