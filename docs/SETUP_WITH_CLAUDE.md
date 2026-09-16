# Setting it up with Claude Code

This repo was built with [Claude Code](https://claude.com/claude-code), and the
fastest way to point it at *your* event is to let Claude do the wiring.

Clone the repo, `cd` into it, run `claude`, and paste the prompt below.

## The prompt

````text
Set this ticket monitor up for me end to end.

My event: <PASTE THE TICKETMASTER EVENT URL>
Alert me by: desktop + email      (or: desktop only / + phone push)
My email:    <you@gmail.com>      (omit this line if you don't want email)

Please:
1. Read README.md first, especially "Things that are not optional" — do not
   change HEADLESS, QTYS, or lower POLL_MS below 60s, and tell me if you think
   something there is wrong rather than silently working around it.
2. Install dependencies and the Chromium build Playwright needs.
3. Pull the EVENT_ID out of my URL and write ecosystem.config.js from
   ecosystem.config.example.js. Never commit that file.
4. If I asked for email, walk me through docs/GMAIL_SETUP.md. I will create the
   app password myself — do not ask me to paste it to you, and do not read the
   file back. Just tell me where to put it and confirm the char count is 16.
5. Run the alert test and show me the output. Do not tell me it works until you
   have seen "SMTP handshake OK" (if email) and I have confirmed the desktop
   toast actually appeared.
6. Start it under pm2, save the process list, and confirm you have seen at
   least TWO clean polls about a minute apart before you call it done.
7. Tell me plainly what is NOT covered — in particular what happens if the
   machine reboots or sleeps.
````

## Why hand it to Claude rather than following steps yourself

The install is easy. What is not easy is the failure modes, and those are where
an unattended monitor quietly stops being a monitor:

- a first page load that gets a challenge instead of the event page, which
  poisons the whole run until something forces a reload
- an app-password file that Windows silently renamed to `.txt`
- `pm2 restart --update-env`, which ignores your edited config file and then
  bakes the stale environment into `dump.pm2` on the next save
- a config that looks applied but is not, because nobody checked the banner

Every one of those looks *exactly* like "no tickets available yet". The prompt
above makes Claude verify each one against real output instead of assuming.

## Running it day to day with Claude

Claude is useful for watching the monitor, not just installing it. Ask it to:

```text
Set up a persistent watcher on the tm-watch pm2 log. Report only TRANSITIONS:
when seats open, when a window closes, when it goes blind on 403s, when the log
goes stale, and if the process dies. Match on the p= values, not on literal log
text.
```

Two hard-won rules are in that prompt, and both cost real information when they
were got wrong:

1. **Transitions, not states.** A watcher that reports every poll is noise you
   will learn to ignore.
2. **Never match the log text literally, and never alert only on availability.**
   A watcher keyed on the exact string `r=0` stopped detecting anything the
   moment a change made it print `r=skip` — it failed silently, which is the
   worst way to fail. Alerting only on "available" also makes a window *closing*
   invisible, so you never learn how long you had.

A Claude-side watcher lives and dies with the session. The monitor itself does
not — under pm2 the beeps, toast, browser tab and email all keep running
regardless of whether anyone is watching the terminal.

## If you would rather not use Claude

Everything above is just the README steps done carefully. See
**Quick start** in [../README.md](../README.md).
