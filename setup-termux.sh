#!/data/data/com.termux/files/usr/bin/bash
#
# One-shot Termux setup for the WhatsApp auto-reply bot.
#
#   bash setup-termux.sh
#
# Safe to run more than once - it only installs what is missing and never
# touches config.json or anything already in data/.

set -u

say()  { printf '\n\033[36m==>\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$1"; }
warn() { printf '\033[33m  !!\033[0m %s\n' "$1"; }

if [ ! -f package.json ]; then
  warn "Run this from inside the Auto-Reply folder (the one with package.json)."
  exit 1
fi

say "Installing packages"
pkg install -y nodejs-lts termux-api tmux >/dev/null 2>&1 || {
  warn "pkg install failed - try 'pkg update' first, then run this again."
  exit 1
}
ok "nodejs, termux-api and tmux installed"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node $NODE_MAJOR is too old - this needs Node 20 or newer."
  exit 1
fi
ok "node $(node -v)"

say "Installing dependencies (this takes a few minutes on a phone)"
if [ -d node_modules ] && [ -d node_modules/baileys ]; then
  ok "already installed"
else
  # node_modules copied from a PC will not work here - rebuild from scratch.
  rm -rf node_modules
  npm install --no-audit --no-fund || { warn "npm install failed"; exit 1; }
  ok "dependencies installed"
fi

say "Checking call log access (for missed-call voicemails)"
# termux-call-log blocks forever when the Termux:API *app* is missing - the
# command is there but nothing answers it, so this must be time-limited.
CALL_LOG_OK=0
if command -v termux-call-log >/dev/null 2>&1; then
  if command -v timeout >/dev/null 2>&1; then
    timeout 10 termux-call-log -l 1 >/dev/null 2>&1 && CALL_LOG_OK=1
  else
    termux-call-log -l 1 >/dev/null 2>&1 && CALL_LOG_OK=1
  fi
fi
if [ "$CALL_LOG_OK" = "1" ]; then
  ok "call log readable - missed calls will trigger voicemail prompts"
else
  warn "Cannot read the call log yet. Missed-call voicemails need:"
  echo "     1. the Termux:API *app* from F-Droid (separate from Termux itself)"
  echo "     2. open it once, then grant Call logs permission:"
  echo "        Settings > Apps > Termux:API > Permissions > Call logs"
  echo "     Everything else still works without this."
fi

say "Keeping the bot alive in the background"
termux-wake-lock 2>/dev/null && ok "wake lock on (CPU stays awake with the screen off)" \
  || warn "termux-wake-lock unavailable - install the Termux:API app"

echo
echo "  Also turn off battery optimisation for Termux, or Android will kill it:"
echo "    Settings > Apps > Termux > Battery > Unrestricted"
echo "    On Xiaomi/Oppo/Vivo/Realme also enable Autostart."

say "Ready"
if [ -f data/auth/creds.json ]; then
  echo "  A WhatsApp session is already here - just start it:"
  echo
  echo "    tmux new -s bot"
  echo "    npm start"
  echo "    (Ctrl+B then D to detach and leave it running)"
else
  echo "  Link WhatsApp with a pairing code - you cannot scan your own screen:"
  echo
  echo "    node src/index.js --pair 911234567890"
  echo
  echo "  Then enter the code in WhatsApp > Linked devices > Link with phone number."
  echo "  Once linked, run it under tmux so it survives closing Termux:"
  echo
  echo "    tmux new -s bot"
  echo "    npm start"
fi
echo
