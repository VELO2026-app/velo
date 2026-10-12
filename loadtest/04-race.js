// =============================================================================
// VELO load tests -- 04 race for seats: 500 students, 20 seats, one moment
// =============================================================================
//
// 500 students of RACE_COHORT book the same "[load] race N" practice
// (max_participants 20) at the same instant, through the frontend's path:
// POST /practices/{id}/purchase -> create_booking, which takes the practice
// row FOR UPDATE and counts active bookings under it.
//
// THE SAME INSTANT, NOT THE SAME SECOND. Started cold, 500 VUs would spend
// the first second or more on TCP + TLS handshakes from one machine, and
// the "race" would be a queue. So each VU first opens its connection
// (GET /users/me, tag race_warm), then sleeps until one wall-clock barrier
// from setup(), then fires. race_start_skew shows how close together the
// requests actually left.
//
// Expected: exactly 20 x 201, 480 x 400 practice_full, no 5xx, no other
// code. The practice is this run's own (PRACTICES_FILE), created by run.py
// with 20 seats and refused here unless it is still empty.
//
// What this run CANNOT prove alone: "no duplicates" and "exactly 20 rows"
// are database facts -- run.py asks the server for them right after this
// test (`velo loadtest-probe race-check <id>`, before the practice is
// cancelled); race_participants_after is the API's view of the same thing.
//
// Run by loadtest/run.py.
// =============================================================================

import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Gauge, Trend } from 'k6/metrics';

import { RACE_COHORT, RACE_SEATS, intEnv } from './lib/config.js';
import { call, errorCode, measureFloor } from './lib/api.js';
import { namedPractice } from './lib/practices.js';
import { loadSessions } from './lib/state.js';
import { SUMMARY_TREND_STATS, metricLines, submetricThresholds, writeSummary } from './lib/summary.js';

const BARRIER_S = intEnv('RACE_BARRIER', 60);
const sessions = loadSessions(RACE_COHORT.offset + RACE_COHORT.size);

const raceOk = new Counter('race_ok');
const raceFull = new Counter('race_full');
const raceOther = new Counter('race_other');
const raceSkew = new Trend('race_start_skew', true);
const participantsAfter = new Gauge('race_participants_after');

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,
  setupTimeout: '5m',
  scenarios: {
    race: {
      executor: 'per-vu-iterations',
      vus: RACE_COHORT.size,
      iterations: 1,
      maxDuration: `${BARRIER_S + 180}s`,
    },
  },
  thresholds: Object.assign(
    {
      race_ok: [`count==${RACE_SEATS}`],
      race_full: [`count==${RACE_COHORT.size - RACE_SEATS}`],
      race_other: ['count<=0'],
      sys_errors: ['rate<=0'],
      unexpected_4xx: ['count<=0'],
      race_participants_after: [`value==${RACE_SEATS}`],
      race_start_skew: ['p(95)<1000000000'],
    },
    submetricThresholds('http_req_duration', 'name', ['race_book']),
    submetricThresholds('http_req_duration', 'action', ['health']),
  ),
};

const RACE = namedPractice('race');

export function setup() {
  measureFloor();
  const res = call('GET', `/api/v1/practices/${RACE.id}`, {
    token: sessions[RACE_COHORT.offset].token, action: 'setup', ep: 'setup_practice_get',
  });
  if (res.status !== 200) {
    throw new Error(`REFUSED: the race practice answered ${res.status}.`);
  }
  const p = res.json();
  if (p.max_participants !== RACE_SEATS || p.current_participants !== 0) {
    throw new Error(
      `REFUSED: "${RACE.title}" has ${p.current_participants}/${p.max_participants} ` +
        `seats taken; the race needs an empty practice with ${RACE_SEATS}.`,
    );
  }
  const barrier = Date.now() + BARRIER_S * 1000;
  console.log(`race: "${RACE.title}", barrier in ${BARRIER_S} s`);
  return { practice: { id: RACE.id, title: RACE.title }, barrier };
}

export default function (ctx) {
  const session = sessions[RACE_COHORT.offset + exec.vu.idInTest - 1];
  const token = session.token;
  call('GET', '/api/v1/users/me', { token, action: 'race_warm', ep: 'users_me' });
  const wait = ctx.barrier - Date.now();
  if (wait > 0) {
    sleep(wait / 1000);
  } else {
    console.warn(`race: VU ${exec.vu.idInTest} warmed up ${-wait} ms after the barrier`);
  }
  raceSkew.add(Math.max(0, Date.now() - ctx.barrier));
  const res = call('POST', `/api/v1/practices/${ctx.practice.id}/purchase`, {
    token, action: 'race', ep: 'race_book', body: {}, expect: [400],
  });
  if (res.status === 201) {
    raceOk.add(1);
  } else if (res.status === 400 && errorCode(res) === 'practice_full') {
    raceFull.add(1);
  } else {
    raceOther.add(1, { status: String(res.status), code: errorCode(res) });
  }
}

export function teardown(ctx) {
  const res = call('GET', `/api/v1/practices/${ctx.practice.id}`, {
    token: sessions[RACE_COHORT.offset].token, action: 'teardown', ep: 'practice_get',
  });
  if (res.status === 200) {
    participantsAfter.add(res.json().current_participants);
  }
}

export function handleSummary(data) {
  return writeSummary(data, '04-race', [
    ...metricLines(data, 'race_ok', ['count']),
    ...metricLines(data, 'race_full', ['count']),
    ...metricLines(data, 'race_other', ['count']),
    ...metricLines(data, 'race_participants_after', ['value']),
    ...metricLines(data, 'race_start_skew', ['med', 'p(95)', 'max']),
    ...metricLines(data, 'http_req_duration{name', ['med', 'p(95)', 'max']),
  ]);
}
