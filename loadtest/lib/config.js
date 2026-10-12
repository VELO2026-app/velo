// =============================================================================
// VELO load tests -- configuration, the production guard, shared constants
// =============================================================================
//
// Imported by every scenario, so the guard below runs in the init context of
// every one of them -- BEFORE setup(), before any VU, before the first
// request. A thrown error in init aborts `k6 run` with nothing sent.
//
// THE GUARD IS AN EXACT-STRING ALLOWLIST, not a hostname check. A hostname
// suffix check has to get ports, userinfo ("https://x@api..."), look-alike
// hosts ("api.zxcvbnm.beer.evil.com") and schemes right, and k6 has no URL
// parser to lean on; one exact string has none of those failure modes.
// There is deliberately NO override variable: an escape hatch for "just this
// once" is how a load test reaches production. Adding a target means editing
// ALLOWED_BASE_URLS in a reviewed commit.
// =============================================================================

export const ALLOWED_BASE_URLS = ['https://api.zxcvbnm.beer'];

const rawBaseUrl = (__ENV.BASE_URL || '').trim();

if (rawBaseUrl === '') {
  throw new Error(
    `REFUSED: BASE_URL is empty. Set it explicitly (${ALLOWED_BASE_URLS[0]}). Nothing was sent.`,
  );
}
if (!ALLOWED_BASE_URLS.includes(rawBaseUrl)) {
  throw new Error(
    `REFUSED: BASE_URL "${rawBaseUrl}" is not in the allowlist ` +
      `(${ALLOWED_BASE_URLS.join(', ')}). Load tests run against dev only, ` +
      'never against production. Nothing was sent.',
  );
}

export const BASE_URL = rawBaseUrl;

// -- Load students --------------------------------------------------------
// A dedicated telegram_id band, OUTSIDE the seed's synthetic range
// (scripts/seed.py SYNTH_MIN..SYNTH_MAX = 600001..699999), so a seed --reset
// never touches them and they never mix with seeded students; also outside
// the backend suite's band space (tests/telegram_id_bands.py, 55000..99999).
export const LOAD_TID_MIN = 710001;
export const LOAD_TID_MAX = 712000;

// -- Practices --------------------------------------------------------------
// Created by run.py for every run and cancelled after it (BE-147): the
// scenarios get their ids from PRACTICES_FILE (lib/practices.js), never by
// title, so nothing here depends on when the stand was seeded.
export const RACE_SEATS = 20;

// -- Cohorts inside the sessions file (by position) -------------------------
// Test 3 and test 4 need students in a known state, so each gets its own
// slice. The mix (tests 1, 2, 5) uses the file from the start: its bookings
// only ever target this run's feed practices, so sharing students with the
// cohorts changes nothing for them. run.py reads these two lines to know
// how many sessions a run needs -- keep them one object literal per line.
export const START_COHORT = { offset: 0, size: 300 };
export const RACE_COHORT = { offset: 300, size: 500 };

// -- Requests ----------------------------------------------------------------
// Longer than the server's own database wait (SQLAlchemy QueuePool timeout,
// 30 s -- app/core/database.py sets no pool_timeout): a request starved of a
// pool connection then reaches the client as the server's 500 rather than
// as a client-side timeout, so pool exhaustion stays visible as what it is.
export const REQUEST_TIMEOUT = '60s';

/** Integer env var with a default; refuses garbage instead of guessing. */
export function intEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      throw new Error(`REFUSED: ${name} is required.`);
    }
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`REFUSED: ${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}
