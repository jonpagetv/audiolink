const fs = require('node:fs');
const path = require('node:path');

// Newline-delimited JSON, not a database — "a running log of individual
// events is acceptable" per the requirements doc, and this matches the
// project's existing plain-file convention (server/data/links.json).
// Lives under server/data/, already gitignored wholesale.
const LOG_FILE = path.join(__dirname, 'data', 'activity.log');

function logEvent(type, data = {}) {
  const now = Date.now();
  // `time` (ISO 8601) so the raw file is readable at a glance without
  // decoding epoch ms by hand; `at` kept as-is since the admin UI and any
  // future tooling already sort/compare on it as a number.
  const entry = { type, time: new Date(now).toISOString(), at: now, ...data };
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, (err) => {
    if (err) console.error('Failed to write audit log:', err);
  });
}

// Returns every event whose `at` (epoch ms) falls within [from, to]
// (either bound optional), newest first. Unbounded rather than capped
// here — the admin activity endpoint applies its own page slice on top,
// and a date-range query has to be able to reach arbitrarily far back,
// not just the most recent N lines.
function readEvents({ from = null, to = null } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(LOG_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => (from == null || event.at >= from) && (to == null || event.at <= to))
    .reverse(); // newest first
}

module.exports = { logEvent, readEvents };
