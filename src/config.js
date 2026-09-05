'use strict';

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
  autoReply: {
    enabled: true,
    replyMode: 'rules',
    replyToGroups: false,
    replyOnlyOutsideBusinessHours: false,
    businessHours: {
      timezone: '',
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '18:00',
    },
    cooldownMinutes: 300,
    replyDelayMinutes: 5,
    quietAfterYouReplyMinutes: 30,
    maxRepliesPerContactPerDay: 5,
    typingDelayMs: [1500, 3500],
    markAsRead: false,
    notifyOwner: true,
    defaultReply:
      "Hi {name}! This is an automated reply — I'm away from my phone right now. I've seen your message and I'll get back to you as soon as I can.",
    rules: [
      {
        name: 'greeting',
        keywords: [
          'hi', 'hii', 'hy', 'hlo', 'helo', 'hello', 'hey', 'heyy', 'yo',
          'salam', 'assalam', 'namaste', 'hola',
          'good morning', 'good evening', 'good afternoon',
        ],
        reply: "Hi {name}! I'm not at my phone at the moment, but I've got your message and I'll reply properly soon.",
      },
      {
        name: 'urgent',
        keywords: ['urgent', 'emergency', 'asap', 'important'],
        reply: "Thanks {name} — I've flagged this as urgent and I'll get to it as soon as I'm back. If it can't wait, please send a voice note with the details.",
      },
      {
        name: 'pricing',
        keywords: ['price', 'pricing', 'cost', 'rate', 'quote', 'how much'],
        reply: "Hi {name}! Thanks for asking about pricing. I'll send you full details as soon as I'm back at my desk.",
      },
    ],
    allowlist: [],
    blocklist: [],
  },
  spamFilter: {
    enabled: true,
    skipBusinessAccounts: true,
    senderPatterns: [
      'hdfc', 'icici', 'sbi', 'axis', 'kotak', 'idfc', 'yes bank', 'indusind',
      'bank', 'bajaj', 'finserv', 'loan', 'insurance', 'policybazaar', 'creditcard',
      'jio', 'airtel', 'vodafone', 'vi', 'bsnl', 'idea',
      'paytm', 'phonepe', 'gpay', 'cred', 'razorpay',
      'amazon', 'flipkart', 'myntra', 'meesho', 'ajio',
      'swiggy', 'zomato', 'blinkit', 'zepto', 'uber', 'ola', 'rapido',
      'noreply', 'no reply', 'donotreply', 'do not reply', 'notifications',
    ],
    contentPatterns: [
      'otp', 'one time password', 'one-time password', 'verification code',
      'do not share', 'never share this', 'valid for 10 minutes',
      'debited', 'credited', 'a/c', 'acct', 'available balance', 'txn',
      'has been dispatched', 'out for delivery', 'order id',
      'recharge', 'plan expires', 'validity expires', 'due date',
      'unsubscribe', 'reply stop', 'click here', 'claim now', 'limited time',
      'cashback', '% off', '%off', 't&c apply', 'terms and conditions apply',
    ],
  },
  calls: {
    enabled: true,
    action: 'reject',
    ringSeconds: 15,
    handleVideoCalls: true,
    handleGroupCalls: false,
    message:
      "Hi {name}! I can't take calls right now. Please send a voice message here with what you need and I'll listen to it and get back to you.",
    cooldownMinutes: 10,
  },
  voicemail: {
    enabled: true,
    windowMinutes: 15,
    captureAllVoiceNotes: false,
    greetingAudio: '',
    confirmation:
      "Got your voice message ({seconds}s) — saved. I'll listen to it and get back to you soon.",
    saveDir: 'data/voicemails',
    transcribeCommand: '',
  },
  ai: {
    model: 'claude-opus-5',
    effort: 'low',
    maxTokens: 2000,
    maxWords: 45,
    historyTurns: 6,
    persona:
      'You are answering WhatsApp messages on behalf of the phone owner, who is currently unavailable.',
  },
  aiChat: {
    enabled: false,
    allChats: false,
    persona:
      'You are a friendly, easygoing person in your early twenties. You keep things light and brief.',
    maxWords: 40,
    maxTurns: 12,
    historyTurns: 20,
    holdSeconds: [8, 25],
    onAttachment: 'acknowledge',
    attachmentReply: "thanks for sending this, i'll have a proper look in a bit",
    skipNumbers: true,
    skipPatterns: [
      'otp', 'password', 'pin', 'cvv', 'upi', 'ifsc', 'account number',
      'card number', 'verification code', 'transaction id',
    ],
    backend: 'api',
    cliCommand: 'proot-distro login ubuntu -- claude -p',
    cliTimeoutSeconds: 120,
    handoffNote:
      "I've been chatting with {name} for a while — worth taking over, I've stopped replying there.",
  },
  owner: {
    commandPrefix: '!',
    enableCommands: true,
  },
  missedCalls: {
    enabled: 'auto',
    pollSeconds: 20,
    countryCode: '91',
    includeRejected: true,
    lookbackMinutes: 10,
    notify: 'both',
    smsMessage:
      "Hi {name}, sorry I missed your call. I can't talk right now - please text me what you need and I'll get back to you.",
    simSlot: -1,
  },
  phone: {
    port: 3000,
    publicUrl: '',
    greetingAudio: '',
    greetingText:
      "Hello, you've reached Ace. I can't take your call right now. Please leave your message after the beep, and press hash when you're done.",
    greetingVoice: 'Polly.Aditi',
    greetingLanguage: 'en-IN',
    thanksText: 'Thank you, your message has been saved. Goodbye.',
    noMessageText: "I didn't get a message. Goodbye.",
    maxRecordingSeconds: 120,
    playBeep: true,
    rejectAnonymous: false,
    deleteFromTwilio: true,
    pullEveryMinutes: 5,
    blocklist: [],
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = deepMerge(base[key], value);
    else out[key] = value;
  }
  return out;
}

function fail(msg) {
  throw new Error(`config.json: ${msg}`);
}

function validate(cfg) {
  const modes = ['rules', 'ai'];
  if (!modes.includes(cfg.autoReply.replyMode)) {
    fail(`autoReply.replyMode must be one of ${modes.join(' | ')}`);
  }
  const actions = ['reject', 'ignore'];
  if (!actions.includes(cfg.calls.action)) {
    fail(`calls.action must be one of ${actions.join(' | ')}`);
  }
  // WhatsApp gives up on an unanswered call after roughly a minute, so the
  // decline has to land well before that.
  const ring = cfg.calls.ringSeconds;
  if (!Number.isFinite(ring) || ring < 0 || ring > 45) {
    fail('calls.ringSeconds must be a number between 0 and 45');
  }
  const delay = cfg.autoReply.replyDelayMinutes;
  if (!Number.isFinite(delay) || delay < 0) {
    fail('autoReply.replyDelayMinutes must be 0 or more (0 replies immediately)');
  }
  const [lo, hi] = cfg.autoReply.typingDelayMs;
  if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi >= lo)) {
    fail('autoReply.typingDelayMs must be [min, max] in milliseconds');
  }
  for (const field of ['start', 'end']) {
    if (!/^\d{2}:\d{2}$/.test(cfg.autoReply.businessHours[field])) {
      fail(`autoReply.businessHours.${field} must look like "09:00"`);
    }
  }
  if (cfg.autoReply.replyMode === 'ai' && !process.env.ANTHROPIC_API_KEY) {
    fail('autoReply.replyMode is "ai" but ANTHROPIC_API_KEY is not set (put it in .env)');
  }
  const attachModes = ['acknowledge', 'ignore', 'ai'];
  if (!attachModes.includes(cfg.aiChat.onAttachment)) {
    fail(`aiChat.onAttachment must be one of ${attachModes.join(' | ')}`);
  }
  const backends = ['api', 'cli'];
  if (!backends.includes(cfg.aiChat.backend)) {
    fail(`aiChat.backend must be one of ${backends.join(' | ')}`);
  }
  // The cli backend authenticates through Claude Code, so no API key is needed.
  if (cfg.aiChat.enabled && cfg.aiChat.backend === 'api' && !process.env.ANTHROPIC_API_KEY) {
    fail('aiChat.enabled is true but ANTHROPIC_API_KEY is not set (put it in .env, or set aiChat.backend to "cli")');
  }
  const [chatLo, chatHi] = cfg.aiChat.holdSeconds;
  if (!(Number.isFinite(chatLo) && Number.isFinite(chatHi) && chatLo >= 0 && chatHi >= chatLo)) {
    fail('aiChat.holdSeconds must be [min, max] in seconds');
  }
  for (const rule of cfg.autoReply.rules) {
    if (!Array.isArray(rule.keywords) || typeof rule.reply !== 'string') {
      fail(`rule "${rule.name || '?'}" needs a keywords array and a reply string`);
    }
  }
  if (cfg.voicemail.greetingAudio && !fs.existsSync(path.resolve(ROOT, cfg.voicemail.greetingAudio))) {
    fail(`voicemail.greetingAudio not found: ${cfg.voicemail.greetingAudio}`);
  }
  if (cfg.phone.greetingAudio && !fs.existsSync(path.resolve(ROOT, cfg.phone.greetingAudio))) {
    fail(`phone.greetingAudio not found: ${cfg.phone.greetingAudio}`);
  }
  if (!Number.isInteger(cfg.phone.port) || cfg.phone.port < 1 || cfg.phone.port > 65535) {
    fail('phone.port must be a port number');
  }
  if (![true, false, 'auto'].includes(cfg.missedCalls.enabled)) {
    fail('missedCalls.enabled must be true, false or "auto"');
  }
  if (!/^\d{1,4}$/.test(String(cfg.missedCalls.countryCode))) {
    fail('missedCalls.countryCode must be digits only, e.g. "91"');
  }
  const notifyModes = ['both', 'whatsapp', 'sms', 'auto'];
  if (!notifyModes.includes(cfg.missedCalls.notify)) {
    fail(`missedCalls.notify must be one of ${notifyModes.join(' | ')}`);
  }
}

function loadConfig() {
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    try {
      user = JSON.parse(raw);
    } catch (err) {
      throw new Error(`config.json is not valid JSON — ${err.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, user);
  validate(cfg);
  cfg.paths = {
    root: ROOT,
    auth: path.join(ROOT, 'data', 'auth'),
    voicemails: path.resolve(ROOT, cfg.voicemail.saveDir),
    greetingAudio: cfg.voicemail.greetingAudio
      ? path.resolve(ROOT, cfg.voicemail.greetingAudio)
      : '',
  };
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, CONFIG_PATH, ROOT };
