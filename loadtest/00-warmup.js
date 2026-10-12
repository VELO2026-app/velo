// =============================================================================
// VELO load tests -- 00 warmup: honest logins, sessions saved for every test
// =============================================================================
//
// Logins are the only rate-limited endpoint (auth/service.py): 100 per 60 s
// per source address (auth_rate_limit_max_requests 5 x
// _SOURCE_RATE_LIMIT_MULTIPLIER 20, fixed window, counts EVERY attempt) and
// 5 per 60 s per telegram_id. Sessions live 30 days. So the students log in
// once, here, at ~86 per minute, and every test after this reuses the tokens.
//
// HOW THE TOKENS LEAVE k6. A VU cannot hand data to handleSummary; setup()
// can (summary data carries setup_data, k6 v2.3.0 internal/js/summary.go).
// So the logins run inside setup(), sequentially, and handleSummary writes
// the sessions file.
//
// REPEATABLE, NOT ADDITIVE. Existing sessions are checked first (GET
// /users/me, not rate-limited); only missing or rejected ones log in again,
// so re-running does not mint sessions that are already there. One run logs
// in at most WARMUP_BATCH students (default 500, ~6 min) -- an interrupted
// run then loses at most one batch. Re-run until it reports "missing: 0".
//
// THE BOT TOKEN is read from BOT_TOKEN and passed to buildInitData only. It
// is never logged, never part of setup_data, never written anywhere.
//
// Run (from loadtest/):  BOT_TOKEN=... k6 run 00-warmup.js     (see README)
// =============================================================================

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

import { BASE_URL, LOAD_TID_MAX, LOAD_TID_MIN, REQUEST_TIMEOUT, intEnv } from './lib/config.js';
import { call, errorCode, measureFloor } from './lib/api.js';
import { buildInitData } from './lib/initdata.js';
import { SESSIONS_PATH, readSessionsFile, resultPath, sessionsFileContent } from './lib/state.js';
import {
  ALWAYS_PASS_P95, SUMMARY_TREND_STATS, metricLines, submetricThresholds,
} from './lib/summary.js';

const BOT_TOKEN = (__ENV.BOT_TOKEN || '').trim();
if (BOT_TOKEN === '') {
  throw new Error('REFUSED: BOT_TOKEN is empty. Export the dev bot token first (README, step 3).');
}

const LOAD_USERS = intEnv('LOAD_USERS', 2000);
if (LOAD_USERS > LOAD_TID_MAX - LOAD_TID_MIN + 1) {
  throw new Error(`REFUSED: LOAD_USERS ${LOAD_USERS} exceeds the band ${LOAD_TID_MIN}..${LOAD_TID_MAX}.`);
}
const BATCH = intEnv('WARMUP_BATCH', 500);
// 700 ms between login starts = ~86/min, under the 100/min source limit with
// room for the checks and retries that also count against it.
const INTERVAL_MS = intEnv('LOGIN_INTERVAL_MS', 700);
if (INTERVAL_MS < 650) {
  throw new Error('REFUSED: LOGIN_INTERVAL_MS below 650 would exceed ~90 logins/min.');
}

const existing = readSessionsFile();

const loginDuration = new Trend('login_duration', true);
const loginsDone = new Counter('logins_done');
const loginsFailed = new Counter('logins_failed');

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,
  // Session checks (~2 min for 2000) + the batch at INTERVAL_MS, with margin.
  setupTimeout: `${Math.ceil((BATCH * INTERVAL_MS) / 60000) + 10}m`,
  scenarios: {
    noop: { executor: 'shared-iterations', vus: 1, iterations: 1 },
  },
  thresholds: Object.assign(
    { login_duration: [ALWAYS_PASS_P95] },
    submetricThresholds('http_req_duration', 'action', ['health']),
  ),
};

function checkExisting(sessions) {
  // Validated in parallel batches of 50: /users/me is not rate-limited.
  const valid = [];
  for (let i = 0; i < sessions.length; i += 50) {
    const chunk = sessions.slice(i, i + 50);
    const responses = http.batch(chunk.map((s) => ({
      method: 'GET',
      url: `${BASE_URL}/api/v1/users/me`,
      params: {
        headers: { Authorization: `Bearer ${s.token}` },
        tags: { action: 'warmup_check', name: 'users_me' },
        timeout: REQUEST_TIMEOUT,
      },
    })));
    responses.forEach((res, j) => {
      const s = chunk[j];
      if (res.status === 200 && res.json().telegram_id === s.telegram_id) {
        valid.push(s);
      } else if (res.status !== 401) {
        // A server problem is not proof the session is dead: stop rather
        // than throw away valid sessions and re-login them.
        throw new Error(`warmup: session check answered ${res.status}; nothing changed.`);
      }
    });
  }
  return valid;
}

function login(telegramId) {
  const res = http.post(
    `${BASE_URL}/api/v1/auth/telegram`,
    JSON.stringify({ init_data: buildInitData(telegramId, BOT_TOKEN) }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { action: 'auth_login', name: 'auth_telegram' },
      timeout: REQUEST_TIMEOUT,
    },
  );
  if (res.status === 200) {
    loginDuration.add(res.timings.duration);
  }
  return res;
}

export function setup() {
  measureFloor();

  const byId = new Map();
  if (existing) {
    // De-duplicate: the newest entry for an id wins, ids outside the band
    // are dropped (a hand-edited file must not smuggle real accounts in).
    for (const s of existing.sessions) {
      if (s.telegram_id >= LOAD_TID_MIN && s.telegram_id <= LOAD_TID_MAX) {
        byId.set(s.telegram_id, s);
      }
    }
  }
  const valid = checkExisting(Array.from(byId.values()));
  const have = new Map(valid.map((s) => [s.telegram_id, s]));
  console.log(`warmup: ${have.size} valid sessions kept, ${byId.size - have.size} dropped (401)`);

  const missing = [];
  for (let id = LOAD_TID_MIN; id < LOAD_TID_MIN + LOAD_USERS; id += 1) {
    if (!have.has(id)) missing.push(id);
  }
  const todo = missing.slice(0, BATCH);
  console.log(`warmup: missing ${missing.length}, logging in ${todo.length} now`);

  let consecutive429 = 0;
  let consecutiveFail = 0;
  for (const id of todo) {
    const started = Date.now();
    const res = login(id);
    if (res.status === 200) {
      const body = res.json();
      have.set(id, { telegram_id: id, token: body.session_token, user_id: body.user.id });
      loginsDone.add(1);
      consecutive429 = 0;
      consecutiveFail = 0;
    } else {
      loginsFailed.add(1, { status: String(res.status) });
      console.warn(`warmup: login ${id} -> ${res.status} ${errorCode(res)}`);
      if (res.status === 429) {
        consecutive429 += 1;
        if (consecutive429 >= 3) {
          console.warn('warmup: rate limited 3 times in a row -- stopping this batch');
          break;
        }
        sleep(61);
      } else {
        consecutiveFail += 1;
        if (consecutiveFail >= 20) {
          console.warn('warmup: 20 failures in a row -- stopping this batch');
          break;
        }
      }
    }
    const wait = INTERVAL_MS - (Date.now() - started);
    if (wait > 0) sleep(wait / 1000);
  }

  const sessions = Array.from(have.values()).sort((a, b) => a.telegram_id - b.telegram_id);
  return {
    sessions,
    missing: LOAD_USERS - sessions.filter(
      (s) => s.telegram_id < LOAD_TID_MIN + LOAD_USERS,
    ).length,
  };
}

export default function () {
  // Nothing to do per VU: the warmup is setup() + handleSummary().
}

export function handleSummary(data) {
  const out = {};
  const sd = data.setup_data;
  const clean = Object.assign({}, data);
  delete clean.setup_data;
  out[resultPath('00-warmup-summary.json')] = JSON.stringify(clean, null, 2);

  const lines = ['=== 00-warmup ==='];
  // Only a well-formed setup result may replace the file: a setup that threw
  // leaves the previous sessions exactly as they were.
  if (sd && Array.isArray(sd.sessions)) {
    out[SESSIONS_PATH] = sessionsFileContent(sd.sessions);
    lines.push(`sessions: ${sd.sessions.length} -> ${SESSIONS_PATH}`);
    lines.push(`missing: ${sd.missing}${sd.missing > 0 ? '  (run 00-warmup.js again)' : ''}`);
  } else {
    lines.push('setup did not finish: the sessions file was NOT changed');
  }
  lines.push(...metricLines(data, 'login_duration', ['med', 'p(95)', 'count']));
  lines.push(...metricLines(data, 'http_req_duration', ['med', 'p(95)']));
  lines.push(...metricLines(data, 'logins_failed', ['count']));
  lines.push('');
  out.stdout = lines.join('\n');
  return out;
}
