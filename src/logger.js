'use strict';

const fs = require('fs');
const path = require('path');

// BOT_LOG_FILE lets the test suite log somewhere else instead of polluting the
// real bot log with fake traffic.
const LOG_FILE = process.env.BOT_LOG_FILE || path.join(__dirname, '..', 'data', 'bot.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const COLORS = {
  info: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  dim: '\x1b[90m',
};
const RESET = '\x1b[0m';

try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch {
  /* the bot still runs without an on-disk log */
}

// Keep the on-disk log from growing forever.
function rotateIfNeeded() {
  try {
    const { size } = fs.statSync(LOG_FILE);
    if (size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
  } catch {
    /* no log file yet */
  }
}
rotateIfNeeded();

function write(level, marker, msg) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const color = COLORS[level] || '';
  console.log(`${COLORS.dim}${time}${RESET} ${color}${marker}${RESET} ${msg}`);
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${marker} ${msg}\n`);
  } catch {
    /* logging must never crash the bot */
  }
}

const log = {
  info: (m) => write('info', '[i]', m),
  ok: (m) => write('ok', '[+]', m),
  warn: (m) => write('warn', '[!]', m),
  error: (m) => write('error', '[x]', m),
  dim: (m) => write('dim', '   ', m),
  banner: (m) => console.log(`\n${COLORS.ok}${m}${RESET}\n`),
};

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity };

// Baileys expects a pino-shaped logger. At the default "silent" level this drops
// its internal protocol chatter; any other level lets it through for debugging.
function makeQuietLogger(level = 'silent') {
  const threshold = LEVELS[level] ?? Infinity;
  const at = (name) => {
    if (LEVELS[name] < threshold) return () => {};
    return (obj, msg) => {
      const text = typeof obj === 'string' ? obj : msg || obj?.msg || '';
      if (text) log.dim(`baileys ${name}: ${String(text).slice(0, 300)}`);
    };
  };
  const shim = {
    level,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
  };
  shim.child = () => shim;
  return shim;
}

module.exports = { log, makeQuietLogger, LOG_FILE };
