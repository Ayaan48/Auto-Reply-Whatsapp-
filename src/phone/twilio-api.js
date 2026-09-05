'use strict';

// Shared Twilio helpers. Credentials are read lazily so dotenv has always run
// by the time they're needed.

const twilio = require('twilio');

function credentials() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
  };
}

function client() {
  const { accountSid, authToken } = credentials();
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env');
  }
  return twilio(accountSid, authToken);
}

function recordingMediaUrl(recordingSid) {
  const { accountSid } = credentials();
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`;
}

// Twilio can take a moment to finalise audio, so a 404 straight after a call is
// normal rather than fatal.
async function fetchRecording(url, attempt = 1) {
  const { accountSid, authToken } = credentials();
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });

  if (response.ok) return Buffer.from(await response.arrayBuffer());
  if (attempt >= 5) throw new Error(`Twilio returned ${response.status} for the recording`);

  await new Promise((r) => setTimeout(r, attempt * 1000));
  return fetchRecording(url, attempt + 1);
}

async function deleteRecording(recordingSid) {
  await client().recordings(recordingSid).remove();
}

module.exports = { credentials, client, recordingMediaUrl, fetchRecording, deleteRecording };
