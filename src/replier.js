'use strict';

const { getContentType } = require('baileys');

// WhatsApp nests text in a different field for almost every message type.
function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.ephemeralMessage?.message?.conversation ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    m.viewOnceMessage?.message?.conversation ||
    m.viewOnceMessageV2?.message?.conversation ||
    ''
  ).trim();
}

function messageKind(msg) {
  const inner =
    msg.message?.ephemeralMessage?.message ||
    msg.message?.viewOnceMessage?.message ||
    msg.message?.viewOnceMessageV2?.message ||
    msg.message;
  return getContentType(inner) || 'unknown';
}

function audioPart(msg) {
  const inner =
    msg.message?.ephemeralMessage?.message ||
    msg.message?.viewOnceMessage?.message ||
    msg.message?.viewOnceMessageV2?.message ||
    msg.message;
  return inner?.audioMessage || null;
}

function firstName(pushName, jid) {
  const name = (pushName || '').trim().split(/\s+/)[0];
  if (name) return name;
  return 'there';
}

function fillTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    vars[key] === undefined ? match : String(vars[key]),
  );
}

function templateVars(pushName, jid) {
  const now = new Date();
  return {
    name: firstName(pushName, jid),
    fullname: (pushName || '').trim() || 'there',
    number: String(jid || '').split('@')[0],
    time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    date: now.toLocaleDateString(),
  };
}

// First rule with a keyword present in the message wins; otherwise the default reply.
function pickRuleReply(autoReply, text) {
  const haystack = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')} `;
  for (const rule of autoReply.rules) {
    for (const keyword of rule.keywords) {
      const needle = String(keyword).toLowerCase().trim();
      if (!needle) continue;
      if (haystack.includes(` ${needle} `)) {
        return { reply: rule.reply, rule: rule.name || 'rule' };
      }
    }
  }
  return { reply: autoReply.defaultReply, rule: 'default' };
}

// Word-boundary match for plain words (so "bank" hits "HDFC Bank" but not
// "Bankim"), substring match for anything with punctuation ("a/c", "%off").
function patternHit(patterns, haystack) {
  const lower = String(haystack || '').toLowerCase();
  const raw = ` ${lower} `;
  const words = ` ${lower.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ')} `;
  for (const pattern of patterns || []) {
    const needle = String(pattern).toLowerCase().trim();
    if (!needle) continue;
    const plainWords = /^[\p{L}\p{N}\s]+$/u.test(needle);
    if (plainWords ? words.includes(` ${needle} `) : raw.includes(needle)) return pattern;
  }
  return null;
}

/**
 * Decides whether a message looks like it came from a company rather than a
 * person — banks, telcos, delivery apps, OTP and promo blasts. Returns a
 * human-readable reason, or null when it looks like a real conversation.
 */
function spamReason(spamFilter, { text, pushName, verifiedBizName }) {
  if (!spamFilter || !spamFilter.enabled) return null;

  // WhatsApp itself tells us when the sender is a verified business account.
  if (spamFilter.skipBusinessAccounts && verifiedBizName) {
    return `verified business account (${verifiedBizName})`;
  }

  const senderHit = patternHit(spamFilter.senderPatterns, `${verifiedBizName || ''} ${pushName || ''}`);
  if (senderHit) return `sender name matches "${senderHit}"`;

  const contentHit = patternHit(spamFilter.contentPatterns, text);
  if (contentHit) return `message text matches "${contentHit}"`;

  return null;
}

// Message kinds that are actually readable text. Everything else is a picture,
// document, sticker, contact card and so on — things the AI never receives and
// so has no business writing a considered reply about.
const TEXT_KINDS = new Set(['conversation', 'extendedTextMessage']);

function isTextMessage(kind) {
  return TEXT_KINDS.has(kind);
}

// OTPs, account numbers, amounts, UPI refs — mostly digits, and never something
// an AI should be improvising a response to.
function looksLikeCodeOrNumber(text) {
  const compact = String(text || '').replace(/\s+/g, '');
  if (compact.length < 4) return false;
  const digits = (compact.match(/\d/g) || []).length;
  return digits >= 4 && digits / compact.length >= 0.6;
}

/**
 * Why the AI should keep out of this particular message, or null if it's fine.
 */
function sensitiveReason(aiChat, text) {
  if (!text) return null;
  const hit = patternHit(aiChat.skipPatterns, text);
  if (hit) return `mentions "${hit}"`;
  if (aiChat.skipNumbers && looksLikeCodeOrNumber(text)) return 'looks like a code or number';
  return null;
}

function normalizeNumber(value) {
  return String(value).replace(/\D/g, '');
}

function listMatches(list, jid) {
  if (!list || list.length === 0) return false;
  const number = normalizeNumber(jid.split('@')[0]);
  return list.some((entry) => normalizeNumber(entry) === number);
}

module.exports = {
  extractText,
  messageKind,
  audioPart,
  fillTemplate,
  templateVars,
  pickRuleReply,
  listMatches,
  spamReason,
  patternHit,
  isTextMessage,
  looksLikeCodeOrNumber,
  sensitiveReason,
};
