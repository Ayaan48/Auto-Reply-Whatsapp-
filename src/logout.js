'use strict';

// Unlinks this device by deleting the stored WhatsApp session.
// Run this if you unlink the bot from your phone, or want to link a different number.

const fs = require('fs');
const { loadConfig } = require('./config');
const { log } = require('./logger');

const cfg = loadConfig();

if (!fs.existsSync(cfg.paths.auth)) {
  log.info('No saved session found - nothing to remove.');
  process.exit(0);
}

fs.rmSync(cfg.paths.auth, { recursive: true, force: true });
log.ok('Session deleted. Run "npm start" and scan the QR code to link again.');
log.dim('Voicemails, config and stats were left untouched.');
