'use strict';

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'data', 'state.json');
const TMP_PATH = STATE_PATH + '.tmp';
const CONTACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const EMPTY = {
  paused: false,
  contacts: {},
  stats: { replies: 0, calls: 0, voicemails: 0 },
};

let state = structuredClone(EMPTY);
let saveTimer = null;

function load() {
  try {
    state = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
  } catch {
    state = structuredClone(EMPTY);
  }
  pruneStaleContacts();
  return state;
}

function pruneStaleContacts() {
  const cutoff = Date.now() - CONTACT_TTL_MS;
  for (const [jid, c] of Object.entries(state.contacts)) {
    const seen = Math.max(c.lastSeenAt || 0, c.lastReplyAt || 0, c.lastCallAt || 0);
    if (seen && seen < cutoff) delete state.contacts[jid];
  }
}

// Written via tmp file + rename so a crash mid-write can't corrupt the state.
function flush() {
  saveTimer = null;
  try {
    fs.writeFileSync(TMP_PATH, JSON.stringify(state, null, 2));
    fs.renameSync(TMP_PATH, STATE_PATH);
  } catch {
    /* state is a convenience cache; losing a write is not fatal */
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 400);
  if (saveTimer.unref) saveTimer.unref();
}

function flushNow() {
  if (saveTimer) clearTimeout(saveTimer);
  flush();
}

function contact(jid) {
  if (!state.contacts[jid]) {
    state.contacts[jid] = { replyCount: 0, replyDay: '', history: [] };
  }
  return state.contacts[jid];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function noteReply(jid) {
  const c = contact(jid);
  const day = today();
  if (c.replyDay !== day) {
    c.replyDay = day;
    c.replyCount = 0;
  }
  c.replyCount += 1;
  c.lastReplyAt = Date.now();
  state.stats.replies += 1;
  save();
}

function repliesToday(jid) {
  const c = contact(jid);
  return c.replyDay === today() ? c.replyCount : 0;
}

function pushHistory(jid, role, text, limit) {
  const c = contact(jid);
  c.history = (c.history || []).concat({ role, text: String(text).slice(0, 600) }).slice(-limit);
  c.lastSeenAt = Date.now();
  save();
}

module.exports = {
  load,
  save,
  flushNow,
  contact,
  noteReply,
  repliesToday,
  pushHistory,
  get state() {
    return state;
  },
  STATE_PATH,
};
