// =============================================================================
// VELO load tests -- 03a peak before a practice starts: booking the cohort
// =============================================================================
//
// Books the 300 students of START_COHORT onto the chosen "[load] start N"
// practice (POST /practices/{id}/purchase -- the path the frontend's
// BookingPopup uses). Idempotent: a student who already holds the booking
// answers 409, counted as expected, so an interrupted prepare is simply run
// again. This part is preparation, not the measured peak: 10 VUs, no think
// time.
//
// Run (from loadtest/): see README step 7. Before 00:00 UTC of the seeding day.
// =============================================================================

import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

import { START_COHORT } from './lib/config.js';
import { call, measureFloor } from './lib/api.js';
import { chooseStartPractice, secondsToStart } from './lib/start.js';
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

export function setup() {
  measureFloor();
  const { practice, prepared } = chooseStartPractice(sessions);
  const left = secondsToStart(practice);
  if (left < 600) {
    throw new Error(
      `REFUSED: "${practice.title}" starts in ${Math.round(left)} s -- too close ` +
        'to prepare and still run the burst before the check-in window closes.',
    );
  }
  console.log(
    `start: preparing "${practice.title}" (${prepared ? 'partially booked' : 'fresh'}), ` +
      `starts in ${Math.round(left / 60)} min`,
  );
  return { practice };
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
