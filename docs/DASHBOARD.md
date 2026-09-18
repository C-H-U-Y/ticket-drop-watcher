# Optional: reporting to a dashboard

Everything in this repo works without a dashboard. `EVENT_ID=<id> node src/tm-watch.js`
polls, alerts and logs exactly as it did on the night it caught the seat, and nothing
leaves your machine except the calls to Ticketmaster and, if you set them up, ntfy and
Gmail.

This document covers the one optional addition: running the same script in **managed
mode**, where a small web dashboard holds the monitor's configuration and the runner
reports each poll cycle back to it. Skip it if you just want the alert.

## What it is

Two pieces, on two different machines.

| Piece | Where it runs | What it does |
|---|---|---|
| **Runner** (this repo) | Your own computer, visible Chromium window | Polls Ticketmaster, raises the alert, and in managed mode posts a one line summary of each cycle to the dashboard |
| **Dashboard** (separate project, not in this repo) | A Cloudflare Worker with a MongoDB Atlas database behind it | Stores monitors, pulses, windows and alerts. Shows Live, Silent, windows caught and request budget. Lets the owner deactivate and reactivate a monitor. Sends the ntfy push |

The polling never moves. Ticketmaster resets TLS from datacenter addresses and serves
headless browsers a challenge page, so the dashboard cannot poll for you. It only records
what your runner tells it.

## Credentials: what lives where

This is the part people ask about first.

- **You need no database and no database credentials on your machine.** The runner never
  connects to MongoDB. It speaks HTTPS to one endpoint on the dashboard.
- The runner holds exactly two values: a **monitor id** and a **runner token**. Both are
  generated when the monitor is created and shown once on the monitor's page to its owner.
  The token authorises posting to that one monitor and nothing else. Treat it like an ntfy
  topic: private, but low blast radius. If it leaks, deactivate the monitor.
- The dashboard's MongoDB connection string is a secret on the Worker. It is never sent to
  a runner, never in a response, never in this repo.
- Nothing from the Ticketmaster session leaves your machine. No cookies, no page content,
  no bot clearance. See "What is posted" below.

## Running in managed mode

Create the monitor on the dashboard (event URL, quantities, poll interval, ntfy topic). It
prints the command. In this clone:

```bash
node src/tm-watch.js --monitor <id> --token <token> --api <dashboard origin>
```

or with pm2, `args: '--monitor <id> --token <token> --api <origin>'` in
`ecosystem.config.js` (see the commented block in `ecosystem.config.example.js`).

The three flags are also read from the environment as `MONITOR_ID`, `RUNNER_TOKEN` and
`API_ORIGIN`. When `--monitor` is absent the script runs in the original env var mode and
none of the code in this document executes.

In managed mode the runner:

1. Calls `hello` and takes its configuration from the dashboard: event id, quantities, poll
   interval, ntfy topic. `EVENT_ID` on the command line is not needed. `RELOAD_EVERY` is
   derived so that reload times poll stays near thirty minutes. Headless is off by default.
2. Posts `start`, so the dashboard shows "Runner started".
3. After every check, posts one `pulse`. Posting is fire and forget with a ten second
   timeout. A slow or unreachable dashboard never delays or stops the poll loop. Outages
   are logged once per streak.
4. On a `410` (the owner pressed Deactivate) it closes the browser, stops calling
   Ticketmaster, and asks the dashboard every five minutes whether it is back on. On
   reactivation it re-reads the config, relaunches and resumes.
5. On a `401` (wrong id or token) it stops with a clear message.

## What is posted

One JSON object per cycle to `POST {api}/api/pulse`:

```json
{
  "monitorId": "…", "token": "…", "kind": "pulse",
  "q": { "1": { "p": 0, "r": null }, "2": { "p": 1, "r": null } },
  "resaleEnabled": false,
  "hit": true,
  "seats": ["PRIMARY BAY5A row C, 1 seat, $226.95, Adult"]
}
```

`p` and `r` are the number of picks the primary and resale searches returned for that
quantity, `null` on an HTTP error or when resale was skipped. `seats` is the alert text's
seat lines, only on a hit. That is the entire payload. `hello` and `start` carry only the
id, the token and the poll interval.

## Code map

Kept deliberately separate so the addition can be read, reviewed or removed on its own.

- `src/control.js`: the whole protocol. Ninety lines, no dependencies. `parseArgs`,
  `hello`, `start`, `pulse`, and the `Inactive` and `Rejected` error classes.
- `src/tm-watch.js`: four fenced blocks, each marked `Optional: dashboard reporting`, each
  a no-op unless `--monitor` is given: the flag parse at the top, `applyConfig`, the
  `hello`/`start` bootstrap and `report()` in the main function, and the idle block at the
  top of the poll loop.

Removing the feature is deleting `src/control.js` and those four blocks. The original
script is the result.

## The dashboard itself

The dashboard is a separate project and is not published with this repo yet. It was built
on 17 September 2026 at a MongoDB build night as a TanStack Start app on Cloudflare
Workers with MongoDB Atlas, Clerk for sign-in and ntfy for push. If you want to run your
own, the runner only needs an origin that answers `POST /api/pulse` with the three kinds
above; the `--api` flag points it there.

Legal note, same as the README: monitoring is not purchase, so this sits outside the NSW
and WA anti-scalping software provisions. It does sit against Ticketmaster's terms on
request rate, which is why the dashboard refuses to create monitors above 1,000 requests a
day and shows the day's count. The proper fix is Ticketmaster's Inventory Status API,
which would replace polling with an official feed.
