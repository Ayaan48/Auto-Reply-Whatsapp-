'use strict';

// Prints the two TwiML Bins for the no-server setup: `npm run phone:twiml`
//
// A TwiML Bin is a snippet of XML that Twilio hosts for you. With these two,
// Twilio answers, greets, records and hangs up entirely on its own — nothing
// runs on your machine during the call. `npm run phone:pull` fetches the
// recordings afterwards.

const { loadConfig } = require('../config');

const cfg = loadConfig();
const { greetingVoice, greetingLanguage, greetingText, thanksText, maxRecordingSeconds, playBeep } = cfg.phone;

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const say = (text) =>
  `<Say voice="${escapeXml(greetingVoice)}" language="${escapeXml(greetingLanguage)}">${escapeXml(text)}</Say>`;

const binTwo = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>', `  ${say(thanksText)}`, '  <Hangup/>', '</Response>'].join('\n');

const greetingLine = cfg.phone.greetingAudio
  ? '  <Play>PUT_THE_PUBLIC_URL_OF_YOUR_GREETING_MP3_HERE</Play>'
  : `  ${say(greetingText)}`;

const binOne = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Response>',
  greetingLine,
  `  <Record action="PASTE_BIN_2_URL_HERE" maxLength="${maxRecordingSeconds}" playBeep="${!!playBeep}" finishOnKey="#" trim="trim-silence"/>`,
  '</Response>',
].join('\n');

console.log(`
Two TwiML Bins, no server needed.
Create them at https://console.twilio.com/us1/develop/twiml-bins

--------------------------------------------------------------------
STEP 1 - make a bin named "voicemail-done" and paste this:
--------------------------------------------------------------------
${binTwo}

Save it, then copy its URL (looks like https://handler.twilio.com/twiml/EHxxxx).

--------------------------------------------------------------------
STEP 2 - make a second bin named "voicemail" and paste this,
         replacing PASTE_BIN_2_URL_HERE with the URL from step 1:
--------------------------------------------------------------------
${binOne}

--------------------------------------------------------------------
STEP 3 - point your number at bin 2
--------------------------------------------------------------------
Twilio console -> Phone Numbers -> your number
  "A call comes in"  ->  TwiML Bin  ->  voicemail

--------------------------------------------------------------------
STEP 4 - collect the messages
--------------------------------------------------------------------
npm run phone:pull            fetch anything new, then exit
npm run phone:pull -- --watch keep checking every ${Number(cfg.phone.pullEveryMinutes) || 5} minutes
${
  cfg.phone.greetingAudio
    ? '\nNote: greetingAudio is set, but a TwiML Bin needs a PUBLIC url for it.\nUpload your greeting somewhere reachable and paste that url into <Play>,\nor clear phone.greetingAudio to use the spoken greeting instead.'
    : ''
}`);
