'use strict';

// Stops a running bot: `npm run stop`
// Uses the PID the bot wrote at startup, so it never kills unrelated Node apps.

const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, '..', 'data', 'bot.pid');

if (!fs.existsSync(PID_FILE)) {
  console.log('No bot.pid found - the bot does not look like it is running.');
  process.exit(0);
}

const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());

if (!Number.isInteger(pid) || pid <= 0) {
  console.log('bot.pid is unreadable; removing it.');
  fs.rmSync(PID_FILE, { force: true });
  process.exit(0);
}

try {
  process.kill(pid, 'SIGTERM');
  console.log(`Stopped the bot (pid ${pid}).`);
} catch (err) {
  if (err.code === 'ESRCH') console.log(`No process with pid ${pid} - it had already stopped.`);
  else console.log(`Could not stop pid ${pid}: ${err.message}`);
}

fs.rmSync(PID_FILE, { force: true });
