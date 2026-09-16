// Unit tests for the alert body builder in tm-watch.js: price extraction,
// seat counting, and de-duplication across quantity searches.
//
// Why this exists: the real pick schema is UNKNOWN. The three price field names
// the alert used to guess all came back undefined on a live hit (2026-09-15),
// and no window has opened since, so nothing here can be validated against a
// real payload yet. Instead it is validated against the plausible shapes
// Ticketmaster uses elsewhere, plus the near-misses that must NOT be read as a
// price, plus the seat-count bug the user reported on 2026-09-16.
//
// Run: node test_alert.js
const fs = require('fs');

// Pull the builder out of tm-watch.js so requiring it does not start the main
// loop (tm-watch.js runs as an IIFE on import).
const src = fs.readFileSync('tm-watch.js', 'utf8');
const start = src.indexOf('const PRICE_MIN');
const end = src.indexOf('// ----------------------------- main loop');
if (start < 0 || end < 0) throw new Error('could not locate the builder block');
const { extractPrice, seatCount, describe } =
  (new Function(src.slice(start, end) + '\nreturn { extractPrice, seatCount, describe };'))();

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name.padEnd(26) + ' ' + detail); }
  else { fail++; console.log('  FAIL  ' + name.padEnd(26) + ' ' + detail); }
};

console.log('--- price extraction ---');
const priceCases = [
  ['flat dollars',        { section: 'BAY5A', row: 'C', price: 220 }, 220],
  ['totalPrice',          { totalPrice: 168 }, 168],
  ['integer cents',       { totalPrice: 22000 }, 220],
  ['string with symbol',  { listPrice: '$129.00' }, 129],
  ['nested amount',       { total: { amount: 226.95, currency: 'AUD' } }, 226.95],
  ['offers array',        { offers: [{ listPrice: 65 }] }, 65],
  ['deep nesting',        { pricing: { summary: { grandTotal: { amount: 446.95 } } } }, 446.95],
  ['total beats base',    { basePrice: 220, totalPrice: 226.95 }, 226.95],
  ['all-in beats face',   { faceValue: 220, allInPrice: 226.95 }, 226.95],
  ['qty ignored',         { quantity: 3, section: 'BAY2' }, null],
  ['ids ignored',         { offerId: 220, priceLevelId: 168 }, null],
  ['booking fee alone',   { feeAmount: 6.95 }, null],
  ['no price at all',     { section: 'BAY15', row: 'AA' }, null],
  ['15 Sep shape',        { section: 'BAY5A', row: 'C', seats: ['12'], ada: false }, null],
];
for (const [name, pick, expected] of priceCases) {
  const got = extractPrice(pick);
  const val = got ? got.value : null;
  const ok = expected === null ? val === null : Math.abs(val - expected) < 0.005;
  check(name, ok, ok
    ? '-> ' + (val === null ? 'no price' : '$' + val.toFixed(2)) + (got && got.cents ? ' (cents)' : '')
    : '-> expected ' + expected + ', got ' + val + ' [' + (got ? got.path : '-') + ']');
}

console.log('\n--- seat count ---');
const countCases = [
  ['seats array of 1',   { seats: ['12'] }, 1],
  ['seats array of 2',   { seats: ['12', '13'] }, 2],
  ['seatNumbers',        { seatNumbers: ['1', '2', '3'] }, 3],
  ['explicit numSeats',  { numSeats: 2 }, 2],
  ['no count field',     { section: 'BAY5A', row: 'C' }, null],
  ['bogus huge count',   { quantity: 999 }, null],
];
for (const [name, pick, expected] of countCases) {
  const got = seatCount(pick);
  check(name, got === expected, '-> ' + (got === null ? 'unconfirmed' : got));
}

// --- the reported bug, end to end -------------------------------------------
console.log('\n--- reported bug: qty2 search returning ONE seat ---');
const b1 = describe({ results: { 2: { primary: { picks: [
  { section: 'BAY5A', row: 'C', seats: ['12'], totalPrice: 226.95 }] } } } });
const l1 = b1.split('\n')[0];
check('says 1 seat, not 2', / 1 seat /.test(l1) && !/ 2 seats /.test(l1), '-> "' + l1 + '"');

console.log('\n--- unconfirmed count is never asserted as a number ---');
const b2 = describe({ results: { 2: { primary: { picks: [
  { section: 'BAY5A', row: 'C' }] } } } });
const l2 = b2.split('\n')[0];
check('shows "seats ?"', /seats \?/.test(l2) && !/ 2 seats /.test(l2), '-> "' + l2 + '"');

console.log('\n--- same seats found by two qty searches ---');
const dup = { section: 'BAY5A', row: 'C', seats: ['12'], totalPrice: 226.95 };
const b3 = describe({ results: { 1: { primary: { picks: [dup] } },
                                 2: { primary: { picks: [dup] } } } });
const n3 = b3.split('\n').filter((l) => l.startsWith('PRIMARY')).length;
check('deduped to one line', n3 === 1, '-> ' + n3 + ' line(s)');

// --- THE REAL PAYLOAD -------------------------------------------------------
// The real shape, captured from a live window. Field names, types and
// cardinality are exactly as the API returned them -- note seatFrom/seatTo as
// STRINGS and the four-element offerIds. Only the identifying values (id,
// section, row, seat, place and offer ids) are anonymised; nothing the tests
// exercise depends on them.
console.log('\n--- REAL live pick, captured 2026-09-16 11:50:23 ---');
const real = {"id":"100000001","type":"seat","section":"SEC12","row":"R","seatFrom":"7","seatTo":"7","name":"Junior 4-14 Years","originalPrice":66,"description":"Reserved Seating","areaName":"RESVD","placeDescriptionId":"AAAAAAA","hasSpecialDescription":false,"offerIds":["OFFER1","OFFER2","OFFER3","OFFER4"],"quality":0.873536,"attributes":[]};
const rp = extractPrice(real);
check('price read from feed', rp !== null && Math.abs(rp.value - 66) < 0.005,
  '-> ' + (rp ? '$' + rp.value.toFixed(2) + ' via ' + rp.path : 'FAILED - still $?'));
check('seat count exact', seatCount(real) === 1,
  '-> ' + seatCount(real) + ' seat (seatFrom === seatTo)');
const realBody = describe({ results: { 2: { primary: { picks: [real] } } } });
const realLine = realBody.split('\n')[0];
check('not mislabelled as 2', / 1 seat /.test(realLine) && !/ 2 seats /.test(realLine),
  '-> "' + realLine + '"');
check('ticket type surfaced', /Junior 4-14 Years/.test(realLine), '-> type shown on line 1');
// This seat was ACTUALLY BOUGHT as "Adult x 1" for $226.95, while the feed
// reported it as a $66 Junior -- because the query sorts by price and the seat
// carried four offerIds. The alert must never imply the cheapest offer is the
// only one.
check('price shown as a FROM', /from \$66\.00/.test(realLine), '-> "from $66.00", not a flat $66.00');
check('other offers flagged', /cheapest of 4 ticket types/.test(realLine), '-> says 4 types exist');
check('does not imply only option', !/— Junior 4-14 Years$/.test(realLine), '-> type is not the last word');
check('count is confirmed', !/seats \?/.test(realBody), '-> no "seats ?" fallback needed');
check('no debug dump', !/not recognised/.test(realBody), '-> price resolved from the feed');

console.log('\n--- genuinely different blocks are NOT deduped ---');
const b4 = describe({ results: { 2: { primary: { picks: [
  { section: 'BAY5A', row: 'C', seats: ['12', '13'], totalPrice: 453.90 },
  { section: 'BAY15', row: 'K', seats: ['4', '5'], totalPrice: 349.90 }] } } } });
const n4 = b4.split('\n').filter((l) => l.startsWith('PRIMARY')).length;
check('both blocks kept', n4 === 2, '-> ' + n4 + ' line(s)');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
