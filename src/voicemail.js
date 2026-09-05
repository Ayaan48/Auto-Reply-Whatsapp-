'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { downloadMediaMessage } = require('baileys');
const { log } = require('./logger');
const { audioPart, fillTemplate, templateVars } = require('./replier');

const EXT_BY_MIME = [
  ['ogg', 'ogg'],
  ['opus', 'ogg'],
  ['mpeg', 'mp3'],
  ['mp4', 'm4a'],
  ['aac', 'aac'],
  ['amr', 'amr'],
  ['wav', 'wav'],
];

function extensionFor(mimetype = '') {
  const found = EXT_BY_MIME.find(([needle]) => mimetype.includes(needle));
  return found ? found[1] : 'bin';
}

function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

function indexPath(dir) {
  return path.join(dir, 'index.json');
}

function readIndex(dir) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(dir), 'utf8'));
  } catch {
    return [];
  }
}

function appendIndex(dir, entry) {
  const all = readIndex(dir);
  all.push(entry);
  fs.writeFileSync(indexPath(dir), JSON.stringify(all, null, 2));
}

function runTranscription(command, file) {
  return new Promise((resolve) => {
    const cmd = command.includes('{file}')
      ? command.replace(/\{file\}/g, `"${file}"`)
      : `${command} "${file}"`;
    exec(cmd, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        log.warn(`transcription failed: ${err.message.split('\n')[0]}`);
        return resolve('');
      }
      resolve(String(stdout).trim());
    });
  });
}

/**
 * Writes one voicemail to disk: the audio, a JSON sidecar, and an entry in
 * index.json. Shared by both channels so WhatsApp voice notes and recorded
 * phone calls end up in the same box, listed together.
 */
async function writeVoicemail(cfg, details) {
  const {
    buffer,
    extension,
    from,
    number,
    name = '',
    seconds = 0,
    reason,
    channel,
    isVoiceNote = false,
    receivedAt = new Date(),
    extra = {},
  } = details;

  const dir = cfg.paths.voicemails;
  fs.mkdirSync(dir, { recursive: true });

  const base = `${timestampSlug(receivedAt)}_${number}`;
  const file = path.join(dir, `${base}.${extension}`);
  fs.writeFileSync(file, buffer);

  const entry = {
    id: base,
    channel,
    file: path.relative(cfg.paths.root, file).split(path.sep).join('/'),
    from,
    number,
    name: String(name || '').trim(),
    receivedAt: receivedAt.toISOString(),
    seconds,
    bytes: buffer.length,
    isVoiceNote,
    reason,
    transcript: '',
    ...extra,
  };

  if (cfg.voicemail.transcribeCommand) {
    entry.transcript = await runTranscription(cfg.voicemail.transcribeCommand, file);
  }

  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(entry, null, 2));
  appendIndex(dir, entry);
  return entry;
}

/**
 * Downloads an incoming WhatsApp voice note and stores it as a voicemail.
 * Returns the saved entry, or null if the message carried no audio.
 */
async function saveVoicemail(sock, msg, { cfg, jid, pushName, reason, baileysLogger, download }) {
  const audio = audioPart(msg);
  if (!audio) return null;

  const fetchMedia = download || downloadMediaMessage;
  const buffer = await fetchMedia(
    msg,
    'buffer',
    {},
    { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage },
  );

  return writeVoicemail(cfg, {
    buffer,
    extension: extensionFor(audio.mimetype),
    channel: 'whatsapp',
    from: jid,
    number: String(jid).split('@')[0],
    name: pushName,
    seconds: audio.seconds || 0,
    isVoiceNote: !!audio.ptt,
    reason,
  });
}

function confirmationText(cfg, entry, pushName, jid) {
  const vars = { ...templateVars(pushName, jid), seconds: entry.seconds || 0 };
  return fillTemplate(cfg.voicemail.confirmation, vars);
}

function recent(cfg, limit = 5) {
  return readIndex(cfg.paths.voicemails).slice(-limit).reverse();
}

module.exports = {
  writeVoicemail,
  saveVoicemail,
  confirmationText,
  recent,
  readIndex,
  extensionFor,
};
