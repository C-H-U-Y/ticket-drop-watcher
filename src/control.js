/**
 * control.js - the runner's link to the Seat watch control plane.
 *
 * OPTIONAL. Nothing in tm-watch.js touches this module unless it is started
 * with --monitor and --token. There are no database credentials anywhere on
 * the runner: this posts JSON over HTTPS with a per-monitor token, and the
 * dashboard's MongoDB connection string stays a secret on its server.
 * See docs/DASHBOARD.md.
 *
 * The dashboard at https://seatwatch.archie-huybers.workers.dev/dashboard creates
 * a monitor and hands out a monitor id and a runner token. This module posts
 * to its one endpoint, POST {api}/api/pulse, in three flavours:
 *
 *   hello   -> fetch the monitor's config (event id, quantities, poll interval)
 *   start   -> same, and the dashboard records "Runner started"
 *   pulse   -> one poll cycle's result; the dashboard opens or extends windows
 *              and pushes the phone alert itself
 *
 * Responses:
 *   200  { active: true, config: {...}, ... }
 *   410  the owner deactivated the monitor       -> throws Inactive
 *   401  bad monitor id or token                  -> throws Rejected
 *
 * No dependencies. Node 18+ has fetch and AbortController built in. Nothing in
 * here ever blocks the poll loop: callers fire and forget, and a failure here
 * must never stop the browser from checking Ticketmaster.
 */

const DEFAULT_API = 'https://seatwatch.archie-huybers.workers.dev';

class Inactive extends Error {}
class Rejected extends Error {}

/**
 * --monitor <id> --token <token> --api <origin>, falling back to the env vars
 * MONITOR_ID, RUNNER_TOKEN and API_ORIGIN. `api` always has a value and never
 * ends in a slash.
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const pick = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? String(args[i + 1]) : '';
  };
  const api = (pick('--api') || process.env.API_ORIGIN || DEFAULT_API).replace(/\/+$/, '');
  return {
    monitor: pick('--monitor') || process.env.MONITOR_ID || '',
    token: pick('--token') || process.env.RUNNER_TOKEN || '',
    api,
  };
}

/**
 * One POST. Resolves { status, json } for any HTTP status, including 4xx and
 * 5xx. Throws only when the network fails or the request times out.
 */
async function post(ctl, body, timeoutMs = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${ctl.api}/api/pulse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitorId: ctl.monitor, token: ctl.token, ...body }),
      signal: ac.signal,
    });
    let json = null;
    try { json = await r.json(); } catch { json = null; }
    return { status: r.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function unwrap({ status, json }) {
  if (status === 410) throw new Inactive((json && json.error) || 'Monitor deactivated.');
  if (status === 401) throw new Rejected((json && json.error) || 'Unknown monitor or bad runner token.');
  if (status < 200 || status >= 300) {
    throw new Error(`control plane HTTP ${status}${json && json.error ? `: ${json.error}` : ''}`);
  }
  return json || {};
}

function hello(ctl) {
  return post(ctl, { kind: 'hello' }).then(unwrap);
}

function start(ctl, pollSeconds) {
  return post(ctl, { kind: 'start', pollSeconds }).then(unwrap);
}

function pulse(ctl, payload) {
  return post(ctl, { kind: 'pulse', ...payload }).then(unwrap);
}

module.exports = { DEFAULT_API, Inactive, Rejected, parseArgs, post, hello, start, pulse };
