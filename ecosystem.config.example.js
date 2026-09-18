// pm2 process definition. Copy to `ecosystem.config.js` and fill in your values.
// The real file is gitignored, so your event id and contact details stay local.
//
//   cp ecosystem.config.example.js ecosystem.config.js
//   pm2 start ecosystem.config.js && pm2 save
//
// To CHANGE any value later, you must delete and re-start. `pm2 restart
// --update-env` does NOT re-read this file -- it refreshes env from the calling
// shell, silently ignoring your edits, and a following `pm2 save` then bakes the
// STALE env into dump.pm2. Correct sequence:
//
//   pm2 delete tm-watch && pm2 start ecosystem.config.js && pm2 save
//
// Verify by the "Poll ~Ns" banner in the logs, never by absence of an error.
//
// MANAGED MODE (monitor created on the Seat watch dashboard). The dashboard
// holds EVENT_ID, QTYS, POLL_MS and NTFY_TOPIC, so none of the env block below
// is needed. Replace the app entry with this one, pasting the id and token the
// dashboard shows. The runner still runs here, on your own machine, in a
// visible Chromium window; the dashboard only records what it reports.
//
//   {
//     name: 'tm-watch',
//     script: 'src/tm-watch.js',
//     args: '--monitor ID --token TOKEN --api https://seatwatch.archie-huybers.workers.dev',
//     cwd: __dirname,
//     autorestart: true,
//     restart_delay: 20000,
//     max_restarts: 100,
//     min_uptime: 60000,
//     merge_logs: true,
//   },

module.exports = {
  apps: [
    {
      name: 'tm-watch',
      script: 'src/tm-watch.js',
      cwd: __dirname,
      env: {
        // The hex id from the event page URL, e.g.
        // https://www.ticketmaster.com.au/event/1A00612F1B0C4B5E
        EVENT_ID: 'PUT_YOUR_EVENT_ID_HERE',

        // Non-AU users: change the base, e.g. https://www.ticketmaster.com/event/
        // EVENT_BASE_URL: 'https://www.ticketmaster.com.au/event/',

        // Poll interval. 60s is a deliberate floor -- see README "Tuning".
        // Raising it does NOT reduce bot-clearance 403s, and it slows recovery.
        POLL_MS: '60000',

        // Full page reload every N POLLS (not minutes). The reload is what
        // refreshes bot clearance. RULE: keep RELOAD_EVERY x POLL_MS ~= 30 min.
        RELOAD_EVERY: '30',

        // MUST be false. Headless gets served a challenge page and never
        // recovers -- see README "Things that are not optional".
        HEADLESS: 'false',

        // Quantities to search, as INDEPENDENT searches. Keep all three:
        // Ticketmaster's restrictSingleSeats refuses to orphan a seat, so a
        // qty=1 search returns empty even when a pair is sitting there.
        QTYS: '1,2,3',

        // --- optional: phone push via ntfy.sh (free, no account) -------------
        // Generate a RANDOM topic and keep it private: anyone who knows the
        // string can read your alerts and post to them.
        //   NTFY_TOPIC: 'tickets-<paste-random-hex-here>',

        // --- optional: email via Gmail SMTP (recommended) --------------------
        // See docs/GMAIL_SETUP.md. The app password is NOT set here -- it is
        // read from ~/.tm-watch-smtp so it never reaches git or `pm2 env`.
        //   SMTP_USER: 'you@gmail.com',
        //   ALERT_TO:  'you@gmail.com',
      },
      autorestart: true,
      restart_delay: 20000, // don't hammer the site if it crash-loops
      max_restarts: 100,
      min_uptime: 60000,
      merge_logs: true,
    },
  ],
};
