// =============================================================================
// VELO load tests -- 03a peak before a practice starts: booking the cohort
// =============================================================================
//
// Books the 300 students of START_COHORT onto this run's "start" practice
// (PRACTICES_FILE, created by run.py ~15 minutes ahead) through
// POST /practices/{id}/purchase -- the path the frontend's BookingPopup uses.
// Idempotent: a student already holding the booking answers 409, counted as
// expected. This part is preparation, not the measured peak: 10 VUs, no
// think time.
//
// Run by loadtest/run.py, right before 03b.
// =============================================================================

import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

import { START_COHORT } from './lib/config.js';
import { call, measureFloor } from './lib/api.js';
import { namedPractice } from './lib/practices.js';
import { loadSessions } from './lib/state.js';
import { SUMMARY_TREND_STATS, metricLines, writeSummary } from './lib/summary.js';

const sessions = loadSessions(START_COHORT.offset + START_COHORT.size);
const booked = new Counter('start_booked');

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,
  setupTimeout: '5m',
  scenarios: {
    prepare: {
      executor: 'shared-iterations',
      vus: 10,
      iterations: START_COHORT.size,
      maxDuration: '10m',
    },
  },
  thresholds: {
    sys_errors: ['rate<=0'],
    unexpected_4xx: ['count<=0'],
    start_booked: ['count>=0'],
  },
};

const START = namedPractice('start');

export function setup() {
  measureFloor();
  const left = (Date.parse(START.scheduled_at) - Date.now()) / 1000;
  if (left < 300) {
    throw new Error(
      `REFUSED: "${START.title}" starts in ${Math.round(left)} s -- too close to ` +
        'prepare and still run the burst before the check-in window closes.',
    );
  }
  console.log(`start: preparing "${START.title}", starts in ${Math.round(left / 60)} min`);
  return { practice: { id: START.id, title: START.title } };
}

export default function (ctx) {
  const i = exec.scenario.iterationInTest;
  const session = sessions[START_COHORT.offset + i];
  const res = call('POST', `/api/v1/practices/${ctx.practice.id}/purchase`, {
    token: session.token, action: 'start_prepare', ep: 'purchase', body: {}, expect: [409],
  });
  if (res.status === 201) booked.add(1);
}

export function teardown(ctx) {
  const res = call('GET', `/api/v1/practices/${ctx.practice.id}`, {
    token: sessions[START_COHORT.offset].token, action: 'teardown', ep: 'practice_get',
  });
  if (res.status === 200) {
    console.log(
      `start: "${ctx.practice.title}" now has ${res.json().current_participants} ` +
        `participants (need ${START_COHORT.size})`,
    );
  }
}

export function handleSummary(data) {
  return writeSummary(data, '03a-start-prepare', [
    ...metricLines(data, 'start_booked', ['count']),
  ]);
}
