'use strict';

// Sending SMS through Termux:API, so a missed call can reach people who
// aren't on WhatsApp at all.
//
// Requires: Termux + the Termux:API app, `pkg install termux-api`, and SMS
// permission granted to Termux:API.

const { execFile } = require('child_process');
const { log } = require('./logger');

// A single SMS is 160 GSM-7 characters; anything longer is split and billed
// per part, and Unicode (emoji, curly quotes) drops that to 70.
const SINGLE_SMS_CHARS = 160;

function isUnicode(text) {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(text);
}

function segmentCount(text) {
  const limit = isUnicode(text) ? 70 : SINGLE_SMS_CHARS;
  return Math.max(1, Math.ceil(text.length / limit));
}

/** True when the termux-sms-send command exists at all. */
function isInstalled() {
  return new Promise((resolve) => {
    execFile('command', ['-v', 'termux-sms-send'], { shell: true, timeout: 5000 }, (err) =>
      resolve(!err),
    );
  });
}

/**
 * Sends one SMS. Rejects rather than throwing into the caller's flow, and
 * times out instead of hanging forever when the SMS permission is missing.
 */
function send(number, text, { simSlot } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-n', number];
    if (Number.isInteger(simSlot) && simSlot >= 0) args.push('-s', String(simSlot));
    args.push(text);

    execFile('termux-sms-send', args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const hint = err.killed
          ? 'timed out - is SMS permission granted to Termux:API?'
          : String(stderr || err.message).trim();
        return reject(new Error(hint));
      }
      resolve(true);
    });
  });
}

async function trySend(number, text, options = {}) {
  const parts = segmentCount(text);
  if (parts > 1) log.dim(`SMS is ${text.length} chars - will be sent as ${parts} parts`);
  try {
    await send(number, text, options);
    return true;
  } catch (err) {
    log.error(`SMS to ${number} failed: ${err.message}`);
    return false;
  }
}

module.exports = { send, trySend, isInstalled, segmentCount };
