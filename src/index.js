'use strict';

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const baileys = require('baileys');

const makeWASocket = baileys.default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  isJidGroup,
  isJidBroadcast,
  isJidNewsletter,
  DisconnectReason,
  Browsers,
} = baileys;

const { loadConfig } = require('./config');
const { log, makeQuietLogger } = require('./logger');
const store = require('./store');
const { isWithinBusinessHours } = require('./schedule');
const {
  extractText,
  messageKind,
  audioPart,
  fillTemplate,
  templateVars,
  pickRuleReply,
  listMatches,
  spamReason,
  isTextMessage,
  sensitiveReason,
} = require('./replier');
const { saveVoicemail, confirmationText, recent } = require('./voicemail');
const missedCalls = require('./missed-calls');
const sms = require('./sms');
const ai = require('./ai');

// Call statuses that mean the call is over. 'ringing' is not one of them.
const CALL_ENDED = new Set(['accept', 'reject', 'timeout', 'terminate']);

// Message types that should never trigger a reply.
const SKIP_KINDS = new Set([
  'protocolMessage',
  'reactionMessage',
  'senderKeyDistributionMessage',
  'pollUpdateMessage',
  'pollCreationMessage',
  'editedMessage',
  'unknown',
]);

let cfg;
let sock;
let ownJid = '';
let baileysLogger;
let reconnectDelay = 1000;
let reconnecting = false;
const startedAt = Date.now();
const seenCalls = new Map();
const ringingCalls = new Map();
const pendingReplies = new Map();
let stopMissedCallWatcher = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomBetween([lo, hi]) {
  return Math.floor(lo + Math.random() * Math.max(0, hi - lo));
}

// WhatsApp re-sends call nodes; only act on each call once.
function alreadyHandled(key) {
  const now = Date.now();
  for (const [id, ts] of seenCalls) if (now - ts > 5 * 60 * 1000) seenCalls.delete(id);
  if (seenCalls.has(key)) return true;
  seenCalls.set(key, now);
  return false;
}

// Lets a call ring for a while before we cut it. Resolves with null when the
// full time elapsed, or with the status that ended the call early (the caller
// hung up, or you picked up on your phone).
function waitThroughRing(callId, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ringingCalls.delete(callId);
      resolve(null);
    }, ms);
    ringingCalls.set(callId, (status) => {
      clearTimeout(timer);
      ringingCalls.delete(callId);
      resolve(status);
    });
  });
}

async function sendText(jid, text, { typing = true } = {}) {
  try {
    if (typing) {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      await sleep(randomBetween(cfg.autoReply.typingDelayMs));
      await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    log.error(`could not send to ${jid.split('@')[0]}: ${err.message}`);
    return false;
  }
}

async function sendGreetingAudio(jid) {
  const file = cfg.paths.greetingAudio;
  if (!file) return;
  const ext = path.extname(file).toLowerCase();
  const isOpus = ext === '.ogg' || ext === '.opus';
  const mimetype = isOpus ? 'audio/ogg; codecs=opus' : ext === '.mp3' ? 'audio/mpeg' : 'audio/mp4';
  try {
    await sock.sendMessage(jid, { audio: fs.readFileSync(file), mimetype, ptt: isOpus });
  } catch (err) {
    log.warn(`greeting audio failed: ${err.message}`);
  }
}

function contactLabel(jid, name) {
  const number = String(jid).split('@')[0];
  return name ? `${name} (${number})` : number;
}

// ---------------------------------------------------------------- owner commands

function statusReport() {
  const uptimeMin = Math.round((Date.now() - startedAt) / 60000);
  const { stats, paused } = store.state;
  return [
    'Auto-reply bot status',
    `- state: ${paused ? 'PAUSED' : 'active'}`,
    `- reply mode: ${cfg.autoReply.replyMode}`,
    `- calls: ${cfg.calls.enabled ? cfg.calls.action : 'off'} | voicemail: ${cfg.voicemail.enabled ? 'on' : 'off'}`,
    `- since start: ${stats.replies} replies, ${stats.calls} calls, ${stats.voicemails} voicemails`,
    `- waiting on you: ${awaitingYou().length}`,
    `- reply hold: ${cfg.autoReply.replyDelayMinutes} min, then 1 per ${cfg.autoReply.cooldownMinutes} min`,
    `- known contacts: ${Object.keys(store.state.contacts).length}`,
    `- uptime: ${uptimeMin} min`,
  ].join('\n');
}

function voicemailReport(limit) {
  const items = recent(cfg, limit);
  if (items.length === 0) return 'No voicemails recorded yet.';
  const lines = items.map((v, i) => {
    const when = new Date(v.receivedAt).toLocaleString();
    const who = v.name ? `${v.name} (${v.number})` : v.number;
    const tail = v.transcript ? `\n   "${v.transcript.slice(0, 160)}"` : '';
    return `${i + 1}. ${who} - ${v.seconds}s - ${when}\n   ${v.file}${tail}`;
  });
  return [`Last ${items.length} voicemail(s):`].concat(lines).join('\n');
}

// Chats the bot answered on your behalf that you haven't personally replied to.
function awaitingYou() {
  return Object.entries(store.state.contacts)
    .filter(([, c]) => (c.botRepliedAt || 0) > (c.ownerRepliedAt || 0))
    .sort((a, b) => (b[1].botRepliedAt || 0) - (a[1].botRepliedAt || 0));
}

function pendingReport(limit) {
  const waiting = awaitingYou().slice(0, limit);
  if (waiting.length === 0) return 'Nobody is waiting on you. All caught up.';

  const lines = waiting.map(([jid, c], i) => {
    const who = c.name ? `${c.name} (+${jid.split('@')[0]})` : `+${jid.split('@')[0]}`;
    const mins = Math.round((Date.now() - c.botRepliedAt) / 60000);
    const ago = mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
    const said = c.lastIncomingText ? `\n   "${String(c.lastIncomingText).slice(0, 120)}"` : '';
    return `${i + 1}. ${who} - ${ago}${said}`;
  });
  return [`${waiting.length} chat(s) still waiting on you:`].concat(lines).join('\n');
}

async function handleOwnerCommand(text, chatJid = '') {
  const prefix = cfg.owner.commandPrefix;
  if (!cfg.owner.enableCommands || !text.startsWith(prefix)) return false;

  const [rawCmd, ...rest] = text.slice(prefix.length).trim().split(/\s+/);
  const cmd = (rawCmd || '').toLowerCase();
  const arg = rest.join(' ');
  const reply = (body) => sendText(ownJid, body, { typing: false });

  switch (cmd) {
    case 'pause':
      store.state.paused = true;
      store.flushNow();
      log.warn('auto-reply PAUSED by owner command');
      await reply(`Auto-reply paused. Send ${prefix}resume to switch it back on.`);
      return true;
    case 'resume':
      store.state.paused = false;
      store.flushNow();
      log.ok('auto-reply RESUMED by owner command');
      await reply('Auto-reply is active again.');
      return true;
    case 'status':
      await reply(statusReport());
      return true;
    case 'vm':
    case 'voicemails':
      await reply(voicemailReport(Math.min(Number(arg) || 5, 20)));
      return true;
    case 'ai': {
      if (!cfg.aiChat.enabled) {
        await reply('AI chat is switched off. Set aiChat.enabled to true in config.json and restart.');
        return true;
      }
      if (arg.toLowerCase() === 'list') {
        const on = Object.entries(store.state.contacts).filter(([, c]) => c.aiChat);
        const lines = on.map(([j, c]) => `- ${contactLabel(j, c.name)} (${c.aiTurns || 0} turns)`);
        await reply(
          on.length === 0
            ? 'AI chat is not on for any chat yet.'
            : ['AI is chatting in:'].concat(lines).join('\n'),
        );
        return true;
      }
      if (!chatJid || chatJid === ownJid) {
        await reply(`Send ${prefix}ai inside the chat you want the AI to handle, or ${prefix}ai list to see which ones it's on for.`);
        return true;
      }
      const c = store.contact(chatJid);
      const word = arg.toLowerCase();
      c.aiChat = word === 'on' ? true : word === 'off' ? false : !c.aiChat;
      c.aiTurns = 0;
      c.aiHandedOff = false;
      store.flushNow();
      log.warn(`AI chat ${c.aiChat ? 'ENABLED' : 'disabled'} for ${contactLabel(chatJid, c.name)}`);
      await reply(`AI chat is now ${c.aiChat ? 'ON' : 'OFF'} for ${contactLabel(chatJid, c.name)}.`);
      return true;
    }
    case 'pending':
    case 'todo':
      await reply(pendingReport(Math.min(Number(arg) || 10, 30)));
      return true;
    case 'done':
      for (const [, c] of awaitingYou()) c.ownerRepliedAt = Date.now();
      store.flushNow();
      await reply('Cleared the waiting list.');
      return true;
    case 'help':
      await reply(
        [
          'Commands (send these from your own WhatsApp, ideally in your "Message yourself" chat):',
          `${prefix}pause   - stop auto-replying`,
          `${prefix}resume  - start auto-replying again`,
          `${prefix}status  - show what the bot is doing`,
          `${prefix}vm [n]  - list the last n voicemails`,
          `${prefix}ai      - in a chat: let the AI converse there. ${prefix}ai list shows which`,
          `${prefix}pending - who is still waiting on a reply from you`,
          `${prefix}done    - clear that waiting list`,
          `${prefix}help    - this list`,
        ].join('\n'),
      );
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------- messages

function replyBlockedBecause(jid, isGroup, contact, message = {}) {
  const ar = cfg.autoReply;
  if (!ar.enabled) return 'auto-reply disabled in config';
  if (store.state.paused) return 'bot is paused';
  if (isGroup && !ar.replyToGroups) return 'group chat';
  if (listMatches(ar.blocklist, jid)) return 'blocklisted';
  const spam = spamReason(cfg.spamFilter, message);
  if (spam) return `looks like a company/spam message - ${spam}`;
  if (ar.allowlist.length > 0 && !listMatches(ar.allowlist, jid)) return 'not on allowlist';
  if (ar.replyOnlyOutsideBusinessHours && isWithinBusinessHours(ar.businessHours)) {
    return 'inside business hours';
  }
  if ((contact.suppressReplyUntil || 0) > Date.now()) return 'call notice just sent';
  // Both limits are off when set to 0.
  const sinceReply = Date.now() - (contact.lastReplyAt || 0);
  if (ar.cooldownMinutes > 0 && contact.lastReplyAt && sinceReply < ar.cooldownMinutes * 60000) {
    const leftMin = Math.ceil((ar.cooldownMinutes * 60000 - sinceReply) / 60000);
    return `cooldown (${leftMin} min left)`;
  }
  if (ar.maxRepliesPerContactPerDay > 0 && store.repliesToday(jid) >= ar.maxRepliesPerContactPerDay) {
    return 'daily reply cap reached';
  }
  return null;
}

/**
 * Which messages.upsert events are worth acting on.
 *
 * Incoming messages arrive as 'notify'. Messages *you* send from your own phone
 * reach a linked device as 'append' — those carry the ! commands and tell us
 * you've answered a chat yourself, so they must get through. Everything else
 * that isn't 'notify' is history syncing, and replying to that would mean
 * answering conversations from days ago.
 */
function shouldHandleUpsert(msg, type, now = Date.now()) {
  if (type === 'notify') return true;
  if (!msg.key?.fromMe) return false;

  // Reconnects re-sync your sent messages; only recent ones are live actions.
  const sentAt = Number(msg.messageTimestamp || 0);
  if (sentAt && now / 1000 - sentAt > 300) return false;
  return true;
}

// A short note in your own chat when something arrived that the AI deliberately
// didn't answer — so it doesn't just sit there unnoticed.
async function nudgeOwner(jid, contact, what, said) {
  if (!cfg.autoReply.notifyOwner || !ownJid) return;
  const who = contact.name ? `${contact.name} (+${jid.split('@')[0]})` : `+${jid.split('@')[0]}`;
  const lines = [`${who} ${what}.`];
  if (said) lines.push(`"${String(said).slice(0, 200)}"`);
  lines.push('', 'I left that one for you.');
  await sendText(ownJid, lines.join('\n'), { typing: false });
}

/**
 * Things the AI shouldn't try to converse about: attachments it can never see,
 * and codes or credentials it has no business improvising around.
 * Returns true when it has dealt with the message itself.
 */
async function handledWithoutAi(jid, contact, kind, text) {
  if (!isTextMessage(kind)) {
    const mode = cfg.aiChat.onAttachment;
    if (mode === 'ai') return false;

    const label = kind.replace(/Message$/, '') || 'attachment';
    log.info(`${label} from ${contactLabel(jid, contact.name)} - AI ${mode === 'ignore' ? 'staying quiet' : 'acknowledging only'}`);

    if (mode === 'acknowledge' && cfg.aiChat.attachmentReply) {
      const body = fillTemplate(cfg.aiChat.attachmentReply, templateVars(contact.name, jid));
      if (await sendText(jid, body)) {
        contact.botRepliedAt = Date.now();
        store.noteReply(jid);
      }
    }
    await nudgeOwner(jid, contact, `sent you a ${label}`, text);
    return true;
  }

  const sensitive = sensitiveReason(cfg.aiChat, text);
  if (sensitive) {
    log.warn(`not letting the AI answer ${contactLabel(jid, contact.name)} - ${sensitive}`);
    await nudgeOwner(jid, contact, 'sent something I left alone', text);
    return true;
  }
  return false;
}

function filterInputFor(msg, text, pushName) {
  return { text, pushName: pushName || '', verifiedBizName: msg?.verifiedBizName };
}

// With allChats on, the AI talks to everyone who writes in — so the same guards
// that protect the away-message path have to apply here too. A telemarketer
// should not get a conversation.
function aiChatBlockedBecause(jid, contact, message) {
  if (listMatches(cfg.autoReply.blocklist, jid)) return 'blocklisted';
  if (cfg.autoReply.allowlist.length > 0 && !listMatches(cfg.autoReply.allowlist, jid)) {
    return 'not on allowlist';
  }
  const spam = spamReason(cfg.spamFilter, { ...message, pushName: message.pushName || contact.name });
  if (spam) return `looks like a company/spam message - ${spam}`;
  return null;
}

// ---------------------------------------------------------------- deferred replies

function cancelPendingReply(jid, reason) {
  const timer = pendingReplies.get(jid);
  if (!timer) return false;
  clearTimeout(timer);
  pendingReplies.delete(jid);
  if (reason) log.ok(`held reply to ${jid.split('@')[0]} cancelled - ${reason}`);
  return true;
}

// Tells you, in your own chat, that someone is waiting on a real answer.
async function notifyOwnerOfReply(jid, contact, incoming) {
  if (!cfg.autoReply.notifyOwner || !ownJid) return;
  const who = contact.name ? `${contact.name} (+${jid.split('@')[0]})` : `+${jid.split('@')[0]}`;
  await sendText(
    ownJid,
    [`${who} messaged you:`, `"${String(incoming).slice(0, 300)}"`, '', 'I sent the auto-reply. They are still waiting on you.'].join('\n'),
    { typing: false },
  );
}

// Builds and sends the actual reply. Runs after the hold, so the gates are
// re-checked against how things stand now, not how they stood 5 minutes ago.
async function deliverAutoReply(jid, payload) {
  const contact = store.contact(jid);
  const { text, kind, pushName, isGroup } = payload;

  const blocked = replyBlockedBecause(jid, isGroup, contact, payload.filterInput);
  if (blocked) {
    log.dim(`held reply to ${contactLabel(jid, contact.name)} dropped - ${blocked}`);
    return;
  }

  const vars = templateVars(pushName || contact.name, jid);
  const { reply: ruleReply, rule } = pickRuleReply(cfg.autoReply, text);
  let body = fillTemplate(ruleReply, vars);
  let source = rule;

  if (cfg.autoReply.replyMode === 'ai') {
    const aiReply = await ai.generateReply(cfg, {
      text: text || `(sent a ${kind.replace('Message', '')} with no text)`,
      history: contact.history,
      vars,
    });
    if (aiReply) {
      body = aiReply;
      source = 'ai';
    }
  }

  if (cfg.autoReply.markAsRead && payload.key) {
    await sock.readMessages([payload.key]).catch(() => {});
  }
  if (!(await sendText(jid, body))) return;

  store.noteReply(jid);
  contact.botRepliedAt = Date.now();
  store.pushHistory(jid, 'user', text || `<${kind}>`, cfg.ai.historyTurns);
  store.pushHistory(jid, 'assistant', body, cfg.ai.historyTurns);
  log.ok(`replied [${source}] -> ${body.slice(0, 90)}`);

  await notifyOwnerOfReply(jid, contact, text || `<${kind}>`);
}

// The conversational stand-in. Unlike the away-message path this has no
// cooldown — it's a conversation — but it stops itself after maxTurns and
// hands back to you rather than talking to someone indefinitely.
async function deliverChatReply(jid, payload) {
  const contact = store.contact(jid);

  if (store.state.paused) {
    log.dim(`held AI reply to ${contactLabel(jid, contact.name)} dropped - bot is paused`);
    return;
  }
  if (listMatches(cfg.autoReply.blocklist, jid)) return;

  if ((contact.aiTurns || 0) >= cfg.aiChat.maxTurns) {
    if (!contact.aiHandedOff) {
      contact.aiHandedOff = true;
      store.save();
      const note = fillTemplate(cfg.aiChat.handoffNote, templateVars(contact.name, jid));
      log.warn(`AI chat with ${contactLabel(jid, contact.name)} hit ${cfg.aiChat.maxTurns} turns - handing back to you`);
      if (ownJid) await sendText(ownJid, note, { typing: false });
    }
    return;
  }

  const vars = templateVars(payload.pushName || contact.name, jid);
  const body = await ai.generateReply(cfg, {
    text: payload.text,
    history: contact.history,
    vars,
    mode: 'chat',
  });

  if (!body) {
    log.warn(`AI chat reply unavailable for ${contactLabel(jid, contact.name)} - staying quiet`);
    return;
  }
  if (!(await sendText(jid, body))) return;

  contact.aiTurns = (contact.aiTurns || 0) + 1;
  contact.botRepliedAt = Date.now();
  store.noteReply(jid);
  store.pushHistory(jid, 'user', payload.text || `<${payload.kind}>`, cfg.aiChat.historyTurns);
  store.pushHistory(jid, 'assistant', body, cfg.aiChat.historyTurns);
  log.ok(`AI chat [${contact.aiTurns}/${cfg.aiChat.maxTurns}] -> ${body.slice(0, 90)}`);
}

function scheduleChatReply(jid, payload) {
  cancelPendingReply(jid);
  const [lo, hi] = cfg.aiChat.holdSeconds;
  const waitMs = randomBetween([lo * 1000, hi * 1000]);

  const timer = setTimeout(() => {
    pendingReplies.delete(jid);
    deliverChatReply(jid, payload).catch((err) => log.error(`AI chat failed: ${err.message}`));
  }, waitMs);
  if (timer.unref) timer.unref();
  pendingReplies.set(jid, timer);
  log.dim(`AI chat replying in ${Math.round(waitMs / 1000)}s - type yourself to take over`);
  return Promise.resolve();
}

function scheduleAutoReply(jid, payload) {
  const minutes = cfg.autoReply.replyDelayMinutes;
  if (!minutes) return deliverAutoReply(jid, payload);

  cancelPendingReply(jid);
  const timer = setTimeout(() => {
    pendingReplies.delete(jid);
    deliverAutoReply(jid, payload).catch((err) => log.error(`held reply failed: ${err.message}`));
  }, minutes * 60000);
  if (timer.unref) timer.unref();
  pendingReplies.set(jid, timer);

  log.dim(`holding a reply for ${minutes} min - it won't send if you answer first`);
  return Promise.resolve();
}

async function handleMessage(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid) return;
  if (jid === 'status@broadcast' || isJidBroadcast(jid) || isJidNewsletter(jid)) return;

  // A message with no readable content usually means WhatsApp could not decrypt
  // it. Say so rather than dropping it silently — otherwise a voice note that
  // never arrives looks like the bot ignoring you.
  if (!msg.message) {
    if (!msg.key.fromMe) {
      const stub = msg.messageStubType ? ` (stub type ${msg.messageStubType})` : '';
      log.warn(`unreadable message from ${jid.split('@')[0]}${stub} - nothing to act on`);
    }
    return;
  }

  const text = extractText(msg);

  if (msg.key.fromMe) {
    // You just answered this chat yourself: drop any queued reply and mark the
    // conversation as handled, so it stops showing up as needing you.
    if (jid !== ownJid) {
      const own = store.contact(jid);
      own.ownerRepliedAt = Date.now();
      own.aiTurns = 0;
      own.aiHandedOff = false;
      cancelPendingReply(jid, 'you replied yourself');
      store.save();
    }
    if (text) await handleOwnerCommand(text.trim(), jid);
    return;
  }

  const isGroup = isJidGroup(jid);
  const pushName = msg.pushName || '';
  const contact = store.contact(jid);
  contact.lastSeenAt = Date.now();
  if (pushName) contact.name = pushName;

  const vars = templateVars(pushName || contact.name, jid);
  const kind = messageKind(msg);
  const audio = audioPart(msg);
  const awaitingVoicemail = (contact.awaitingVoicemailUntil || 0) > Date.now();

  // 1. A voice note answering a missed call gets stored as a voicemail.
  const wantsVoicemail = awaitingVoicemail || cfg.voicemail.captureAllVoiceNotes;
  if (cfg.voicemail.enabled && audio && !isGroup && wantsVoicemail) {
    try {
      const entry = await saveVoicemail(sock, msg, {
        cfg,
        jid,
        pushName: pushName || contact.name,
        reason: awaitingVoicemail ? 'after-call' : 'voice-note',
        baileysLogger,
      });
      if (entry) {
        contact.awaitingVoicemailUntil = 0;
        store.state.stats.voicemails += 1;
        store.save();
        const heard = entry.transcript ? `\n    "${entry.transcript.slice(0, 200)}"` : '';
        log.ok(`VOICEMAIL from ${contactLabel(jid, contact.name)} - ${entry.seconds}s -> ${entry.file}${heard}`);
        if (cfg.autoReply.markAsRead) await sock.readMessages([msg.key]).catch(() => {});
        if (cfg.voicemail.confirmation) {
          await sendText(jid, confirmationText(cfg, entry, pushName || contact.name, jid));
        }
        return;
      }
    } catch (err) {
      log.error(`voicemail download failed: ${err.message}`);
    }
  }

  if (SKIP_KINDS.has(kind)) return;

  const preview = text ? text.slice(0, 90) : `<${kind}>`;
  const from = msg.verifiedBizName ? `${msg.verifiedBizName} [business]` : contactLabel(jid, contact.name);
  log.info(`message from ${from}${isGroup ? ' [group]' : ''}: ${preview}`);

  // 2. Reply.
  contact.lastIncomingText = text || `<${kind}>`;
  contact.lastIncomingAt = Date.now();

  // AI chat mode replaces the away-message path entirely: no cooldown, no daily
  // cap, just a conversation. On for every chat when allChats is set, otherwise
  // only where you've switched it on with !ai.
  const aiWanted = cfg.aiChat.enabled && !isGroup && (cfg.aiChat.allChats || contact.aiChat);
  if (aiWanted && !store.state.paused) {
    const barred = aiChatBlockedBecause(jid, contact, filterInputFor(msg, text, pushName));
    if (!barred) {
      if (await handledWithoutAi(jid, contact, kind, text)) {
        store.save();
        return;
      }
      await scheduleChatReply(jid, { text, kind, pushName });
      store.save();
      return;
    }
    log.dim(`no AI chat - ${barred}`);
  }

  const filterInput = {
    text,
    pushName: pushName || contact.name,
    verifiedBizName: msg.verifiedBizName,
  };
  const blocked = replyBlockedBecause(jid, isGroup, contact, filterInput);
  if (blocked) {
    log.dim(`no reply - ${blocked}`);
    store.save();
    return;
  }

  // If you've spoken in this chat recently you're clearly on it, so stay out
  // entirely rather than queueing something to interrupt with later.
  const sinceYouSpoke = Date.now() - (contact.ownerRepliedAt || 0);
  const quietMs = cfg.autoReply.quietAfterYouReplyMinutes * 60000;
  if (contact.ownerRepliedAt && sinceYouSpoke < quietMs) {
    log.dim(`no reply - you're in this conversation (you replied ${Math.round(sinceYouSpoke / 60000)} min ago)`);
    store.save();
    return;
  }

  await scheduleAutoReply(jid, { text, kind, pushName, isGroup, key: msg.key, filterInput });
  store.save();
}

// ---------------------------------------------------------------- calls

function callerJid(call) {
  const candidates = [call.from, call.chatId].filter(Boolean);
  const phone = candidates.find((j) => String(j).endsWith('@s.whatsapp.net'));
  const chosen = phone || candidates[0];
  return chosen ? jidNormalizedUser(chosen) : '';
}

// Who is worth answering at all. Shared by WhatsApp call prompts and by
// missed-phone-call notices, so both channels obey the same rules.
function callPromptBlockedBecause(jid, contact) {
  if (store.state.paused) return 'bot is paused';
  if (listMatches(cfg.autoReply.blocklist, jid)) return 'blocklisted';
  if (cfg.autoReply.allowlist.length > 0 && !listMatches(cfg.autoReply.allowlist, jid)) {
    return 'not on allowlist';
  }
  const spam = spamReason(cfg.spamFilter, { pushName: contact.name });
  if (spam) return spam;
  const cooldownMs = cfg.calls.cooldownMinutes * 60000;
  if (Date.now() - (contact.lastCallNoticeAt || 0) < cooldownMs) {
    return 'already messaged recently';
  }
  return null;
}

async function promptForVoicemail(jid, contact) {
  const blocked = callPromptBlockedBecause(jid, contact);
  if (blocked) {
    log.dim(`no voicemail prompt - ${blocked}`);
    return;
  }
  const vars = templateVars(contact.name || '', jid);
  const sent = await sendText(jid, fillTemplate(cfg.calls.message, vars));
  if (!sent) return;
  await sendGreetingAudio(jid);

  contact.lastCallNoticeAt = Date.now();
  contact.suppressReplyUntil = Date.now() + 60000;
  if (cfg.voicemail.enabled) {
    contact.awaitingVoicemailUntil = Date.now() + cfg.voicemail.windowMinutes * 60000;
  }
  store.save();
  log.ok(
    `voicemail prompt sent to ${contactLabel(jid, contact.name)} - listening ${cfg.voicemail.windowMinutes} min for a voice note`,
  );
}

// ---------------------------------------------------------------- missed phone calls

// A missed call on the phone itself gets the same treatment as a declined
// WhatsApp call: the caller is asked to leave a message. Depending on
// missedCalls.notify that goes out over WhatsApp, SMS, or both — SMS being the
// one that reaches people who don't use WhatsApp at all.
async function handleMissedPhoneCall({ number, name }) {
  const mode = cfg.missedCalls.notify;
  const jid = `${number}@s.whatsapp.net`;
  let target = jid;
  let onWhatsApp = false;

  if (mode !== 'sms') {
    try {
      const [found] = await sock.onWhatsApp(jid);
      onWhatsApp = !!found?.exists;
      if (found?.jid) target = found.jid;
    } catch (err) {
      log.warn(`could not check ${number} on WhatsApp: ${err.message}`);
    }
  }

  const contact = store.contact(target);
  if (name && !contact.name) contact.name = name;

  // One gate for both channels, checked before either is sent.
  const blocked = callPromptBlockedBecause(target, contact);
  if (blocked) {
    log.dim(`missed call from ${name || number} - no message sent: ${blocked}`);
    return;
  }

  contact.lastCallAt = Date.now();
  store.state.stats.calls += 1;
  log.warn(`MISSED PHONE CALL from ${contactLabel(target, contact.name)}`);

  const wantsWhatsApp = onWhatsApp && (mode === 'both' || mode === 'whatsapp' || mode === 'auto');
  const wantsSms = mode === 'both' || mode === 'sms' || (mode === 'auto' && !onWhatsApp);

  if (wantsWhatsApp) {
    await promptForVoicemail(target, contact);
  } else if (mode !== 'sms' && !onWhatsApp) {
    log.dim('that number is not on WhatsApp');
  }

  if (wantsSms) {
    const vars = templateVars(contact.name || '', target);
    const body = fillTemplate(cfg.missedCalls.smsMessage, vars);
    const sent = await sms.trySend(number, body, { simSlot: cfg.missedCalls.simSlot });
    if (sent) {
      log.ok(`SMS sent to ${contactLabel(target, contact.name)}`);
      contact.lastCallNoticeAt = Date.now();
    }
  }

  store.save();
}

async function startMissedCallWatcher() {
  if (stopMissedCallWatcher) return; // already running; survives reconnects
  const mode = cfg.missedCalls.enabled;
  if (mode === false) return;

  const available = await missedCalls.isAvailable();
  if (!available) {
    if (mode === true) {
      log.warn('missedCalls is enabled but termux-call-log is not available here.');
      log.dim('It needs Termux + the Termux:API app, "pkg install termux-api", and call log permission.');
    }
    return;
  }

  stopMissedCallWatcher = missedCalls.start({
    cfg,
    since: Date.now(), // never message people already sitting in the call log
    onMissedCall: handleMissedPhoneCall,
  });
  log.ok(`watching the phone's call log - missed calls now get a voicemail prompt`);
}

async function handleCall(call) {
  if (!cfg.calls.enabled) return;
  const jid = callerJid(call);
  if (!jid) return;

  const contact = store.contact(jid);
  const kindLabel = call.isVideo ? 'video call' : 'voice call';

  // Only a status that actually ends the call stops a ring timer that is still
  // counting down. WhatsApp also emits 'ringing' while the call is still live —
  // treating that as an ending would cut the ring short.
  if (CALL_ENDED.has(call.status)) {
    const endRing = ringingCalls.get(call.id);
    if (endRing) endRing(call.status);
  }

  if (call.status === 'offer') {
    if (alreadyHandled(call.id)) return;
    if (call.isGroup && !cfg.calls.handleGroupCalls) {
      log.dim(`ignoring group call from ${contactLabel(jid, contact.name)}`);
      return;
    }
    if (call.isVideo && !cfg.calls.handleVideoCalls) {
      log.dim(`ignoring video call from ${contactLabel(jid, contact.name)}`);
      return;
    }

    store.state.stats.calls += 1;
    contact.lastCallAt = Date.now();
    store.save();
    log.warn(`INCOMING ${kindLabel} from ${contactLabel(jid, contact.name)}`);

    if (cfg.calls.action === 'reject') {
      const ringSeconds = Math.max(0, cfg.calls.ringSeconds);
      let endedEarly = null;

      if (ringSeconds > 0) {
        log.dim(`ringing for ${ringSeconds}s - pick up now if you want it`);
        endedEarly = await waitThroughRing(call.id, ringSeconds * 1000);
      }

      if (endedEarly === 'accept') {
        log.info('you answered on your phone - leaving this one alone');
        return;
      }

      if (endedEarly) {
        log.info(`caller gave up after ${ringSeconds}s or less (${endedEarly})`);
      } else {
        try {
          await sock.rejectCall(call.id, call.from);
          log.info(`call declined after ringing ${ringSeconds}s`);
        } catch (err) {
          log.warn(`could not decline the call: ${err.message}`);
        }
      }
      await promptForVoicemail(jid, contact);
    } else {
      log.dim('letting it ring - the voicemail prompt goes out if you miss it');
    }
    return;
  }

  if (call.status === 'timeout' && cfg.calls.action === 'ignore') {
    if (alreadyHandled(`missed:${call.id}`)) return;
    log.warn(`missed ${kindLabel} from ${contactLabel(jid, contact.name)}`);
    await promptForVoicemail(jid, contact);
    return;
  }

  if (call.status === 'accept') {
    contact.awaitingVoicemailUntil = 0;
    store.save();
    log.info(`call from ${contactLabel(jid, contact.name)} was answered on your phone`);
  }
}

// ---------------------------------------------------------------- connection

function printStartupSummary() {
  const ar = cfg.autoReply;
  const modeDetail =
    ar.replyMode === 'ai'
      ? `${cfg.ai.model}, effort ${cfg.ai.effort}`
      : `${ar.rules.length} keyword rules`;
  const hours = ar.replyOnlyOutsideBusinessHours
    ? `reply only outside ${ar.businessHours.start}-${ar.businessHours.end}`
    : 'always reply';
  log.dim(`reply mode     : ${ar.replyMode} (${modeDetail})`);
  log.dim(`groups         : ${ar.replyToGroups ? 'replying' : 'ignored'}`);
  const limits = [
    ar.cooldownMinutes > 0 ? `1 reply per ${ar.cooldownMinutes} min` : 'no cooldown',
    ar.maxRepliesPerContactPerDay > 0 ? `max ${ar.maxRepliesPerContactPerDay}/day` : 'no daily cap',
  ];
  log.dim(`rate limit     : ${limits.join(', ')}`);
  log.dim(`business hours : ${hours}`);
  const callLine = !cfg.calls.enabled
    ? 'not handled'
    : cfg.calls.action === 'reject'
      ? `ring ${cfg.calls.ringSeconds}s, then decline and prompt`
      : 'let it ring, prompt only if missed';
  log.dim(`calls          : ${callLine}`);
  log.dim(`voicemail      : ${cfg.voicemail.enabled ? `${cfg.voicemail.windowMinutes} min window -> ${cfg.voicemail.saveDir}` : 'off'}`);
  const aiLine = !cfg.aiChat.enabled
    ? 'off'
    : `${cfg.aiChat.backend} backend, ${cfg.aiChat.allChats ? 'ALL chats' : 'only chats you enable with !ai'}`;
  log.dim(`ai chat        : ${aiLine}`);
  if (store.state.paused) log.warn('bot is currently PAUSED - send !resume from your phone');
}

function scheduleReconnect(reason) {
  if (reconnecting) return;
  reconnecting = true;
  const wait = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  log.warn(`connection closed (${reason}) - reconnecting in ${Math.round(wait / 1000)}s`);
  setTimeout(() => {
    reconnecting = false;
    connect().catch((err) => {
      log.error(`reconnect failed: ${err.message}`);
      scheduleReconnect('retry');
    });
  }, wait);
}

// When the bot runs on the same phone as WhatsApp you cannot scan your own
// screen, so link with an 8-character pairing code instead:
//   node src/index.js --pair 911234567890
function pairingNumber() {
  const flag = process.argv.indexOf('--pair');
  const raw = flag !== -1 ? process.argv[flag + 1] : process.env.PAIR_NUMBER;
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits : '';
}

function isRegistered() {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(cfg.paths.auth, 'creds.json'), 'utf8'));
    return !!creds.registered;
  } catch {
    return false;
  }
}

function onConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr && !pairingNumber()) {
    log.banner('Scan this QR code with WhatsApp > Settings > Linked devices > Link a device');
    qrcode.generate(qr, { small: true });
  }

  if (connection === 'open') {
    reconnectDelay = 1000;
    ownJid = jidNormalizedUser(sock.user.id);
    log.ok(`connected as ${sock.user?.name || 'this device'} (+${ownJid.split('@')[0]})`);
    printStartupSummary();
    log.info('listening for messages and calls - press Ctrl+C to stop');
    startMissedCallWatcher().catch((err) => log.warn(`missed-call watcher: ${err.message}`));
  }

  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    if (statusCode === DisconnectReason.loggedOut) {
      log.error('This device was unlinked from WhatsApp.');
      log.error('Run "npm run logout" and then "npm start" to link it again.');
      store.flushNow();
      process.exit(1);
    }
    scheduleReconnect(statusCode ?? 'unknown');
  }
}

async function connect() {
  // Every failed pairing attempt leaves half-written credentials behind, and
  // WhatsApp rejects the next code while they're there. Start each pairing
  // attempt clean — but never touch a session that is already linked.
  if (pairingNumber() && !isRegistered()) {
    fs.rmSync(cfg.paths.auth, { recursive: true, force: true });
    fs.mkdirSync(cfg.paths.auth, { recursive: true });
    log.dim('cleared a half-finished pairing attempt');
  }

  const { state: auth, saveCreds } = await useMultiFileAuthState(cfg.paths.auth);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log.dim(`WhatsApp Web protocol v${version.join('.')}${isLatest ? '' : ' (a newer one exists)'}`);

  sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, baileysLogger) },
    // Pairing codes are rejected by WhatsApp with some browser identities;
    // Ubuntu/Chrome is the one that reliably works for both pairing and QR.
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false, // keeps push notifications working on your phone
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', onConnectionUpdate);

  const pairNumber = pairingNumber();
  if (pairNumber && !sock.authState.creds.registered) {
    // The socket needs a moment to finish its handshake before it can ask.
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairNumber);
        log.banner(`Pairing code for +${pairNumber}:   ${code}`);
        log.info('On the phone: WhatsApp > Linked devices > Link with phone number > type this code');
      } catch (err) {
        log.error(`could not get a pairing code: ${err.message}`);
      }
    }, 3000);
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // DEBUG_MESSAGES=1 shows every message event that reaches the socket,
    // including the ones normally filtered out. Use it when an expected
    // message (a voice note, say) never seems to arrive.
    if (process.env.DEBUG_MESSAGES) {
      for (const msg of messages) {
        const kinds = Object.keys(msg.message || {}).join(',') || 'EMPTY';
        log.dim(`raw upsert [${type}] from=${msg.key?.remoteJid} fromMe=${!!msg.key?.fromMe} content=${kinds}`);
      }
    }
    for (const msg of messages) {
      if (!shouldHandleUpsert(msg, type)) continue;
      try {
        await handleMessage(msg);
      } catch (err) {
        log.error(`message handler crashed: ${err.stack || err.message}`);
      }
    }
  });

  // Deliberately not awaited one by one: an offer sits in its ring delay for
  // seconds, and the event that ends that same call has to get through meanwhile.
  sock.ev.on('call', (calls) => {
    for (const call of calls) {
      handleCall(call).catch((err) => log.error(`call handler crashed: ${err.stack || err.message}`));
    }
  });
}

async function main() {
  cfg = loadConfig();
  baileysLogger = makeQuietLogger(process.env.BAILEYS_LOG_LEVEL || 'silent');
  fs.mkdirSync(cfg.paths.auth, { recursive: true });
  fs.mkdirSync(cfg.paths.voicemails, { recursive: true });
  store.load();

  log.banner('WhatsApp auto-reply bot');

  // Fingerprint of the code actually loaded, so "did my restart take effect?"
  // is answerable at a glance instead of by guesswork.
  const built = fs.statSync(__filename).mtime.toLocaleString();
  log.dim(`code loaded    : ${built}  (pid ${process.pid})`);
  fs.writeFileSync(path.join(cfg.paths.root, 'data', 'bot.pid'), String(process.pid));

  await connect();
}

if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log.warn('shutting down...');
      store.flushNow();
      process.exit(0);
    });
  }

  process.on('unhandledRejection', (err) => {
    log.error(`unhandled rejection: ${err?.stack || err}`);
  });

  main().catch((err) => {
    log.error(err.message);
    process.exit(1);
  });
}

// Exported so the handlers can be exercised offline against a stub socket.
module.exports = {
  handleMessage,
  handleCall,
  handleMissedPhoneCall,
  shouldHandleUpsert,
  handleOwnerCommand,
  replyBlockedBecause,
  callPromptBlockedBecause,
  callerJid,
  __inject(injected) {
    cfg = injected.cfg;
    sock = injected.sock;
    ownJid = injected.ownJid || '';
    baileysLogger = injected.baileysLogger || makeQuietLogger('silent');
  },
};
