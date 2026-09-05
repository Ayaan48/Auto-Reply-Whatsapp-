'use strict';

// Prints every recorded voicemail, newest first: `npm run voicemails`

const path = require('path');
const { loadConfig } = require('./config');
const { readIndex } = require('./voicemail');

const cfg = loadConfig();
const items = readIndex(cfg.paths.voicemails).reverse();

if (items.length === 0) {
  console.log('No voicemails recorded yet.');
  console.log(`They will appear in ${path.relative(process.cwd(), cfg.paths.voicemails)} once someone leaves one.`);
  process.exit(0);
}

console.log(`${items.length} voicemail(s), newest first:\n`);

for (const v of items) {
  const who = v.name ? `${v.name} (+${v.number})` : `+${v.number}`;
  console.log(`${new Date(v.receivedAt).toLocaleString()}  ${who}`);
  console.log(`  ${v.channel || 'whatsapp'} | ${v.seconds}s | ${(v.bytes / 1024).toFixed(0)} KB | ${v.reason}`);
  console.log(`  ${v.file}`);
  if (v.transcript) console.log(`  "${v.transcript}"`);
  console.log('');
}
