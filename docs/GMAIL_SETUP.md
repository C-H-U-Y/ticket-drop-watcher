# Email alerts via Gmail (recommended)

Desktop alerts only help if you are at the desk. Email is what reaches you when
you are not — and in practice that is most of the day.

It takes about five minutes.

## Why not just use the phone push?

You can, and the script supports it (`NTFY_TOPIC`, free, no account). But push
via ntfy.sh is best-effort, and its email feature is paid — worse, setting an
Email header without a paid account makes the whole request fail with
`40053 anonymous email sending is not allowed`, which silently kills the push
too. So: ntfy for push, Gmail SMTP for email. They are independent.

## 1. Turn on 2-Step Verification

Google only issues app passwords to accounts that have it.

<https://myaccount.google.com/security> → **2-Step Verification** → follow the
prompts. If it is already on, skip this.

## 2. Create an app password

<https://myaccount.google.com/apppasswords>

Name it anything (`tm-watch`). Google shows a **16-character** password as four
blocks of four, like `abcd efgh ijkl mnop`. You only see it once.

> An app password bypasses 2FA for that one application. Treat it like a
> password, revoke it when you are done, and never paste it into a config file
> or a chat window.

## 3. Save it OUTSIDE the repo

The script reads the password from a file in your home directory, deliberately —
never from an env var, a config file, or source. That keeps it out of git, out
of `pm2 env`, and out of any terminal transcript.

**macOS / Linux:**
```bash
printf '%s' 'abcdefghijklmnop' > ~/.tm-watch-smtp
chmod 600 ~/.tm-watch-smtp
```

**Windows (PowerShell):**
```powershell
'abcdefghijklmnop' | Out-File -NoNewline -Encoding ascii "$HOME\.tm-watch-smtp"
```

Spaces are stripped on read, so pasting Google's four-block format verbatim is
fine.

> **Windows gotcha:** if you create this file in Notepad, it appends `.txt`
> unless you type the filename **in quotes**. A file called
> `.tm-watch-smtp.txt` will not be found and email will report `DISABLED`.
> That is the first thing to check.

## 4. Point the script at your account

In `ecosystem.config.js` (or as env vars):

```js
SMTP_USER: 'you@gmail.com',   // the account the app password belongs to
ALERT_TO:  'you@gmail.com',   // where alerts go; defaults to SMTP_USER
```

## 5. Verify before you rely on it

```bash
EVENT_ID=<id> npm run test-alerts
```

Look for these two lines:

```
Email: enabled -> you@gmail.com (16-char app password loaded)
SMTP handshake OK
```

`SMTP handshake OK` means Google actually accepted the credentials. The startup
banner prints the **character count** — it should say 16 — as a sanity check
that never reveals the password itself.

If you see `DISABLED: no file at ...`, the file is missing or misnamed (see the
Notepad gotcha). If you see `SMTP HANDSHAKE FAILED`, the password is wrong or
2-Step Verification is not enabled on that account.

The test also sends a sample alert body so you can see the real format —
section, row, seat, count, price and ticket type — before a live one arrives.

## One thing email will not do

It will not override Do Not Disturb on your phone. If you want it to wake you,
add a Gmail **VIP / priority** rule on the subject `SEATS AVAILABLE`.

## Verified behaviour

- **One email per window**, not per poll. A window that stays open for an hour
  sends one email, not sixty. A *new* window sends a fresh one.
- Credentials are checked at startup, so a bad password surfaces immediately
  rather than during the thirty seconds that actually matter.
