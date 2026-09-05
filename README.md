# WhatsApp Auto-Reply Bot

Links to your existing WhatsApp account (the same way WhatsApp Web does), then:

- **auto-replies to incoming messages** — keyword rules, or Claude-written replies
- **handles incoming calls automatically** — declines them and instantly messages the caller
- **records voicemails** — captures the voice note the caller sends back, saves the audio file plus metadata, optionally transcribes it
- **voicemail for ordinary phone calls too** — missed calls on your phone get your greeting on WhatsApp and their reply is saved as a voicemail, free and with no phone number (or, if you want the call genuinely answered, a paid Twilio route)

## One thing to know up front about calls

**No software can pick up a WhatsApp call and record the caller's audio.** WhatsApp voice calls are end-to-end encrypted WebRTC with a proprietary handshake; there is no library — official or unofficial — that can join the audio stream. Anything advertising this is either an Android accessibility hack that taps the answer button and records through the phone's microphone (fragile, blocked on modern Android, and illegal to do silently in many places), or it doesn't work.

So this bot does the part that genuinely works, which is the same thing a real voicemail box achieves:

```
caller rings you
   → bot declines the call within ~1 second
   → bot immediately messages them: "can't take calls, send a voice message"
   → caller records a voice note in the chat
   → bot downloads it, saves it as your voicemail, confirms receipt
```

You end up with the caller's recorded voice in `data/voicemails/`, which is what a voicemail is. You can even record your own greeting once and have the bot send it as a voice note on every missed call (`voicemail.greetingAudio`).

If you'd rather your phone still ring so you can answer when you're free, set `calls.action` to `"ignore"` — the bot then only sends the voicemail prompt for calls you actually missed.

## Setup

```bash
npm install
cp config.example.json config.json   # then edit it to taste
npm start
```

Scan the QR code with your phone: **WhatsApp → Settings → Linked devices → Link a device**.

If you can't scan — because the bot is running *on* the phone whose WhatsApp you're linking — use a pairing code instead:

```bash
node src/index.js --pair 911234567890
```

It prints an 8-character code; enter it under **WhatsApp → Linked devices → Link with phone number**. Number in international form, digits only, no `+`.

The session is saved in `data/auth/`, so you only scan once. Leave the terminal running — the bot is only live while this process is running. Your phone keeps receiving notifications normally (the bot deliberately never marks you "online").

To stop it, press `Ctrl+C`. To unlink, run `npm run logout`.

`npm test` runs an offline test of the whole decision pipeline (replies, cooldowns, allow/blocklists, business hours, owner commands, call handling, voicemail storage) against a stub connection — no WhatsApp account involved.

## Configuration

Everything lives in `config.json`, and it's re-read on restart.

### `autoReply`

| Setting | What it does |
| --- | --- |
| `enabled` | Master switch for message replies |
| `replyMode` | `"rules"` (keyword matching) or `"ai"` (Claude writes each reply) |
| `replyToGroups` | `false` keeps the bot out of group chats |
| `replyOnlyOutsideBusinessHours` | Only auto-reply when you're off the clock |
| `businessHours` | `timezone` (e.g. `"Asia/Kolkata"`, blank = this PC's clock), `days` (0=Sun…6=Sat), `start`, `end`. An `end` earlier than `start` means an overnight window |
| `replyDelayMinutes` | **Holds the reply this long before sending.** If you answer the chat yourself first, the queued reply is thrown away and never sends. `0` replies instantly |
| `quietAfterYouReplyMinutes` | After *you* send anything in a chat, the bot stays out of it for this long — so it can't interrupt a live conversation |
| `notifyOwner` | After auto-replying, sends you a note in your own chat saying who messaged and what they said, so you don't lose the notification |
| `cooldownMinutes` | Won't reply to the same person more than once in this window — the main anti-spam guard |
| `maxRepliesPerContactPerDay` | Hard daily ceiling per contact |
| `typingDelayMs` | `[min, max]` random "typing…" pause before sending, so replies don't look instant |
| `markAsRead` | Show blue ticks on messages the bot replies to. Off by default so chats stay unread and you still see them |
| `defaultReply` | Used when no rule matches |
| `rules` | Ordered list; first rule with a matching keyword wins |
| `allowlist` | If non-empty, **only** these numbers get replies |
| `blocklist` | These numbers never get replies |

Numbers in the lists can be written any way — `+91 98765 43210`, `919876543210` — only the digits are compared.

Any reply text can use `{name}`, `{fullname}`, `{number}`, `{time}`, `{date}`.

### `calls`

| Setting | What it does |
| --- | --- |
| `action` | `"reject"` = let it ring, then decline and send the voicemail prompt. `"ignore"` = never decline, prompt only if you miss it |
| `ringSeconds` | How long to let it ring before cutting it (default `15`, max `45`). `0` cuts instantly. If you pick up during the ring the bot backs off and sends nothing; if the caller hangs up first they still get the voicemail prompt |
| `handleVideoCalls` / `handleGroupCalls` | Whether those call types are handled too |
| `message` | The voicemail prompt sent to the caller |
| `cooldownMinutes` | Stops repeat callers from being messaged over and over |

### `voicemail`

| Setting | What it does |
| --- | --- |
| `windowMinutes` | How long after a call a voice note still counts as a voicemail |
| `captureAllVoiceNotes` | `true` saves *every* voice note anyone sends, not just post-call ones |
| `greetingAudio` | Optional path to your own recorded greeting, e.g. `"greeting.ogg"`. Use `.ogg`/Opus so WhatsApp plays it as a voice note |
| `confirmation` | Sent back once the voicemail is stored (`{seconds}` works here) |
| `transcribeCommand` | Optional shell command; `{file}` is replaced with the audio path and stdout is stored as the transcript. Example: `whisper {file} --model small --output_format txt --output_dir -` |

### `ai` (only used when `replyMode` is `"ai"`)

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`, then set `"replyMode": "ai"`.

Replies are generated by `claude-opus-5` at `low` effort with a tight instruction set: stay under `maxWords`, never invent prices/commitments/availability, match the contact's language, and offer a voice note for anything detailed. The last `historyTurns` messages of that chat are included so follow-ups make sense. Server-side refusal fallback is enabled, and **any** API failure silently falls back to your keyword rules — the bot never goes quiet because the API had a bad day.

Switch models by editing `ai.model` (e.g. `claude-haiku-4-5` is cheaper and faster if you're replying to a lot of traffic).

### `aiChat` — letting the AI actually hold the conversation

This is a different thing from `replyMode: "ai"`. That one writes a smarter *away message*. This one **chats as you** — back and forth, no cooldown, until you take over.

It is **off by default and opt-in per chat**, because an AI conversing as you with everyone in your contacts is not something to switch on globally by accident.

**To use it:**

1. Put `ANTHROPIC_API_KEY` in `.env`
2. Set `"enabled": true` under `aiChat` in `config.json`, restart
3. **Open the chat you want it to handle** and send `!ai` there. `!ai off` stops it, `!ai list` shows every chat it's active in

| Setting | What it does |
| --- | --- |
| `enabled` | Master switch. Off means `!ai` refuses politely |
| `persona` | Who it should sound like. Rewrite this in your own words — it's the single biggest lever on how it comes across |
| `maxWords` | Length cap per message (default 40 — texts, not essays) |
| `maxTurns` | How many messages it will send in one conversation before stopping and telling you to take over (default 12). Resets when you reply yourself |
| `historyTurns` | How much of the conversation it sees (default 20) |
| `holdSeconds` | Random `[min, max]` pause before replying, so it doesn't answer in 200ms like a machine. You typing cancels the pending reply |
| `handoffNote` | What it sends you when it hits `maxTurns` |
| `backend` | `"api"` uses API credits. `"cli"` shells out to `claude -p` instead — see below |
| `cliCommand` | The command to pipe the prompt into (default `proot-distro login ubuntu -- claude -p`) |
| `cliTimeoutSeconds` | Give up on a stuck CLI after this long (default 120) |

#### Paying with a Claude subscription instead of API credits

Claude Pro/Max plans include a monthly Agent SDK credit that covers the `claude -p` command, so `backend: "cli"` runs the conversation through Claude Code and bills your subscription rather than API credits.

Claude Code has no Android build, so on a phone it needs a glibc userland via proot:

```bash
pkg install -y proot-distro
proot-distro install ubuntu
proot-distro login ubuntu
```

then inside Ubuntu:

```bash
apt update && apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g @anthropic-ai/claude-code
claude          # log in with your Claude account, then exit
```

Set `"backend": "cli"` and restart. Keep the **bot itself in Termux** — `termux-call-log` and `termux-sms-send` don't exist inside proot, so running everything in Ubuntu would cost you missed-call detection and SMS.

The prompt is piped in over **stdin**, never as a shell argument, so nothing a contact sends can be interpreted as shell syntax. A failing or hung CLI returns nothing and the bot stays quiet rather than sending garbage.

Trade-offs: proot adds a few seconds of start-up per reply (hidden by the `holdSeconds` wait anyway), it's another layer for Android to kill, and the credit doesn't roll over month to month.

**What it will not do**, by construction — these are in its instructions:

- invent plans, prices, promises, commitments, whereabouts, or opinions about other people
- decide anything that matters — money, meeting times, anything sensitive — it says it'll check and come back
- agree to send money, share codes or passwords, or confirm personal information, whatever reason is given
- deny being a bot if someone sincerely asks

**Things worth knowing before you leave it running:**

- It's a language model writing as you. It will occasionally say something you wouldn't. `maxTurns` limits the blast radius; the `!ai` opt-in limits who sees it.
- Every reply is an API call, so this costs money per message — unlike everything else here.
- Your contacts don't know. Whether that's fine is a judgement call about the specific person, which is exactly why it's per-chat rather than global.

## Controlling it from your phone

Send these in any WhatsApp chat from your own account — best in your **"Message yourself"** chat, since the bot always answers there:

| Command | Effect |
| --- | --- |
| `!pause` | Stop auto-replying (calls are still logged) |
| `!resume` | Start again |
| `!status` | Mode, counters, uptime |
| `!vm 10` | List the last 10 voicemails |
| `!pending` | Who the bot answered for you that you still haven't replied to |
| `!done` | Clear that waiting list |
| `!help` | Show the list |

Pausing survives restarts.

### Not stepping on your own conversations

By default the bot never answers instantly. A message starts a **5-minute hold**; if you reply yourself in that window the queued message is discarded and the contact never sees an auto-reply at all. Once you've spoken in a chat, the bot then stays out of it for **30 minutes**, so it can't butt in while you're actually talking to someone.

Because a chat you've auto-replied to can look "handled", two things keep it visible:

- `notifyOwner` sends you a note in your own chat — who messaged, what they said — which arrives as a normal WhatsApp notification
- `!pending` lists every chat the bot answered for you that you haven't personally replied to yet, oldest message included, and clears itself the moment you reply to them

## Where things land

```
data/
  auth/                 linked-device session (treat like a password)
  state.json            cooldowns, counters, per-contact history
  bot.log               everything the bot printed
  voicemails/
    index.json                              every voicemail, one array
    2026-09-03_22-14-05_919876543210.ogg    the audio
    2026-09-03_22-14-05_919876543210.json   who, when, how long, transcript
```

`npm run voicemails` prints them all, newest first.

## Voicemail for ordinary phone calls — free, no phone number

Your carrier may not offer voicemail (Jio largely doesn't any more), and buying a telephony number costs money. This route costs nothing and needs no number at all — it uses **your phone's own call log** as the trigger.

```
someone rings your mobile
  → you don't answer
  → Android logs a missed call
  → the bot (running on your phone under Termux) sees it within ~20s
  → it WhatsApps that caller your greeting - including your own recorded
    voice, if you set voicemail.greetingAudio
  → they leave a voice note
  → it lands in data/voicemails/ like any other voicemail
```

It doesn't literally answer the call and talk into the line — nothing free can, and on Android nothing can at all, since call recording has been blocked for third-party apps since Android 10. What it does give you is the thing that actually matters: **every missed call gets your greeting, and you get their recorded message in a file.**

### Setting it up

It only works when the bot runs **on the Android phone itself** — follow *Running it 24/7 on your Android phone* below first, then:

```bash
pkg install termux-api
```

Also install the **Termux:API** app from F-Droid (separate from Termux itself), open it once, and grant it **call log** permission — Android Settings → Apps → Termux:API → Permissions → Call logs.

Check it works:

```bash
termux-call-log -l 5
```

If that prints JSON, you're done — the bot detects it automatically on startup and logs `watching the phone's call log`. If it prints nothing, the permission isn't granted.

### `missedCalls` settings

| Setting | What it does |
| --- | --- |
| `enabled` | `"auto"` (default) turns it on when the call log is readable, `true` forces it and warns if it isn't, `false` disables it |
| `pollSeconds` | How often to check the call log (default 20) |
| `countryCode` | Your country code, used to expand local numbers — `"91"` for India |
| `includeRejected` | Also prompt callers you actively declined, not just unanswered ones |
| `lookbackMinutes` | Ignore calls older than this, so a restart never messages a backlog |
| `notify` | Which channels to use — see below |
| `smsMessage` | The SMS text. `{name}` works. Keep it under 160 characters or it's billed as two |
| `simSlot` | Which SIM to send from on a dual-SIM phone (`0`, `1`); `-1` uses the default |

**`notify` decides who hears from you:**

| Mode | Behaviour |
| --- | --- |
| `"both"` | WhatsApp **and** SMS. Nobody is missed, but people on WhatsApp get two messages |
| `"auto"` | WhatsApp if they have it, SMS if they don't. Everyone gets exactly one message |
| `"whatsapp"` | WhatsApp only — callers without it get nothing |
| `"sms"` | SMS only, no WhatsApp lookup at all |

SMS is what reaches people who don't use WhatsApp — which was the biggest hole in the free setup. It needs **SMS permission** granted to Termux:API (Settings → Apps → Termux:API → Permissions → SMS), on top of the call log permission. Without it the send fails and gets logged; nothing else breaks.

Both channels pass through the same gates: `!pause`, the blocklist, the allowlist, the spam filter and the per-contact cooldown. Blocking someone blocks them everywhere.

**Watch your SMS costs.** WhatsApp messages are free; SMS is not necessarily. On most Jio plans SMS is bundled with a daily cap (commonly 100/day), beyond which it's charged per message. `"auto"` sends far fewer than `"both"`.

Callers who aren't on WhatsApp are skipped automatically, and the spam filter, per-contact cooldown and blocklist all apply exactly as they do for WhatsApp calls.

## Real voicemail that answers the call (paid, needs a number)

Everything above works without answering the call. If you want the phone genuinely picked up — your greeting played down the line, the caller recorded by the network — that needs a telephony number, which means paying for one. This is that setup.

```
someone rings your mobile
  → you don't answer / are busy / are unreachable
  → your carrier forwards the call to your Twilio number
  → Twilio answers and asks this server what to do
  → your recorded greeting plays, then a beep
  → the caller records their message
  → the server downloads it into data/voicemails/, deletes Twilio's copy
```

Phone voicemails land in the **same box** as WhatsApp ones — same folder, same `index.json`, same `npm run voicemails` listing, tagged `phone` vs `whatsapp`.

### Two ways to run it

**A. No server (easier).** Twilio answers the call by itself using two TwiML Bins — snippets of XML that Twilio hosts. Nothing runs on your machine during the call, no tunnel, no public URL, nothing exposed to the internet. A script pulls the recordings down afterwards.

```bash
npm run phone:twiml            # prints the two bins + exactly where to paste them
npm run phone:pull             # fetch new voicemails, then exit
npm run phone:pull -- --watch  # keep checking every 5 minutes
```

Trade-off: recordings arrive when you pull rather than the instant the caller hangs up, and a custom greeting mp3 needs a public URL (the spoken `greetingText` works with no hosting at all).

**B. Webhook server (instant).** `npm run phone` — Twilio calls your server the moment the phone rings, the recording is saved seconds after the caller hangs up, and your own greeting file is served straight from disk. Costs you a public URL (ngrok or a deploy). Setup below.

### Setting up the webhook server

**1. Twilio account.** Sign up at [twilio.com](https://www.twilio.com/try-twilio) (trial credit, no card needed to start), buy a voice-capable number, and copy your Account SID and Auth Token from the console into `.env`:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
```

**2. Make your machine reachable.** Twilio has to reach your server over the public internet. For testing, tunnel it:

```bash
npx ngrok http 3000
```

Copy the `https://....ngrok-free.app` URL into `config.json` as `phone.publicUrl`. It changes every time ngrok restarts — update it when it does, or deploy the server somewhere permanent.

**3. Point the number at it.** In the Twilio console open your number → **Voice → A call comes in** → Webhook, `HTTP POST`:

```
https://your-public-url/voice
```

**4. Run it:**

```bash
npm run phone
```

Call the Twilio number from your phone — it answers, greets, beeps, records, and the file appears in `data/voicemails/`. That works immediately, before any forwarding is set up.

**5. Forward your real number to it.** Dial these from the phone whose calls you want captured (standard GSM codes, work on Jio, Airtel and Vi):

| Code | Forwards when |
| --- | --- |
| `**61*<number>#` | you don't answer |
| `**61*<number>**30#` | you don't answer, after 30 seconds |
| `**67*<number>#` | you're on another call |
| `**62*<number>#` | your phone is off or out of coverage |
| `##002#` | cancels all forwarding |

Use the full international form, e.g. `**61*+12025550147#`. Forwarding an Indian mobile to a US number is billed as an international divert on every forwarded call — for a permanent setup, a +91 number from Twilio (needs a KYC regulatory bundle) or an Indian provider like Exotel is much cheaper.

### `phone` settings

| Setting | What it does |
| --- | --- |
| `port` | Local port the server listens on (default `3000`) |
| `publicUrl` | Your public https URL — used to verify Twilio's signatures *and* to build the greeting URL, so it must be exact |
| `greetingAudio` | Path to **your own recorded greeting**, e.g. `"data/greeting.mp3"`. Leave empty to use text-to-speech |
| `greetingText` | Spoken when no `greetingAudio` is set |
| `greetingVoice` / `greetingLanguage` | Twilio voice, default `Polly.Aditi` / `en-IN` (Indian English) |
| `maxRecordingSeconds` | Longest message you'll accept (default 120) |
| `playBeep` | Beep before recording starts |
| `rejectAnonymous` | Reject callers with no caller ID |
| `deleteFromTwilio` | Delete Twilio's copy once yours is saved — keeps recordings off their servers and avoids storage charges |
| `blocklist` | Numbers to reject outright, any formatting |
| `pullEveryMinutes` | How often `phone:pull --watch` checks Twilio (default 5) |

To use your own voice, record a greeting, save it as `data/greeting.mp3`, and set `greetingAudio`. Transcription uses the same `voicemail.transcribeCommand` hook as WhatsApp, so both channels transcribe the same way.

**Security:** every webhook is verified against Twilio's request signature using your auth token, so a stranger who finds your public URL can't post fake recordings. `--insecure` disables that for local curl testing only — never run it exposed.

## Keeping it running

The bot only works while the process is alive. On a PC, either leave the terminal open or use a process manager:

```bash
npm install -g pm2
pm2 start src/index.js --name whatsapp-bot
pm2 save
pm2 logs whatsapp-bot
```

## Running it 24/7 on your Android phone

The bot is plain Node.js, so it runs on the phone itself under **Termux**. The phone then needs no PC at all.

**1. Install Termux from [F-Droid](https://f-droid.org/packages/com.termux/)** — not the Play Store version, which is abandoned and won't install packages. Install the **Termux:Boot** addon from F-Droid too if you want it to survive reboots.

**2. Set up Node:**

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs-lts
```

**3. Get this folder onto the phone.** Copy the `Auto-Reply` folder (you can skip `node_modules` and `data/auth`) to the phone's Download folder, then:

```bash
termux-setup-storage          # grant storage access when Android asks
cp -r ~/storage/downloads/Auto-Reply ~/
cd ~/Auto-Reply
npm install
```

**4. Link it.** You can't scan your own screen, so use the pairing code:

```bash
node src/index.js --pair 911234567890
```

Enter the printed code in **WhatsApp → Linked devices → Link with phone number**. Only needed once — the session is saved in `data/auth/`.

**5. Stop Android from killing it.** This is the part that actually decides whether it survives:

- **Settings → Apps → Termux → Battery → Unrestricted** (wording varies by phone; on Xiaomi/Realme/Oppo/Vivo also turn on "Autostart" and lock Termux in the recent-apps switcher)
- In Termux, run `termux-wake-lock` before starting the bot — this keeps the CPU awake while the screen is off

**6. Run it so it survives closing Termux:**

```bash
pkg install -y tmux
termux-wake-lock
tmux new -s bot          # start a named session
npm start                # scan/pair, watch it connect
# press Ctrl+B then D to detach - the bot keeps running
```

Come back to it any time with `tmux attach -t bot`.

**7. Auto-start on reboot** (needs Termux:Boot installed and opened once):

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/whatsapp-bot <<'SH'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd ~/Auto-Reply && node src/index.js >> ~/bot-boot.log 2>&1
SH
chmod +x ~/.termux/boot/whatsapp-bot
```

**Honest expectations:** this works, and plenty of people run bots this way. But Android is aggressive about background processes, and manufacturer battery managers (especially Xiaomi, Oppo, Vivo, Samsung) will still kill Termux eventually on some devices. If it must never miss a message, an always-on PC or a $4/month VPS is the reliable option — same commands, no battery manager fighting you. Also note WhatsApp expires a linked device that hasn't seen its primary phone in about 14 days, so keep WhatsApp itself working on that phone.

## Troubleshooting

**QR won't scan** — widen the terminal window; the code needs the full width.

**"This device was unlinked"** — you (or WhatsApp) removed the linked device. `npm run logout`, then `npm start` and scan again.

**Connection keeps closing and reopening** — normal right after the first scan (WhatsApp forces one restart), and the bot reconnects on its own with backoff. Set `BAILEYS_LOG_LEVEL=debug` in `.env` to see the protocol chatter.

**Replies aren't going out** — the console prints the reason for every skipped message (`cooldown`, `group chat`, `daily reply cap reached`, `bot is paused`, …).

**Nothing happens on calls** — the caller must be an individual contact; group calls are off by default. Check the console shows `INCOMING voice call`.

## Worth knowing

This uses Baileys, an unofficial reimplementation of the WhatsApp Web protocol — it is not endorsed by WhatsApp, and automating an account carries a real (if small) ban risk. The defaults are deliberately conservative: one reply per contact per hour, five a day, randomised typing delays, groups ignored, never marks you online. Don't point it at bulk or cold outreach — that's what gets numbers banned, and it's against WhatsApp's terms. For a business use case at scale, the sanctioned route is the WhatsApp Business Cloud API.

Also: recording someone's voice is regulated in a lot of places. The voicemail prompt tells callers plainly that they're leaving a recorded message, which is the honest default — keep it that way.
