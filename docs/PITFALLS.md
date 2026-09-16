# Pitfalls

Everything here cost real time or real visibility while this was running live.
They share a shape: **the monitor looks fine and is not actually watching.** That
is the failure mode to fear, because it is indistinguishable from "no tickets
yet" until you go and check.

---

## "It says no seats" — but there were seats

**A 403 makes live seats look like NO seats.** When bot clearance lapses the API
returns `403`, `picks` comes back undefined, and the detection function returns
false. The log shows `p=err403`, not `p=0`.

```
q1[p=0     r=skip]   <- genuinely no seats
q1[p=err403 r=skip]  <- BLIND. Says nothing about availability.
```

Never read a stretch of 403s as "nothing was available". The script self-heals by
forcing a page reload on the next poll, normally clearing within 60–130 seconds,
but anything opening inside that gap is missed.

**Do not try to fix 403s by raising `POLL_MS`.** They are not a request-volume
budget — they appeared at ~360, ~180, ~120 and ~60 requests/hour alike. Raising
the interval also stretches `RELOAD_EVERY`, which is counted in *polls*, so it
makes recovery **slower**. A wrong fix that feels right.

## The process says `online` but nothing is being watched

Chromium can die independently of the Node process. The old code called
`page.goto()` on the dead page, the throw was swallowed, the failure counter
reset, and it span blind forever — while pm2 cheerfully reported `online`.

Fixed: it now relaunches the browser on first sighting. But the lesson stands —
**`pm2 list` showing `online` is not evidence that anything is being watched.**
Check the log is still moving:

```bash
pm2 logs tm-watch --lines 5 --nostream
```

A healthy log writes at least every ~5 polls. Silence for more than ~9 minutes
means wedged, not quiet.

## Restarting twice in quick succession kills the browser

Leave **at least two minutes** between `pm2` restarts. The previous Chromium may
not have finished exiting, and the new instance attaches to a dying context. This
is how the bug above was discovered.

## Your config change did not apply

**`pm2 restart <name> --update-env` does NOT re-read `ecosystem.config.js`.** It
refreshes the environment from your calling shell, silently ignoring your edits —
and a following `pm2 save` then bakes the *stale* environment into `dump.pm2`, so
it survives reboots too.

```bash
pm2 delete tm-watch && pm2 start ecosystem.config.js && pm2 save
```

Verify by the `Poll ~Ns` banner in the log and the gap between timestamps. **Never
verify by the absence of an error.**

## Email reports `DISABLED`

Almost always the password file is misnamed. On Windows, Notepad appends `.txt`
unless you type the filename **in quotes**, so you get `.tm-watch-smtp.txt`.

The startup line prints the character count — it should say **16**. Look for
`SMTP handshake OK`, which means Google actually accepted the credentials. A
missing handshake line means email will fail silently during the one window that
matters.

## It survived a reboot — but only once someone logged in

`pm2-windows-startup` registers an `HKCU\...\Run` entry, which fires at
**interactive logon, not at boot**. And since `HEADLESS=false` is mandatory, a
desktop session is required anyway.

So: a machine that reboots overnight and sits at the lock screen is **not
monitoring**, and nothing will tell you. This cost 4h56m of blindness when
Windows Update forced a 03:24 restart. If you are running this over a critical
window, pause OS updates and stay logged in.

## Nothing alerts you when the monitor itself dies

There is no dead-man's switch, and an on-machine one cannot work — the machine is
the thing that would be off. The hourly heartbeat is proof of life only if you
notice its **absence**.

If you need real coverage, point an external service (healthchecks.io and similar
have free tiers) at a ping from the poll loop, so *they* alert you when the pings
stop. That is the only design that survives the machine being off.

## The price looks too cheap to be real

It probably is. The API is queried with `sort=price`, so a pick describes the
**cheapest offer on that seat, not the seat**. A pick carrying four `offerIds` has
four price types.

A seat reported here as a **$66 "Junior 4-14 Years"** was bought as an **adult
ticket for $226.95** — same section, same row, same seat. The alert says
`from $X — cheapest of N ticket types` for exactly this reason. **Do not dismiss
a seat because the ticket type looks wrong for you.**

## A "window closed" message is not a lost cart

Once seats are in your cart, Ticketmaster holds them ~10–15 minutes independently
of whether they still appear in search. The window closing means they left the
*listings*, not your cart. Finish checkout at your own pace.

## If you have Claude watch the log, make it quiet

Every notification a background watcher sends re-sends your whole conversation to
the model. A watcher reporting routine, self-healing 403s fired roughly **48 times
a day** here for events that never needed a human.

Report only what needs a person: seats, a window closing, an error that
**outlasts** its remedy, a stale log, a dead process. Say nothing for a 403 that
clears in a minute. See [CLAUDE_WORKFLOW.md](CLAUDE_WORKFLOW.md) rule 6.

## Do not "simplify" the browser away

`curl`/`axios` get `403 {"response":"block"}`; datacenter IPs get a TLS reset.
Headless Chromium gets served a challenge page and, in testing, never recovered.
The visible browser window driving an in-page `fetch` is the whole mechanism, not
an implementation detail.
