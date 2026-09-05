// Offline test of the phone voicemail server.
// A local stub stands in for Twilio's recording host, so no account,
// no network and no real calls are involved.

process.env.BOT_LOG_FILE = require('path').join(require('os').tmpdir(), 'wa-bot-test.log');
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const twilio = require('twilio');

const { loadConfig } = require('../src/config');
const { buildApp, storeRecording, isBlocked } = require('../src/phone/server');
const { readIndex } = require('../src/voicemail');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

const cfg = loadConfig();
cfg.paths.voicemails = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-vm-'));
cfg.phone.publicUrl = 'https://example.test';
cfg.phone.deleteFromTwilio = false;
cfg.phone.blocklist = ['+1 800 555 0100'];

const FAKE_MP3 = Buffer.from('ID3fake-mp3-audio-bytes-for-testing');

// Signs a form body exactly the way Twilio does, so the real verification
// middleware is exercised rather than bypassed.
function sign(url, params) {
  return twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, url, params);
}

function post(port, route, params, { badSignature = false } = {}) {
  const body = new URLSearchParams(params).toString();
  const signature = badSignature ? 'nope' : sign(`${cfg.phone.publicUrl}${route}`, params);
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body,
  });
}

(async () => {
  // Stub Twilio's media host: serves the "recording" the server will download.
  let served = 0;
  const twilioStub = http.createServer((req, res) => {
    if (!req.headers.authorization?.startsWith('Basic ')) {
      res.writeHead(401).end();
      return;
    }
    served += 1;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(FAKE_MP3);
  });
  await new Promise((r) => twilioStub.listen(0, '127.0.0.1', r));
  const stubPort = twilioStub.address().port;

  const app = buildApp(cfg);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  console.log('\nrequest verification');
  let res = await post(port, '/voice', { From: '+911234567890', CallSid: 'CA1' }, { badSignature: true });
  check('unsigned request is refused', res.status === 403, `got ${res.status}`);

  console.log('\nanswering a call');
  res = await post(port, '/voice', { From: '+911234567890', CallSid: 'CA1' });
  let xml = await res.text();
  check('answers a signed call', res.status === 200, `got ${res.status}`);
  check('speaks the greeting', xml.includes('<Say') && xml.includes('leave your message'), xml);
  check('uses the configured voice', xml.includes('Polly.Aditi'), xml);
  check('records the caller', /<Record[^>]*action="\/recording"/.test(xml), xml);
  check('records with a beep', xml.includes('playBeep="true"'), xml);
  check('caps the recording length', xml.includes(`maxLength="${cfg.phone.maxRecordingSeconds}"`), xml);

  console.log('\ngreeting audio');
  cfg.phone.greetingAudio = 'data/test-greeting.mp3';
  fs.writeFileSync(path.join(cfg.paths.root, 'data/test-greeting.mp3'), FAKE_MP3);
  res = await post(port, '/voice', { From: '+911234567890', CallSid: 'CA2' });
  xml = await res.text();
  check('plays your recording when one is set', xml.includes('<Play>') && xml.includes('/greeting'), xml);
  res = await fetch(`http://127.0.0.1:${port}/greeting`);
  check('serves the greeting file to Twilio', res.status === 200 && (await res.arrayBuffer()).byteLength === FAKE_MP3.length);
  cfg.phone.greetingAudio = '';

  console.log('\nblocked callers');
  check('blocklist matches regardless of formatting', isBlocked(cfg, '18005550100') === 'blocklisted number');
  res = await post(port, '/voice', { From: '+18005550100', CallSid: 'CA3' });
  xml = await res.text();
  check('blocked caller is rejected, not recorded', xml.includes('<Reject') && !xml.includes('<Record'), xml);

  console.log('\nsaving the message');
  res = await post(port, '/recording', {
    From: '+919876543210',
    CallSid: 'CA4',
    RecordingSid: 'RE4',
    RecordingDuration: '17',
    RecordingUrl: `http://127.0.0.1:${stubPort}/recordings/RE4`,
    CallerName: 'Test Caller',
  });
  xml = await res.text();
  check('thanks the caller and hangs up', xml.includes('<Say') && xml.includes('<Hangup'), xml);

  const entry = await storeRecording(cfg, {
    From: '+919876543210',
    CallSid: 'CA5',
    RecordingSid: 'RE5',
    RecordingDuration: '17',
    RecordingUrl: `http://127.0.0.1:${stubPort}/recordings/RE5`,
    CallerName: 'Test Caller',
  });
  const abs = path.join(cfg.paths.root, entry.file);
  check('downloaded with basic auth', served > 0);
  check('audio saved as mp3', fs.existsSync(abs) && entry.file.endsWith('.mp3'), entry.file);
  check('tagged as a phone voicemail', entry.channel === 'phone' && entry.reason === 'phone-call');
  check('caller number recorded', entry.number === '919876543210', entry.number);
  check('duration recorded', entry.seconds === 17);
  check('call ids kept for reference', entry.callSid === 'CA5' && entry.recordingSid === 'RE5');
  check('sidecar json written', fs.existsSync(abs.replace(/\.mp3$/, '.json')));

  const index = readIndex(cfg.paths.voicemails);
  check('listed in the shared voicemail index', index.length >= 1 && index.some((v) => v.id === entry.id));

  console.log('\npulling recordings without a server');
  const { pullOnce } = require('../src/phone/pull');
  const deleted = [];
  const listed = [{ sid: 'RE9', callSid: 'CA9', duration: '23', dateCreated: new Date() }];
  const stubApi = {
    client: () => ({
      recordings: { list: async () => listed },
      calls: () => ({ fetch: async () => ({ from: '+919000000001', fromFormatted: '+91 90000 00001' }) }),
    }),
    recordingMediaUrl: (sid) => `http://127.0.0.1:${stubPort}/recordings/${sid}`,
    fetchRecording: async (url) => {
      const r = await fetch(url, { headers: { Authorization: 'Basic x' } });
      return Buffer.from(await r.arrayBuffer());
    },
    deleteRecording: async (sid) => deleted.push(sid),
  };

  cfg.phone.deleteFromTwilio = true;
  let pulled = await pullOnce(cfg, { api: stubApi });
  check('pulls a new recording from Twilio', pulled.length === 1, JSON.stringify(pulled.map((p) => p.id)));
  check('caller number resolved from the call record', pulled[0]?.number === '919000000001', pulled[0]?.number);
  check('duration carried over', pulled[0]?.seconds === 23);
  check('saved as a phone voicemail', pulled[0]?.channel === 'phone');
  check('Twilio copy deleted after download', deleted.includes('RE9'));

  pulled = await pullOnce(cfg, { api: stubApi });
  check('already-saved recording is not pulled twice', pulled.length === 0, JSON.stringify(pulled));

  server.close();
  twilioStub.close();
  fs.rmSync(cfg.paths.voicemails, { recursive: true, force: true });
  fs.rmSync(path.join(cfg.paths.root, 'data/test-greeting.mp3'), { force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
