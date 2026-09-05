'use strict';

// Turns ordinary missed phone calls into voicemails, with no phone number to
// buy and no telephony account.
//
// When the bot runs on your Android phone under Termux, it can read the phone's
// own call log. A missed call there triggers the same voicemail flow the
// WhatsApp side already uses: the caller gets your greeting and leaves a voice
// note, which lands in data/voicemails/.
//
// Requires: Termux + the Termux:API app, `pkg install termux-api`, and call log
// permission granted to Termux:API.

const { exec } = require('child_process');
const { log } = require('./logger');

const MISSED_TYPES = new Set(['MISSED']);
const REJECTED_TYPES = new Set(['REJECTED', 'BLOCKED']);

function runCallLog(limit) {
  return new Promise((resolve, reject) => {
    exec(`termux-call-log -l ${limit}`, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const text = String(stdout || '').trim();
      if (!text) return resolve([]);
      try {
        const parsed = JSON.parse(text);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        reject(new Error('termux-call-log did not return JSON'));
      }
    });
  });
}

/**
 * Turns whatever the call log gives us into a plain international number.
 * Handles "+91 12345 67890", "01234567890" and bare 10-digit local numbers.
 */
function toInternational(raw, countryCode) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  while (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length <= 10) digits = `${countryCode}${digits}`;
  return digits;
}

function parseWhen(entry) {
  const parsed = Date.parse(entry.date);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isMissed(entry, includeRejected) {
  const type = String(entry.type || '').toUpperCase();
  return MISSED_TYPES.has(type) || (includeRejected && REJECTED_TYPES.has(type));
}

/** True when this machine can actually read the call log. */
async function isAvailable(callLog = runCallLog) {
  try {
    await callLog(1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Polls the call log and reports missed calls that happened after `since`.
 * Pure enough to test: pass your own callLog function.
 */
async function findNewMissedCalls(cfg, since, callLog = runCallLog) {
  const { countryCode, includeRejected, lookbackMinutes } = cfg.missedCalls;
  const entries = await callLog(30);
  const floor = Math.max(since, Date.now() - lookbackMinutes * 60000);

  return entries
    .filter((entry) => isMissed(entry, includeRejected))
    .map((entry) => ({
      number: toInternational(entry.phone_number, countryCode),
      name: entry.name && entry.name !== 'UNKNOWN' ? entry.name : '',
      at: parseWhen(entry),
    }))
    .filter((call) => call.number && call.at > floor)
    .sort((a, b) => a.at - b.at);
}

/**
 * Starts polling. Returns a stop function.
 * `since` should be "now" on a fresh start so the bot never messages everyone
 * already sitting in the call log.
 */
function start({ cfg, since, onMissedCall, callLog = runCallLog }) {
  let watermark = since;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const calls = await findNewMissedCalls(cfg, watermark, callLog);
      for (const call of calls) {
        watermark = Math.max(watermark, call.at);
        try {
          await onMissedCall(call);
        } catch (err) {
          log.error(`missed-call handler failed for ${call.number}: ${err.message}`);
        }
      }
    } catch (err) {
      log.warn(`could not read the call log: ${err.message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, Math.max(5, cfg.missedCalls.pollSeconds) * 1000);
  if (timer.unref) timer.unref();
  tick();

  return () => clearInterval(timer);
}

module.exports = { start, isAvailable, findNewMissedCalls, toInternational, runCallLog };
