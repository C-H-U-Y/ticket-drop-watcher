/**
 * tm-watch.js - Ticketmaster availability monitor
 *
 * Watches a sold-out event and alerts a human the moment seats reappear.
 * It never buys, never adds to cart, and never touches checkout - see the
 * "Scope and conduct" section of the README.
 *
 * WHY THIS SHAPE:
 *   Ticketmaster has no public availability API and blocks plain HTTP clients
 *   (curl from a server gets {"response":"block"} / connection reset). The
 *   page's own XHR works fine, so this drives a real browser and calls the API
 *   from inside the page, reusing its cookies and bot clearance.
 *
 * WHAT IT WATCHES:
 *   /api/quickpicks/<eventId>/list  -> { quantity, total, picks: [...] }
 *   Empty picks = nothing available. Non-empty = a human should look now.
 *   It watches PRIMARY inventory - held and abandoned-cart seats being released
 *   back into the normal buy flow - and also RESALE if the promoter enables it.
 *
 * QUICK START:  see README.md
 *   npm install && npx playwright install chromium
 *   EVENT_ID=<id> node tm-watch.js --test   <- confirm alerts fire
 *   EVENT_ID=<id> node tm-watch.js          <- start watching
 */

const { chromium } = require('playwright');
const { exec } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

// ----------------------------- config ---------------------------------------
const EVENT_ID = process.env.EVENT_ID || '';
if (!EVENT_ID) {
  console.error('Set EVENT_ID to the Ticketmaster event id (the hex string in the');
  console.error('event page URL), e.g.  EVENT_ID=1A00612F1B0C4B5E node tm-watch.js');
  process.exit(1);
}
const EVENT_URL =
  (process.env.EVENT_BASE_URL || 'https://www.ticketmaster.com.au/event/') + EVENT_ID;

const QTYS           = (process.env.QTYS || '1,2,3').split(',').map(Number);
const POLL_MS        = Number(process.env.POLL_MS || 15000); // base interval (~15s)
const JITTER_MS      = 6000;    // random extra, so the pattern isn't robotic
// Full page reload every N polls. This is what refreshes Ticketmaster's bot
// clearance, so it must be measured in MINUTES, not polls: at the original
// POLL_MS=15000 it meant 7.5 min, but at POLL_MS=180000 the same 30 becomes
// NINETY minutes, which is far past the point where the API starts 403ing.
// Keep RELOAD_EVERY * POLL_MS at roughly 30 minutes.
const RELOAD_EVERY   = Number(process.env.RELOAD_EVERY || 30);
const HEADLESS       = process.env.HEADLESS !== 'false'; // HEADLESS=false to watch it
const OPEN_ON_HIT    = process.env.OPEN_ON_HIT !== 'false';
const PROFILE_DIR    = path.join(os.homedir(), '.tm-watch-profile');

// --- phone push (ntfy.sh) ---------------------------------------------------
// Install the free "ntfy" app (iOS/Android), tap +, and subscribe to EXACTLY
// a topic string of your own. No account, no signup. ANYONE who knows the
// topic can read it and post to it, so generate a random one and keep it
// private - never commit it. See README.
// Then run `node tm-watch.js --test` to confirm the push lands on your phone.
const NTFY_TOPIC     = process.env.NTFY_TOPIC || ''; // unset = phone push disabled

// --- email alerts, via Gmail SMTP -------------------------------------------
// NOT via ntfy: ntfy.sh charges for email (`40053 anonymous email sending is
// not allowed`) and, worse, attaching an Email header without a paid account
// 400s the entire POST and silently kills the push too.
//
// The app password is read from a FILE, never from an env var or this source,
// so it stays out of git, out of `pm2 env`, and out of any transcript. Gmail
// displays app passwords in four blocks of four; whitespace is stripped so
// pasting it verbatim works either way.
const SMTP_USER      = process.env.SMTP_USER || ''; // unset = email disabled
const SMTP_PASS_FILE = process.env.SMTP_PASS_FILE || path.join(os.homedir(), '.tm-watch-smtp');
const ALERT_TO       = process.env.ALERT_TO || SMTP_USER;

let mailer = null;
let mailerStatus = '';
try {
  const pass = fs.readFileSync(SMTP_PASS_FILE, 'utf8').replace(/\s+/g, '');
  if (pass.length < 8) throw new Error(`file is empty or too short (${pass.length} chars)`);
  mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass } });
  mailerStatus = `enabled -> ${ALERT_TO} (${pass.length}-char app password loaded)`;
} catch (e) {
  mailerStatus = `DISABLED: ${e.code === 'ENOENT' ? `no file at ${SMTP_PASS_FILE}` : e.message}`;
}

// Send a quiet "still alive" ping every N minutes so a silent monitor never
// means a dead monitor. 0 disables.
const HEARTBEAT_MIN  = Number(process.env.HEARTBEAT_MIN || 60);

// ----------------------------- helpers --------------------------------------
const ts = () => new Date().toLocaleTimeString('en-AU', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psEscape = (s) => String(s).replace(/'/g, "''");

function notify(title, body) {
  if (process.platform === 'win32') {
    const ps = `
      [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
      $t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
      $n=$t.GetElementsByTagName('text'); $n.Item(0).AppendChild($t.CreateTextNode('${psEscape(title)}'))>$null
      $n.Item(1).AppendChild($t.CreateTextNode('${psEscape(body)}'))>$null
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('tm-watch').Show([Windows.UI.Notifications.ToastNotification]::new($t))
      1..6 | ForEach-Object { [console]::beep(1200,300); Start-Sleep -Milliseconds 120 }`;
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, () => {});
  } else if (process.platform === 'darwin') {
    exec(`osascript -e 'display notification "${body}" with title "${title}" sound name "Glass"'`, () => {});
  } else {
    exec(`notify-send "${title}" "${body}"`, () => {});
    process.stdout.write('\x07\x07\x07');
  }
  push(title, body, 'urgent', 'rotating_light');
}

// Send one email. Returns a promise so --test can await delivery rather than
// exiting mid-flight. Callers decide WHEN; this does not throttle itself.
function sendEmail(subject, body) {
  if (!mailer) return Promise.resolve();
  return mailer
    .sendMail({
      from: `tm-watch <${SMTP_USER}>`,
      to: ALERT_TO,
      subject,
      text: `${body}\n\nBuy here:\n${EVENT_URL}\n\nCart holds ~10-15 min once you add a seat.`,
    })
    .then(() => log(`EMAIL SENT -> ${ALERT_TO}`))
    .catch((e) => log('EMAIL FAILED:', e.message));
}

function push(title, body, priority = 'default', tags = 'eyes') {
  if (!NTFY_TOPIC) return Promise.resolve();
  return fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: priority,   // 'urgent' bypasses your phone's silent/DND
      Tags: tags,
      Click: EVENT_URL,     // tapping the notification opens the ticket page
    },
    body,
  })
    .then((r) => log(`ntfy -> ${r.status === 200 ? 'ok' : 'HTTP ' + r.status}`))
    .catch((e) => log('ntfy failed:', e.message));
}

// Open the event page for a human to buy on. On Windows this deliberately does
// NOT use ShellExecute (`start "" <url>`): that spawned a brand-new Edge window
// on every single alert -- reported 2026-09-16, "heaps of new edge windows" --
// and a fresh window can also land on a different virtual desktop from the rest
// of the project, which is the opposite of helpful when you are trying to buy in
// a hurry.
//
// Instead, hand the URL to an ALREADY-RUNNING Edge/Chrome executable. A Chromium
// browser given a URL on the command line routes it to its existing process and
// opens a new TAB in the current window, which keeps it on whatever virtual
// desktop that window already lives on. Only if no browser is running at all do
// we fall back to letting Windows launch the default one.
function openInBrowser(url) {
  if (process.platform === 'darwin') return exec(`open "${url}"`, () => {});
  if (process.platform !== 'win32') return exec(`xdg-open "${url}"`, () => {});

  // Prefer a browser that actually has a visible window (MainWindowHandle != 0),
  // so we target a real window rather than a background/updater process.
  // Order matters: Edge FIRST, because that is the default browser here and so
  // the one that already holds the project's windows. Picking by oldest start
  // time instead would have handed the URL to Chrome, on another desktop.
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$b=$null;",
    "foreach($n in 'msedge','chrome','brave'){",
    "  $c=Get-Process $n | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path } | Select-Object -First 1;",
    "  if($c){ $b=$c; break }",
    "}",
    "if ($b) { Start-Process -FilePath $b.Path -ArgumentList '" + url + "' }",
    "else { Start-Process '" + url + "' }",
  ].join(' ');
  exec(`powershell -NoProfile -WindowStyle Hidden -Command "${ps.replace(/"/g, '\\"')}"`, () => {});
}

// ----------------------------- the check ------------------------------------
async function checkOnce(page, qtys, checkResale) {
  return page.evaluate(async ({ eventId, qtys, checkResale }) => {
    const call = async (qty, extra) => {
      const u = `/api/quickpicks/${eventId}/list?sort=price&offset=0&qty=${qty}` +
                `&defaultToOne=true&resaleProvider=INTL` + extra;
      const r = await fetch(u, { headers: { Accept: 'application/json' } });
      if (!r.ok) return { error: r.status };
      return r.json();
    };
    const results = {};
    for (const qty of qtys) {
      // Resale is skipped while the page's own resaleEnabled flag reads false.
      // That flag is re-read from the HTML every cycle at zero request cost, so
      // if the AFL ever switches resale on we resume querying it the very next
      // poll. Halves requests per cycle from 6 to 3. QTYS is untouched.
      const [primary, resale] = await Promise.all([
        call(qty, '&primary=true&resale=false'),
        checkResale ? call(qty, '&primary=false&resale=true')
                    : Promise.resolve({ skipped: true }),
      ]);
      results[qty] = { primary, resale };
    }
    // also re-read the page's own resale switch, in case the promoter turns it on
    const html = document.documentElement.innerHTML;
    const on  = html.includes('resaleEnabledtrue');
    const off = html.includes('resaleEnabledfalse');
    return { results, resaleEnabled: on ? true : (off ? false : null) };
  }, { eventId: EVENT_ID, qtys, checkResale });
}

const count = (r) =>
  r && r.skipped ? 'skip'
  : r && Array.isArray(r.picks) ? r.picks.length
  : (r && r.error ? `err${r.error}` : '?');

function summarise(res) {
  const parts = Object.entries(res.results).map(
    ([qty, r]) => `q${qty}[p=${count(r.primary)} r=${count(r.resale)}]`
  );
  return `${parts.join(' ')} resaleEnabled=${res.resaleEnabled}`;
}

function hit(res) {
  const has = (r) => r && Array.isArray(r.picks) && r.picks.length > 0;
  return Object.values(res.results).some((r) => has(r.primary) || has(r.resale));
}

// --- price extraction -------------------------------------------------------
// The alert used to render "$?" because it guessed three field names --
// totalPrice / price / offers[0].listPrice -- and on 2026-09-15 every one came
// back undefined on a real pick. Guessing a fourth name blind would just fail
// again, so instead: walk the WHOLE pick object and take any numeric leaf whose
// path looks price-ish. Handles dollars, "$220.00" strings, integer cents, and
// the {amount, currency} wrapper, at any nesting depth.
//
// Deliberately NOT done: mapping bay number -> price tier. SCG face value is
// $220/$168/$129/$65 by level, but the bay->level mapping is not verified, and
// a confidently WRONG price is worse than no price when someone is deciding
// whether to buy. The face-value range goes in the email as labelled context.
const PRICE_MIN = 20;    // below this it is a booking fee or a count
const PRICE_MAX = 1000;  // above this it is cents-as-dollars, or an id

// Collect every scalar leaf with its full path, so the decision can be made on
// the path rather than on a single hard-coded key name.
function scalarLeaves(node, path = '', depth = 0, out = []) {
  if (node == null || depth > 6) return out;
  if (typeof node === 'number' || typeof node === 'string') {
    out.push({ path, raw: node });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => scalarLeaves(v, `${path}[${i}]`, depth + 1, out));
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      scalarLeaves(v, path ? `${path}.${k}` : k, depth + 1, out);
    }
  }
  return out;
}

function extractPrice(pick) {
  const cands = [];
  for (const { path, raw } of scalarLeaves(pick)) {
    if (!/price|amount|cost|charge|face|total/i.test(path)) continue;
    // Reject the near-misses that would otherwise pass the range check.
    if (/qty|quantity|count|num|size|index|\bid\b|Id\b/i.test(path)) continue;
    let n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.]/g, ''));
    if (!isFinite(n) || n <= 0) continue;
    let cents = false;
    // Integer cents: 22000 -> 220.00. Only when the dollar reading is plausible.
    if (n > PRICE_MAX && Number.isInteger(n) && n / 100 >= PRICE_MIN && n / 100 <= PRICE_MAX) {
      n /= 100;
      cents = true;
    }
    if (n < PRICE_MIN || n > PRICE_MAX) continue;
    cands.push({ path, value: n, cents });
  }
  if (!cands.length) return null;
  // An all-in total beats a base price, which beats a face/list reference.
  const rank = (c) => (/total|all[_ ]?in|grand/i.test(c.path) ? 0
                     : /face|list/i.test(c.path) ? 2 : 1);
  cands.sort((a, b) => rank(a) - rank(b) || b.value - a.value);
  return cands[0];
}

// --- seat count -------------------------------------------------------------
// The alert used to label every line with the quantity that was SEARCHED for.
// That is NOT the number of seats in the result: `qty` is just the bucket key,
// so anything returned by the qty=2 search printed "2 seat(s)" whether or not
// two seats came back. User observed exactly this on 2026-09-16 -- alerts
// claiming 2 seats on what was a single seat.
//
// So: report the pick's OWN count when it carries one, and say plainly that the
// count is unconfirmed when it does not. Never restate the search quantity as
// though it were a confirmed count.
function seatCount(pick) {
  // CONFIRMED on a live pick 2026-09-16 11:50: Ticketmaster expresses a block as
  // an INCLUSIVE seat range, seatFrom/seatTo, as strings. seatFrom "49" and
  // seatTo "49" is ONE seat -- and that pick was returned by the qty=1 AND was
  // the kind of result that used to print a bare search quantity. This is the
  // real shape, so it is checked first.
  if (pick.seatFrom != null && pick.seatTo != null) {
    const a = Number(pick.seatFrom), b = Number(pick.seatTo);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a < 20) return b - a + 1;
  }
  for (const k of ['seats', 'seatNumbers', 'seatLabels']) {
    if (Array.isArray(pick[k])) return pick[k].length;
  }
  for (const k of ['seatCount', 'numSeats', 'quantity', 'qty', 'count']) {
    if (Number.isInteger(pick[k]) && pick[k] > 0 && pick[k] <= 20) return pick[k];
  }
  return null;
}

// Where the seats physically are, including the seat number(s) when the feed
// gives a range -- "row R seat 7" is far more use when buying by hand than a
// bare row.
function seatWhere(pick) {
  const base = `${pick.section || pick.area || '?'} row ${pick.row || '?'}`;
  if (pick.seatFrom == null) return base;
  return String(pick.seatFrom) === String(pick.seatTo)
    ? `${base} seat ${pick.seatFrom}`
    : `${base} seats ${pick.seatFrom}-${pick.seatTo}`;
}

// The ticket TYPE and how many price types exist on the same seat.
//
// CRITICAL, and easy to get wrong: the API is queried with `sort=price`, so the
// pick describes the CHEAPEST offer on that seat -- NOT the only one, and not
// necessarily the one you would buy. Confirmed 2026-09-16: a pick reported as
// "Junior 4-14 Years" at $66 with four entries in `offerIds` was bought from
// that same seat as "Adult x 1" for $226.95. Same section, same row, same seat.
//
// So the alert must present the price as a FROM, and say how many offers exist.
// Reporting a bare "Junior 4-14 Years" invites a buyer to dismiss a perfectly
// good seat as unusable.
function ticketType(pick) {
  const t = pick.name || pick.ticketType || pick.offerName;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

function offerCount(pick) {
  return Array.isArray(pick.offerIds) ? pick.offerIds.length : 0;
}

// Identity of a physical block of seats, so the same seats surfacing in two
// different quantity searches are reported once rather than as two findings.
function pickKey(pick) {
  if (pick.id != null) return String(pick.id); // real picks carry a stable id
  const seats = ['seats', 'seatNumbers', 'seatLabels']
    .map((k) => (Array.isArray(pick[k]) ? pick[k].join(',') : ''))
    .find(Boolean) || `${pick.seatFrom ?? ''}-${pick.seatTo ?? ''}`;
  return [pick.section || pick.area || '?', pick.row || '?', seats].join('|');
}

function describe(res) {
  const lines = [];
  const seen = new Set();
  let missedPrice = null;   // first pick whose price could not be read
  let unconfirmed = false;  // at least one pick with no readable seat count
  for (const [qty, r] of Object.entries(res.results)) {
    for (const [kind, o] of [['PRIMARY', r.primary], ['RESALE', r.resale]]) {
      if (o && Array.isArray(o.picks) && o.picks.length) {
        for (const p of o.picks.slice(0, 4)) {
          const key = `${kind}|${pickKey(p)}`;
          if (seen.has(key)) continue; // already reported from another qty search
          seen.add(key);

          const pr = extractPrice(p);
          if (!pr && !missedPrice) missedPrice = p;
          const price = pr ? `$${pr.value.toFixed(2)}` : '$?';

          const n = seatCount(p);
          if (n === null) unconfirmed = true;
          const count = n === null
            ? `seats ? (qty${qty} search)`
            : `${n} seat${n === 1 ? '' : 's'}`;

          const type = ticketType(p);
          const offers = offerCount(p);
          // "from $X" because sort=price means this is the cheapest offer on the
          // seat, not the only one. See ticketType() above.
          const priceStr = pr && offers > 1 ? `from ${price}` : price;
          const typeStr = !type ? ''
            : offers > 1 ? ` — cheapest of ${offers} ticket types (${type}); other prices exist on this seat`
            : ` — ${type}`;
          lines.push(`${kind} ${seatWhere(p)} — ${count} — ${priceStr}${typeStr}`);
        }
      }
    }
  }
  if (!lines.length) return 'Seats available — open the page now.';

  if (unconfirmed) {
    lines.push('');
    lines.push('"seats ?" = the feed did not state how many seats are in that block.');
    lines.push('The qtyN shown is only which search found it, NOT a confirmed count.');
  }
  lines.push('');
  lines.push('SCG face value for reference: $220 / $168 / $129 / $65 by level, + $6.95 fee.');
  // Self-documenting fallback: if price extraction failed, ship the raw object in
  // the email so the next live window reveals the schema even if nobody is
  // watching the pm2 log. The toast only ever shows line 1, so this cannot
  // bloat it.
  if (missedPrice) {
    lines.push('');
    lines.push('(price field not recognised — raw pick for debugging:)');
    lines.push(JSON.stringify(missedPrice).slice(0, 900));
  }
  return lines.join('\n');
}

// ----------------------------- main loop ------------------------------------
(async () => {
  if (process.argv.includes('--test')) {
    log(`Firing a test alert on every channel (ntfy topic: ${NTFY_TOPIC || 'DISABLED'})`);
    log(`Email: ${mailerStatus}`);
    if (mailer) {
      // Verify the credentials BEFORE claiming the channel works. A wrong app
      // password fails here, at test time, instead of during a live window.
      try {
        await mailer.verify();
        log('SMTP handshake OK (Gmail accepted the app password)');
      } catch (e) {
        log('SMTP HANDSHAKE FAILED:', e.message);
        log('-> the app password is wrong, or 2-Step Verification is not on for this account.');
      }
    }
    notify('tm-watch test', 'If you can see this on your desktop, alerts work.');
    // Render a REAL alert body from a sample pick, so the test email shows the
    // exact format a live alert will use -- including the price line. Without
    // this the test mail proves only that SMTP works, not that the body is
    // readable, and the format could not be checked until a window opened.
    const sampleBody = describe({
      results: {
        1: { primary: { picks: [{ section: 'BAY5A', row: 'C', seats: ['12'], totalPrice: 226.95 }] } },
        2: { primary: { picks: [{ section: 'BAY15', row: 'K', seats: ['4', '5'], totalPrice: 453.90 }] } },
      },
    });
    await sendEmail(
      'tm-watch test - Swans v Freo monitor',
      'This is a test of the email alert path.\n\n' +
      'If this landed in your inbox, you will be emailed the moment seats appear.\n\n' +
      '--- a real alert will look like this (sample data, NOT live seats) ---\n' +
      sampleBody
    );
    await sleep(4000);
    log('Test done. Check your inbox as well as the desktop toast.');
    process.exit(0);
  }

  log(`Watching ${EVENT_ID} for qty ${QTYS.join(' and ')}. Poll ~${Math.round(POLL_MS / 1000)}s. Ctrl+C to stop.`);
  if (NTFY_TOPIC) log(`Phone push -> ntfy.sh topic "${NTFY_TOPIC}"`);
  log(`Email: ${mailerStatus}`);
  if (mailer) {
    mailer.verify()
      .then(() => log('SMTP handshake OK'))
      .catch((e) => log('SMTP HANDSHAKE FAILED (emails will not send):', e.message));
  }
  let lastBeat = Date.now();

  // `ctx` and `page` are reassignable because the browser can DIE independently
  // of this process, and the only cure is a fresh launch -- see relaunch().
  let ctx, page;
  async function launch() {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: HEADLESS,
      locale: 'en-AU',
      timezoneId: 'Australia/Sydney',
      viewport: { width: 1440, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(EVENT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(8000);
  }
  await launch();

  // Chromium dying is NOT the same failure as a bad page, and the old recovery
  // could not tell them apart: it ran page.goto() on an already-dead page, the
  // throw was swallowed by `catch {}`, `fails` reset to 0, and the loop spun
  // forever -- blind, while pm2 still reported the process "online" and nothing
  // alerted. Observed for real on 2026-09-16 11:53-11:54 after two pm2 restarts
  // ~90s apart; only a manual restart cleared it.
  const isDead = (msg) => /browser has been closed|Target page, context or browser has been closed|Target closed|browser has disconnected/i.test(msg || '');
  async function relaunch() {
    log('browser is gone — relaunching Chromium');
    try { await ctx.close(); } catch {}
    await sleep(3000);
    await launch();
    log('relaunched OK');
  }

  // Starts false so the FIRST cycle always queries resale and learns the flag.
  let i = 0, fails = 0, lastLog = '', opened = false, resaleKnownOff = false;
  let forceReload = false, lastForcedReload = -99, dumpedPick = false;
  for (;;) {
    i++;
    try {
      if (forceReload || i % RELOAD_EVERY === 0) {
        if (forceReload) log('forcing reload to refresh bot clearance after err403');
        forceReload = false;
        await page.goto(EVENT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForTimeout(6000);
      }
      const res = await checkOnce(page, QTYS, !resaleKnownOff);
      fails = 0;
      // Follow the page flag. Only a definite `false` turns resale querying off;
      // a null (page not fully parsed, e.g. a challenge) leaves it as-is rather
      // than silently disabling a market on bad data.
      if (res.resaleEnabled === true) resaleKnownOff = false;
      else if (res.resaleEnabled === false) resaleKnownOff = true;

      // Self-heal: a cycle where every primary call 403s means our bot clearance
      // has aged out, not that the seats are gone. Restarting the process always
      // cleared this instantly, and a page reload is the cheap version of that.
      // Rate-limited to once per 3 polls so a persistent block can't reload-loop.
      const all403 = Object.values(res.results)
        .every((r) => r.primary && r.primary.error === 403);
      if (all403 && i - lastForcedReload >= 3) { forceReload = true; lastForcedReload = i; }

      if (hit(res)) {
        const body = describe(res);
        log('*** AVAILABLE ***\n' + body);

        // One-off diagnostic: dump the raw shape of a single pick so the price
        // field can be identified. describe() renders `$?` because the object
        // carries none of totalPrice / price / offers[0].listPrice. Fires once
        // per process, costs no extra requests, and is harmless to leave in.
        if (!dumpedPick) {
          const withPicks = Object.values(res.results)
            .map((r) => r.primary)
            .find((o) => o && Array.isArray(o.picks) && o.picks.length);
          if (withPicks) {
            dumpedPick = true;
            log('PICK SHAPE (one-off): ' + JSON.stringify(withPicks.picks[0]).slice(0, 700));
          }
        }
        notify('SWANS TICKETS AVAILABLE', body.split('\n')[0]);
        // Fire the once-per-window actions: open the page, and email. Both are
        // gated on `opened` so a long window does not spawn a browser tab every
        // cycle or fill the inbox. `opened` resets when the window closes, so a
        // fresh window gets a fresh email.
        if (!opened) {
          if (OPEN_ON_HIT) openInBrowser(EVENT_URL);
          sendEmail('SEATS AVAILABLE - Swans v Freo prelim', body);
          opened = true;
        }
        // Re-alert until killed, but at POLL_MS -- NOT the original hardcoded 30s.
        // 30s quadrupled the request rate at exactly the moment a seat was on the
        // table and tripped the hourly budget (verified 2026-09-15: ten hit-cycles
        // from 15:33, sustained err403 from 15:47 that did not self-clear by poll
        // 70). Worse, a 403 leaves `picks` undefined so hit() goes false -- meaning
        // throttling makes LIVE SEATS LOOK LIKE NO SEATS. Never lower this below
        // POLL_MS.
        await sleep(Math.max(POLL_MS, 30000));
        continue;
      }

      opened = false; // window closed (or we are throttled) -- re-arm the auto-open
      const line = summarise(res);
      // Log on every change, plus a periodic liveness line. The original i%40
      // was tuned for a 15s poll (=10 min); at POLL_MS=120000 that becomes 80
      // minutes of silence, during which a wedged monitor is indistinguishable
      // from a quiet one. i%5 gives a line every ~10 min regardless.
      if (line !== lastLog) { log(line); lastLog = line; }
      else if (i % 5 === 0) log(line + `  (still nothing, poll ${i})`);

      if (HEARTBEAT_MIN && Date.now() - lastBeat > HEARTBEAT_MIN * 60000) {
        lastBeat = Date.now();
        push('tm-watch alive', `${i} checks done, nothing available yet.`, 'min', 'hourglass');
      }
    } catch (e) {
      fails++;
      log('check failed:', e.message);
      // A dead browser cannot be fixed by a reload, so do not waste three polls
      // discovering that -- relaunch on the FIRST sighting.
      if (isDead(e.message)) {
        try { await relaunch(); fails = 0; }
        catch (re) { log('relaunch FAILED:', re.message, '- retrying next poll'); }
      } else if (fails >= 3) {
        log('recovering — hard reload');
        try { await page.goto(EVENT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }); }
        catch (ge) {
          // The reload itself can reveal a dead browser.
          if (isDead(ge.message)) { try { await relaunch(); } catch {} }
        }
        await sleep(15000);
        fails = 0;
      }
    }
    await sleep(POLL_MS + Math.random() * JITTER_MS);
  }
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
