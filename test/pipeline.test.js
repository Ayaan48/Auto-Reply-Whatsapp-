// Offline end-to-end test of the bot's decision logic against a stub socket.
// No network, no WhatsApp: it drives the real handlers with fake events.

// keep fake test traffic out of the real bot log
process.env.BOT_LOG_FILE = require('path').join(require('os').tmpdir(), 'wa-bot-test.log');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../src/config');
const store = require('../src/store');
const bot = require('../src/index');
const { saveVoicemail } = require('../src/voicemail');

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

// ---- stubs -------------------------------------------------------------
const sent = [];
const rejected = [];
const sock = {
  user: { id: '10000000000:5@s.whatsapp.net', name: 'Owner' },
  sendMessage: async (jid, content) => sent.push({ jid, ...content }),
  sendPresenceUpdate: async () => {},
  readMessages: async () => {},
  rejectCall: async (id, from) => rejected.push({ id, from }),
  updateMediaMessage: async () => {},
};

const CONTACT = '919111111111@s.whatsapp.net';
const OTHER = '919222222222@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const OWNER = '10000000000@s.whatsapp.net';

function textMsg(from, text, fromMe = false) {
  return {
    key: { remoteJid: from, fromMe, id: 'M' + Math.random().toString(16).slice(2) },
    pushName: 'Sam Rivera',
    message: { conversation: text },
  };
}

function audioMsg(from) {
  return {
    key: { remoteJid: from, fromMe: false, id: 'A' + Math.random().toString(16).slice(2) },
    pushName: 'Sam Rivera',
    message: {
      audioMessage: {
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        seconds: 9,
        fileLength: 4321,
        mediaKey: Buffer.alloc(32, 1),
        url: 'https://mmg.whatsapp.net/fake',
        directPath: '/v/fake',
      },
    },
  };
}

const since = () => sent.length;
const newSince = (n) => sent.slice(n);

// ---- setup -------------------------------------------------------------
const cfg = loadConfig();
cfg.autoReply.typingDelayMs = [0, 0];
cfg.autoReply.blocklist = ['+91 93333 33333'];
cfg.calls.ringSeconds = 0; // the ring delay gets its own section further down
cfg.autoReply.replyDelayMinutes = 0; // the reply hold gets its own section too
cfg.autoReply.notifyOwner = false; // tested separately; keeps other counts clean
cfg.autoReply.quietAfterYouReplyMinutes = 0; // its own section further down
cfg.paths.voicemails = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-test-'));
store.load();
store.state.paused = false;
store.state.contacts = {};

bot.__inject({ cfg, sock, ownJid: OWNER });

(async () => {
  console.log('\nmessage auto-reply');
  let n = since();
  await bot.handleMessage(textMsg(CONTACT, 'Hello there!'));
  let out = newSince(n);
  check('replies to a new contact', out.length === 1, JSON.stringify(out));
  // Compared against whatever the config currently says, so editing the wording
  // in config.json never breaks the test - only the wrong rule firing does.
  const ruleTail = (name) => cfg.autoReply.rules.find((r) => r.name === name).reply.slice(-30);
  check('uses the greeting rule', (out[0]?.text || '').endsWith(ruleTail('greeting')), out[0]?.text);
  check('addressed to the sender', out[0]?.jid === CONTACT);
  check('personalised with first name', /\bSam\b/.test(out[0]?.text || ''), out[0]?.text);

  n = since();
  await bot.handleMessage(textMsg(CONTACT, 'Hello again!'));
  check('cooldown blocks a second reply', newSince(n).length === 0);

  n = since();
  await bot.handleMessage(textMsg(GROUP, 'hi everyone'));
  check('ignores group chats', newSince(n).length === 0);

  n = since();
  await bot.handleMessage(textMsg('919333333333@s.whatsapp.net', 'hello'));
  check('blocklisted number gets nothing', newSince(n).length === 0);

  n = since();
  cfg.autoReply.allowlist = ['+91 95555 55555'];
  await bot.handleMessage(textMsg('919666666666@s.whatsapp.net', 'hello'));
  check('allowlist keeps everyone else out', newSince(n).length === 0);
  n = since();
  await bot.handleMessage(textMsg('919555555555@s.whatsapp.net', 'hello'));
  check('allowlisted number still gets a reply', newSince(n).length === 1, JSON.stringify(newSince(n)));
  cfg.autoReply.allowlist = [];

  n = since();
  cfg.autoReply.replyOnlyOutsideBusinessHours = true;
  cfg.autoReply.businessHours = { timezone: '', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' };
  await bot.handleMessage(textMsg('919777777777@s.whatsapp.net', 'hello'));
  check('silent inside business hours', newSince(n).length === 0);
  n = since();
  cfg.autoReply.businessHours.days = [];
  await bot.handleMessage(textMsg('919888888888@s.whatsapp.net', 'hello'));
  check('replies outside business hours', newSince(n).length === 1);
  cfg.autoReply.replyOnlyOutsideBusinessHours = false;

  n = since();
  await bot.handleMessage(textMsg('919444444444@s.whatsapp.net', 'what is the price?'));
  out = newSince(n);
  check('keyword rule picks pricing reply', (out[0]?.text || '').endsWith(ruleTail('pricing')), out[0]?.text);

  n = since();
  await bot.handleMessage({ key: { remoteJid: CONTACT, fromMe: false, id: 'R1' }, message: { reactionMessage: {} } });
  check('ignores reactions', newSince(n).length === 0);

  n = since();
  await bot.handleMessage(textMsg('status@broadcast', 'a status update'));
  check('ignores status broadcasts', newSince(n).length === 0);

  console.log('\nholding the reply so you can answer first');
  const hold = (ms) => new Promise((r) => setTimeout(r, ms));
  cfg.autoReply.replyDelayMinutes = 0.02; // ~1.2s
  cfg.autoReply.quietAfterYouReplyMinutes = 1; // stays out of a live conversation
  cfg.autoReply.cooldownMinutes = 0;

  const HELD = '919801010101@s.whatsapp.net';
  n = since();
  await bot.handleMessage(textMsg(HELD, 'hey are you there'));
  check('nothing is sent immediately', newSince(n).length === 0);
  await hold(1600);
  check('the reply lands after the hold', newSince(n).length === 1, JSON.stringify(newSince(n)));

  const BEATEN = '919802020202@s.whatsapp.net';
  n = since();
  await bot.handleMessage(textMsg(BEATEN, 'you free tonight?'));
  await hold(300);
  await bot.handleMessage(textMsg(BEATEN, 'yeah I am, what is up', true)); // you reply yourself
  await hold(1600);
  check('answering yourself cancels the queued reply', newSince(n).length === 0, JSON.stringify(newSince(n)));

  n = since();
  await bot.handleMessage(textMsg(BEATEN, 'cool see you then'));
  check('no reply while you are mid-conversation', newSince(n).length === 0);
  await hold(1600);
  check('and nothing sneaks out afterwards either', newSince(n).length === 0, JSON.stringify(newSince(n)));

  console.log('\nknowing who still needs you');
  cfg.autoReply.notifyOwner = true;
  const NUDGE = '919803030303@s.whatsapp.net';
  n = since();
  await bot.handleMessage(textMsg(NUDGE, 'can you send the file?'));
  await hold(1600);
  out = newSince(n);
  check('you get a nudge in your own chat', out.some((m) => m.jid === OWNER), JSON.stringify(out.map((m) => m.jid)));
  check('the nudge quotes what they said', out.some((m) => m.jid === OWNER && /send the file/.test(m.text)), JSON.stringify(out));
  cfg.autoReply.notifyOwner = false;

  n = since();
  await bot.handleMessage(textMsg(OWNER, '!pending', true));
  out = newSince(n);
  check('!pending lists them', /waiting on you/i.test(out[0]?.text || ''), out[0]?.text);
  check('!pending shows their message', /send the file/.test(out[0]?.text || ''), out[0]?.text);

  await bot.handleMessage(textMsg(NUDGE, 'thanks!', true)); // you finally reply
  n = since();
  await bot.handleMessage(textMsg(OWNER, '!pending', true));
  check('replying yourself clears them from the list', !/919803030303/.test(newSince(n)[0]?.text || ''), newSince(n)[0]?.text);

  cfg.autoReply.replyDelayMinutes = 0;
  cfg.autoReply.quietAfterYouReplyMinutes = 0;
  cfg.autoReply.cooldownMinutes = 2;

  console.log('\nAI chatting in your place');
  const aiModule = require('../src/ai');
  const realGenerateReply = aiModule.generateReply; // restored at the end of this section
  const aiCalls = [];
  aiModule.generateReply = async (c, { text, mode, history }) => {
    aiCalls.push({ text, mode, historyLength: (history || []).length });
    return `ai says: ${text}`;
  };

  cfg.aiChat.enabled = true;
  cfg.aiChat.holdSeconds = [0, 0];
  cfg.aiChat.maxTurns = 3;
  const CHATTER = '919804040404@s.whatsapp.net';

  n = since();
  await bot.handleMessage(textMsg(CHATTER, 'yo whats up'));
  await hold(200);
  check('AI stays off until you switch it on for a chat', !aiCalls.length, JSON.stringify(aiCalls));

  await bot.handleMessage({ ...textMsg(CHATTER, '!ai on', true) });
  check('!ai on turns it on for that chat', store.contact(CHATTER).aiChat === true);

  n = since();
  aiCalls.length = 0;
  await bot.handleMessage(textMsg(CHATTER, 'so are you coming tonight'));
  await hold(200);
  out = newSince(n);
  check('AI answers the chat', out.length === 1 && /ai says/.test(out[0].text), JSON.stringify(out));
  check('it uses conversation mode, not the away-message prompt', aiCalls[0]?.mode === 'chat', JSON.stringify(aiCalls));

  n = since();
  await bot.handleMessage(textMsg(CHATTER, 'and again'));
  await hold(200);
  check('no cooldown in conversation mode', newSince(n).length === 1, JSON.stringify(newSince(n)));

  n = since();
  await bot.handleMessage(textMsg(CHATTER, 'third one'));
  await hold(200);
  await bot.handleMessage(textMsg(CHATTER, 'fourth one'));
  await hold(200);
  out = newSince(n);
  check('it stops after maxTurns', out.filter((m) => m.jid === CHATTER).length === 1, JSON.stringify(out));
  check('and tells you to take over', out.some((m) => m.jid === OWNER), JSON.stringify(out.map((m) => m.jid)));

  await bot.handleMessage(textMsg(CHATTER, 'ok ill handle it', true));
  check('you taking over resets its turn count', store.contact(CHATTER).aiTurns === 0);

  n = since();
  store.state.paused = true;
  await bot.handleMessage(textMsg(CHATTER, 'you there?'));
  await hold(200);
  check('!pause silences the AI too', newSince(n).length === 0);
  store.state.paused = false;

  n = since();
  cfg.autoReply.blocklist = ['919804040404'];
  await bot.handleMessage(textMsg(CHATTER, 'hello?'));
  await hold(200);
  check('blocklist beats AI chat', newSince(n).length === 0);
  cfg.autoReply.blocklist = ['+91 93333 33333'];

  await bot.handleMessage({ ...textMsg(CHATTER, '!ai off', true) });
  check('!ai off turns it back off', store.contact(CHATTER).aiChat === false);
  cfg.aiChat.enabled = false;
  aiModule.generateReply = realGenerateReply; // stop stubbing; the next section tests the real thing

  console.log('\nclaude CLI backend (Pro subscription instead of API credits)');
  const realAi = require('../src/ai');
  const cliCfg = JSON.parse(JSON.stringify({ aiChat: cfg.aiChat }));
  cliCfg.aiChat.backend = 'cli';
  cliCfg.aiChat.cliTimeoutSeconds = 5;
  // These tests echo the whole prompt back to inspect it; the normal 40-word
  // cap would clip it long before the interesting parts.
  cliCfg.aiChat.maxWords = 5000;
  const ask = (command, text) => {
    cliCfg.aiChat.cliCommand = command;
    return realAi.generateReply(cliCfg, {
      text,
      history: [{ role: 'user', text: 'earlier message' }],
      vars: { name: 'Sam', time: '20:00', date: '5/9/2026' },
      mode: 'chat',
    });
  };

  check('uses the CLI reply', (await ask('cat >/dev/null; echo "yeah sounds good"', 'you coming?')) === 'yeah sounds good');

  const echoed = await ask('cat', 'the new message');
  check('the prompt is piped in on stdin', /the new message/.test(echoed || ''), String(echoed).slice(0, 80));
  check('the conversation history goes with it', /earlier message/.test(echoed || ''));
  check('so do the persona instructions', /texting on WhatsApp/i.test(echoed || ''));

  check('a failing CLI returns nothing rather than garbage', (await ask('cat >/dev/null; exit 1', 'hi')) === null);
  check('a hanging CLI times out instead of blocking forever', (await ask('sleep 30', 'hi')) === null);

  // Anything a contact types must reach the CLI as text, never as shell syntax.
  const nasty = await ask('cat', 'hi; rm -rf /tmp/nope $(whoami) `id`');
  check('contact text cannot become shell commands', /rm -rf \/tmp\/nope/.test(nasty || ''), String(nasty).slice(0, 120));

  console.log('\nAI chat for every chat (no !ai needed)');
  aiModule.generateReply = async ({}, { text }) => `ai says: ${text}`;
  cfg.aiChat.enabled = true;
  cfg.aiChat.allChats = true;
  cfg.aiChat.holdSeconds = [0, 0];
  cfg.aiChat.maxTurns = 5;

  const STRANGER = '919805050505@s.whatsapp.net';
  n = since();
  await bot.handleMessage(textMsg(STRANGER, 'hey who is this'));
  await hold(200);
  check('a chat you never enabled still gets the AI', newSince(n).length === 1, JSON.stringify(newSince(n)));
  check('and it did not need !ai first', store.contact(STRANGER).aiChat !== true);

  n = since();
  const bizMsg2 = textMsg('918000000009@s.whatsapp.net', 'Your OTP is 1234, do not share');
  bizMsg2.pushName = 'HDFC Bank';
  await bot.handleMessage(bizMsg2);
  await hold(200);
  check('spam still gets nothing, even with allChats', newSince(n).length === 0, JSON.stringify(newSince(n)));

  n = since();
  cfg.autoReply.blocklist = ['919806060606'];
  await bot.handleMessage(textMsg('919806060606@s.whatsapp.net', 'hello'));
  await hold(200);
  check('blocklist still wins over allChats', newSince(n).length === 0);
  cfg.autoReply.blocklist = ['+91 93333 33333'];

  n = since();
  await bot.handleMessage(textMsg(GROUP, 'hi all'));
  await hold(200);
  check('groups are still left alone', newSince(n).length === 0);

  cfg.aiChat.allChats = false;
  cfg.aiChat.enabled = false;
  aiModule.generateReply = realGenerateReply;

  console.log('\nwhat the AI should not answer');
  aiModule.generateReply = async ({}, { text }) => `ai says: ${text}`;
  cfg.aiChat.enabled = true;
  cfg.aiChat.allChats = true;
  cfg.aiChat.holdSeconds = [0, 0];
  cfg.aiChat.maxTurns = 50;
  cfg.autoReply.notifyOwner = true;

  const mediaMsg = (from, type, caption) => ({
    key: { remoteJid: from, fromMe: false, id: 'X' + Math.random().toString(16).slice(2) },
    pushName: 'Sam Rivera',
    message: { [type]: caption ? { caption } : {} },
  });

  const PIC = '919810101010@s.whatsapp.net';
  n = since();
  await bot.handleMessage(mediaMsg(PIC, 'imageMessage'));
  await hold(200);
  out = newSince(n);
  const toThem = out.filter((m) => m.jid === PIC);
  check('a photo gets a short acknowledgement, not an AI reply', toThem.length === 1 && !/ai says/.test(toThem[0].text), JSON.stringify(out));
  check('and you get told about it', out.some((m) => m.jid === OWNER), JSON.stringify(out.map((m) => m.jid)));

  const DOC = '919811111111@s.whatsapp.net';
  n = since();
  await bot.handleMessage(mediaMsg(DOC, 'documentMessage'));
  await hold(200);
  check('a document is treated the same way', !newSince(n).some((m) => /ai says/.test(m.text || '')), JSON.stringify(newSince(n)));

  cfg.aiChat.onAttachment = 'ignore';
  const PIC2 = '919812121212@s.whatsapp.net';
  n = since();
  await bot.handleMessage(mediaMsg(PIC2, 'imageMessage'));
  await hold(200);
  check('"ignore" sends the sender nothing at all', !newSince(n).some((m) => m.jid === PIC2), JSON.stringify(newSince(n)));
  cfg.aiChat.onAttachment = 'acknowledge';

  const CODE = '919813131313@s.whatsapp.net';
  n = since();
  await bot.handleMessage(textMsg(CODE, '449102'));
  await hold(200);
  check('a bare code gets no AI reply', !newSince(n).some((m) => m.jid === CODE), JSON.stringify(newSince(n)));
  check('but you are told about it', newSince(n).some((m) => m.jid === OWNER));

  n = since();
  await bot.handleMessage(textMsg(CODE, 'your otp is 8899, do not share'));
  await hold(200);
  check('an OTP message gets no AI reply either', !newSince(n).some((m) => m.jid === CODE));

  n = since();
  await bot.handleMessage(textMsg(CODE, 'my number is 9876543210 by the way'));
  await hold(200);
  check('a number inside normal chat is still answered', newSince(n).some((m) => m.jid === CODE && /ai says/.test(m.text)), JSON.stringify(newSince(n)));

  cfg.aiChat.enabled = false;
  cfg.aiChat.allChats = false;
  cfg.autoReply.notifyOwner = false;
  aiModule.generateReply = realGenerateReply;

  console.log('\nrate limits off');
  cfg.autoReply.cooldownMinutes = 0;
  cfg.autoReply.maxRepliesPerContactPerDay = 0;
  cfg.autoReply.replyDelayMinutes = 0;
  cfg.autoReply.quietAfterYouReplyMinutes = 0;
  const CHATTY = '919807070707@s.whatsapp.net';

  n = since();
  await bot.handleMessage(textMsg(CHATTY, 'one'));
  await bot.handleMessage(textMsg(CHATTY, 'two'));
  await bot.handleMessage(textMsg(CHATTY, 'three'));
  check('every message gets a reply with limits at 0', newSince(n).length === 3, String(newSince(n).length));

  cfg.autoReply.maxRepliesPerContactPerDay = 1;
  n = since();
  await bot.handleMessage(textMsg('919808080808@s.whatsapp.net', 'one'));
  await bot.handleMessage(textMsg('919808080808@s.whatsapp.net', 'two'));
  check('a non-zero daily cap still applies', newSince(n).length === 1, String(newSince(n).length));
  cfg.autoReply.maxRepliesPerContactPerDay = 0;
  cfg.autoReply.cooldownMinutes = 2;

  console.log('\nwhich message events count');
  const { shouldHandleUpsert } = bot;
  const nowSec = Math.floor(Date.now() / 1000);
  const ev = (fromMe, ts) => ({ key: { fromMe }, messageTimestamp: ts });

  check('incoming messages are handled', shouldHandleUpsert(ev(false, nowSec), 'notify'));
  check('your own message synced from your phone is handled', shouldHandleUpsert(ev(true, nowSec), 'append'));
  check("someone else's history sync is ignored", !shouldHandleUpsert(ev(false, nowSec), 'append'));
  check('your own old message is not replayed', !shouldHandleUpsert(ev(true, nowSec - 3600), 'append'));
  check('your own message with no timestamp still counts', shouldHandleUpsert(ev(true, 0), 'append'));

  console.log('\nowner commands');
  n = since();
  await bot.handleMessage(textMsg(CONTACT, '!pause', true));
  out = newSince(n);
  check('!pause is acknowledged', out.length === 1 && /paused/i.test(out[0].text), JSON.stringify(out));
  check('acknowledgement goes to your own chat, not the contact', out[0]?.jid === OWNER);
  check('bot is paused', store.state.paused === true);

  n = since();
  await bot.handleMessage(textMsg(OTHER, 'hello?'));
  check('no replies while paused', newSince(n).length === 0);

  n = since();
  await bot.handleMessage(textMsg(CONTACT, '!resume', true));
  check('!resume clears the pause', store.state.paused === false && newSince(n).length === 1);

  n = since();
  await bot.handleMessage(textMsg(CONTACT, 'this is my own message', true));
  check('own non-command messages are never replied to', newSince(n).length === 0);

  console.log('\nincoming calls');
  n = since();
  const call = { id: 'CALL1', from: OTHER, chatId: OTHER, status: 'offer', isVideo: false, isGroup: false, date: new Date() };
  await bot.handleCall(call);
  out = newSince(n);
  check('call is declined', rejected.length === 1 && rejected[0].id === 'CALL1', JSON.stringify(rejected));
  check('voicemail prompt is sent', out.length === 1 && /voice message/i.test(out[0].text), JSON.stringify(out));
  check('prompt goes to the caller', out[0]?.jid === OTHER);
  const otherContact = store.contact(OTHER);
  check('voicemail window is open', otherContact.awaitingVoicemailUntil > Date.now());

  n = since();
  await bot.handleCall(call);
  check('repeat call node is de-duplicated', rejected.length === 1 && newSince(n).length === 0);

  n = since();
  await bot.handleCall({ id: 'CALL2', from: OTHER, chatId: OTHER, status: 'offer', isVideo: true, isGroup: false });
  check('video call also declined (enabled in config)', rejected.length === 2);
  check('prompt suppressed by call cooldown', newSince(n).length === 0);

  n = since();
  await bot.handleMessage(textMsg(OTHER, 'why did you hang up'));
  check('no generic auto-reply stacked on the call notice', newSince(n).length === 0);

  console.log('\nring, then decline');
  cfg.calls.ringSeconds = 1;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const offer = (id, from) => ({ id, from, chatId: from, status: 'offer', isVideo: false, isGroup: false });

  rejected.length = 0;
  n = since();
  const started = Date.now();
  const ringing = bot.handleCall(offer('RING1', '919101010101@s.whatsapp.net'));
  await wait(300);
  check('call is left ringing at first', rejected.length === 0);
  await ringing;
  const elapsed = Date.now() - started;
  check('declined only after the ring delay', rejected.length === 1 && elapsed >= 950, `${elapsed}ms`);
  check('voicemail prompt follows the decline', newSince(n).length === 1);

  rejected.length = 0;
  n = since();
  const answered = bot.handleCall(offer('RING2', '919202020202@s.whatsapp.net'));
  await wait(200);
  await bot.handleCall({ id: 'RING2', from: '919202020202@s.whatsapp.net', chatId: '919202020202@s.whatsapp.net', status: 'accept' });
  await answered;
  check('a call you pick up is never declined', rejected.length === 0);
  check('a call you pick up gets no voicemail prompt', newSince(n).length === 0);

  rejected.length = 0;
  n = since();
  const abandoned = bot.handleCall(offer('RING3', '919303030303@s.whatsapp.net'));
  await wait(200);
  await bot.handleCall({ id: 'RING3', from: '919303030303@s.whatsapp.net', chatId: '919303030303@s.whatsapp.net', status: 'timeout' });
  await abandoned;
  check('no decline sent when the caller hangs up first', rejected.length === 0);
  check('a caller who gave up still gets the voicemail prompt', newSince(n).length === 1);

  rejected.length = 0;
  n = since();
  const stillRinging = bot.handleCall(offer('RING4', '919404040404@s.whatsapp.net'));
  await wait(200);
  // WhatsApp emits this while the call is still live - it must not end the ring
  await bot.handleCall({ id: 'RING4', from: '919404040404@s.whatsapp.net', chatId: '919404040404@s.whatsapp.net', status: 'ringing' });
  await stillRinging;
  check('a "ringing" event does not cut the ring short', rejected.length === 1, JSON.stringify(rejected));

  console.log('\ncompany / spam filtering');
  cfg.calls.ringSeconds = 0;
  const bizMsg = (from, text, name, verified) => {
    const m = textMsg(from, text);
    m.pushName = name;
    if (verified) m.verifiedBizName = verified;
    return m;
  };

  n = since();
  await bot.handleMessage(bizMsg('918000000001@s.whatsapp.net', 'Your OTP is 449102, do not share it with anyone', 'HDFC Bank', 'HDFC Bank'));
  check('verified business account gets no reply', newSince(n).length === 0);

  n = since();
  await bot.handleMessage(bizMsg('918000000002@s.whatsapp.net', 'Hello, recharge your plan today', 'Jio'));
  check('company sender name gets no reply', newSince(n).length === 0);

  n = since();
  await bot.handleMessage(bizMsg('918000000003@s.whatsapp.net', 'Hi! Your A/C XX4412 has been debited by Rs. 2,300', 'Alerts'));
  check('transactional text gets no reply', newSince(n).length === 0);

  n = since();
  await bot.handleMessage(bizMsg('918000000004@s.whatsapp.net', 'hello, 50% off limited time, click here', 'Myntra'));
  check('promo blast gets no reply', newSince(n).length === 0);

  n = since();
  await bot.handleMessage(bizMsg('918000000005@s.whatsapp.net', 'hey are you free tonight', 'Bankim Sharma'));
  check('real person whose name contains "bank" still gets a reply', newSince(n).length === 1, JSON.stringify(newSince(n)));

  n = since();
  await bot.handleMessage(bizMsg('918000000006@s.whatsapp.net', 'hi, can we talk about the price', 'Priya'));
  check('ordinary message still gets a reply', newSince(n).length === 1);

  n = since();
  store.contact('918000000007@s.whatsapp.net').name = 'Airtel';
  await bot.handleCall(offer('SPAMCALL', '918000000007@s.whatsapp.net'));
  check('spam caller is still declined', rejected.length > 0);
  check('spam caller gets no voicemail prompt', newSince(n).length === 0);

  console.log('\nwho gets a call prompt at all');
  cfg.calls.ringSeconds = 0;
  const callFrom = (id, jid) => bot.handleCall({ id, from: jid, chatId: jid, status: 'offer', isVideo: false, isGroup: false });

  n = since();
  cfg.autoReply.blocklist = ['+91 93333 33333'];
  await callFrom('BLK1', '919333333333@s.whatsapp.net');
  check('blocklisted caller gets no voicemail prompt', newSince(n).length === 0);

  n = since();
  store.state.paused = true;
  await callFrom('PAUSE1', '919505050505@s.whatsapp.net');
  check('paused bot sends no voicemail prompt', newSince(n).length === 0);
  store.state.paused = false;

  n = since();
  cfg.autoReply.allowlist = ['+91 96060 60606'];
  await callFrom('ALLOW1', '919707070707@s.whatsapp.net');
  check('caller off the allowlist gets no prompt', newSince(n).length === 0);
  n = since();
  await callFrom('ALLOW2', '919606060606@s.whatsapp.net');
  check('allowlisted caller still gets the prompt', newSince(n).length === 1, JSON.stringify(newSince(n)));
  cfg.autoReply.allowlist = [];

  console.log('\nmissed phone calls (Termux call log)');
  const { findNewMissedCalls, toInternational } = require('../src/missed-calls');
  const stamp = (msAgo) => {
    const d = new Date(Date.now() - msAgo);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  check('local number gets the country code', toInternational('01234567890', '91') === '911234567890');
  check('already-international number is left alone', toInternational('+91 12345 67890', '91') === '911234567890');

  const callLog = async () => [
    { name: 'Priya', phone_number: '+91 90000 11111', type: 'MISSED', date: stamp(60000) },
    { name: 'Rahul', phone_number: '09000022222', type: 'INCOMING', date: stamp(50000) },
    { name: 'Spam', phone_number: '9000033333', type: 'REJECTED', date: stamp(40000) },
    { name: '', phone_number: '+91 90000 44444', type: 'OUTGOING', date: stamp(30000) },
    { name: 'Old', phone_number: '9000055555', type: 'MISSED', date: stamp(3 * 60 * 60 * 1000) },
  ];

  let missed = await findNewMissedCalls(cfg, 0, callLog);
  check('picks up missed calls', missed.some((c) => c.number === '919000011111'), JSON.stringify(missed));
  check('ignores answered incoming calls', !missed.some((c) => c.number === '919000022222'));
  check('ignores calls you made', !missed.some((c) => c.number === '919000044444'));
  check('rejected calls count as missed', missed.some((c) => c.number === '919000033333'));
  check('old calls outside the lookback are ignored', !missed.some((c) => c.number === '919000055555'), JSON.stringify(missed));
  check('caller name carried through', missed.find((c) => c.number === '919000011111')?.name === 'Priya');

  cfg.missedCalls.includeRejected = false;
  missed = await findNewMissedCalls(cfg, 0, callLog);
  check('rejected calls can be turned off', !missed.some((c) => c.number === '919000033333'));
  cfg.missedCalls.includeRejected = true;

  missed = await findNewMissedCalls(cfg, Date.now() - 45000, callLog);
  check('already-seen calls are not repeated', !missed.some((c) => c.number === '919000011111'), JSON.stringify(missed));

  console.log('\nmissed call: WhatsApp + SMS');
  const smsModule = require('../src/sms');
  const smsSent = [];
  smsModule.trySend = async (number, text) => {
    smsSent.push({ number, text });
    return true;
  };
  // Pretend everyone except 919000099999 is reachable on WhatsApp.
  sock.onWhatsApp = async (jid) => (jid.startsWith('919000099999') ? [] : [{ exists: true, jid }]);
  cfg.calls.cooldownMinutes = 0;

  cfg.missedCalls.notify = 'both';
  n = since();
  smsSent.length = 0;
  await bot.handleMissedPhoneCall({ number: '919000012345', name: 'Anil' });
  check('"both" sends the WhatsApp prompt', newSince(n).length >= 1, JSON.stringify(newSince(n)));
  check('"both" also sends an SMS', smsSent.length === 1, JSON.stringify(smsSent));
  check('SMS goes to the plain number, not a jid', smsSent[0]?.number === '919000012345');
  check('SMS is personalised', /\bAnil\b/.test(smsSent[0]?.text || ''), smsSent[0]?.text);

  cfg.missedCalls.notify = 'sms';
  n = since();
  smsSent.length = 0;
  await bot.handleMissedPhoneCall({ number: '919000023456', name: 'Bela' });
  check('"sms" sends no WhatsApp message', newSince(n).length === 0);
  check('"sms" sends the SMS', smsSent.length === 1);

  cfg.missedCalls.notify = 'auto';
  n = since();
  smsSent.length = 0;
  await bot.handleMissedPhoneCall({ number: '919000034567', name: 'Chandu' });
  check('"auto" uses WhatsApp when they have it', newSince(n).length === 1 && smsSent.length === 0, JSON.stringify(smsSent));

  n = since();
  smsSent.length = 0;
  await bot.handleMissedPhoneCall({ number: '919000099999', name: 'Dev' });
  check('"auto" falls back to SMS when they do not', newSince(n).length === 0 && smsSent.length === 1, JSON.stringify(smsSent));

  n = since();
  smsSent.length = 0;
  cfg.autoReply.blocklist = ['919000045678'];
  await bot.handleMissedPhoneCall({ number: '919000045678', name: 'Spammer' });
  check('blocklist stops the SMS too, not just WhatsApp', smsSent.length === 0 && newSince(n).length === 0);
  cfg.autoReply.blocklist = [];

  n = since();
  smsSent.length = 0;
  store.state.paused = true;
  await bot.handleMissedPhoneCall({ number: '919000056789', name: 'Eshan' });
  check('paused bot sends neither channel', smsSent.length === 0 && newSince(n).length === 0);
  store.state.paused = false;
  cfg.missedCalls.notify = 'both';

  console.log('\nvoicemail routing');
  n = since();
  await bot.handleMessage(audioMsg(OTHER));
  check('post-call voice note is not answered with a text auto-reply', newSince(n).length === 0);

  console.log('\nvoicemail storage');
  cfg.voicemail.transcribeCommand = 'echo transcript-of {file}';
  const entry = await saveVoicemail(sock, audioMsg(OTHER), {
    cfg,
    jid: OTHER,
    pushName: 'Sam Rivera',
    reason: 'after-call',
    download: async () => Buffer.from('fake opus audio bytes'),
  });
  const abs = path.join(cfg.paths.root, entry.file);
  check('audio file written', fs.existsSync(abs), abs);
  check('filename carries date and number', /\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_919222222222\.ogg$/.test(entry.file), entry.file);
  check('metadata captured', entry.seconds === 9 && entry.number === '919222222222' && entry.isVoiceNote === true);
  check('sidecar json written', fs.existsSync(abs.replace(/\.ogg$/, '.json')));
  const index = JSON.parse(fs.readFileSync(path.join(cfg.paths.voicemails, 'index.json'), 'utf8'));
  check('appended to index.json', index.length === 1 && index[0].id === entry.id);
  check('transcription hook ran', /transcript-of/.test(entry.transcript), entry.transcript);

  fs.rmSync(cfg.paths.voicemails, { recursive: true, force: true });
  fs.rmSync(path.join(cfg.paths.root, 'data', 'state.json'), { force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
