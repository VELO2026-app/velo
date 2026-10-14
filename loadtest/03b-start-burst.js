// =============================================================================
// VELO load tests -- 03b peak before a practice starts: the burst
// =============================================================================
//
// 300 booked students, each at a random moment inside one minute, do what
// the frontend does right before a practice:
//   dashboard card        GET  /bookings/me/upcoming    (finds the booking)
//   PRE check-in          POST /practices/{id}/checkin  {mood}
//   live screen           GET  /practices/{id}
//                         GET  /practices/{id}/zoom/resolve
//   "Войти"               POST /bookings/{booking}/join (only when resolve
//                         returned a url -- PracticeLiveView.vue canJoin)
//
// NAMED HONESTLY in the report as "peak before the start": the check-in
// window closes AT the start (checkin_window_closed) and join has no time
// gate at all (scheduled or live), so the server has no notion of "the
// minute before" -- what is measured is 300 students doing this within 60 s.
//
// Every request is tagged with a 10-second bucket (b00..b06) for the
// time-resolved chart; each bucket's numbers are in the summary.
//
// Run by loadtest/run.py, right after 03a.
// =============================================================================

import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

import { START_COHORT, intEnv } from './lib/config.js';
import { call, measureFloor, timedAction } from './lib/api.js';
import { namedPractice } from './lib/practices.js';
import { loadSessions } from './lib/state.js';
import {
  ALWAYS_PASS_RATE, SUMMARY_TREND_STATS, metricLines, submetricThresholds, writeSummary,
} from './lib/summary.js';

const WINDOW_S = intEnv('START_WINDOW', 60);
const sessions = loadSessions(START_COHORT.offset + START_COHORT.size);

const flowOk = new Counter('start_flow_ok');
const noBooking = new Counter('start_no_booking');
const noUrl = new Counter('start_no_url');

const buckets = [];
for (let b = 0; b <= Math.ceil(WINDOW_S / 10) + 3; b += 1) buckets.push(`b${String(b).padStart(2, '0')}`);

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,
  setupTimeout: '5m',
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: START_COHORT.size,
      iterations: 1,
      maxDuration: `${WINDOW_S + 120}s`,
    },
  },
  thresholds: Object.assign(
    {
      sys_errors: ['rate<=0'],
      unexpected_4xx: ['count<=0'],
      start_flow_ok: [`count>=${START_COHORT.size}`],
      start_no_booking: ['count<=0'],
      start_no_url: ['count<=0'],
    },
    submetricThresholds('http_req_duration', 'bucket', buckets),
    submetricThresholds('sys_errors', 'bucket', buckets, ALWAYS_PASS_RATE),
    submetricThresholds('http_req_duration', 'name', [
      'bookings_upcoming', 'checkin', 'practice_get', 'zoom_resolve', 'join',
    ]),
    submetricThresholds('http_req_duration', 'action', ['health']),
  ),
};

const START = namedPractice('start');

export function setup() {
  measureFloor();
  const res = call('GET', `/api/v1/practices/${START.id}`, {
    token: sessions[START_COHORT.offset].token, action: 'setup', ep: 'setup_practice_get',
  });
  if (res.status !== 200) {
    throw new Error(`REFUSED: the start practice answered ${res.status}.`);
  }
  const practice = res.json();
  if (practice.current_participants < START_COHORT.size) {
    throw new Error(
      `REFUSED: "${START.title}" has ${practice.current_participants} participants, ` +
        `the burst needs ${START_COHORT.size}. 03a-start-prepare.js did not finish.`,
    );
  }
  const left = (Date.parse(START.scheduled_at) - Date.now()) / 1000;
  if (left < WINDOW_S + 120) {
    throw new Error(
      `REFUSED: "${START.title}" starts in ${Math.round(left)} s; the check-in ` +
        'window closes at the start, the burst would run into it.',
    );
  }
  console.log(`start: burst on "${START.title}", starts in ${Math.round(left / 60)} min`);
  return { practice: { id: START.id, title: START.title } };
}

function bucketTag(t0) {
  return `b${String(Math.floor((Date.now() - t0) / 10000)).padStart(2, '0')}`;
}

export default function (ctx) {
  const session = sessions[START_COHORT.offset + exec.vu.idInTest - 1];
  const pid = ctx.practice.id;
  // Spread the cohort uniformly over the window, measured from the scenario
  // start (VU init time is not part of the minute).
  const startedAt = exec.scenario.startTime;
  const target = startedAt + Math.random() * WINDOW_S * 1000;
  const wait = target - Date.now();
  if (wait > 0) sleep(wait / 1000);

  const t0 = startedAt;
  const token = session.token;
  timedAction('start_flow', { bucket: bucketTag(t0) }, () => {
    let tags = { bucket: bucketTag(t0) };
    const up = call('GET', '/api/v1/bookings/me/upcoming', {
      token, action: 'start_flow', ep: 'bookings_upcoming', tags,
    });
    if (up.status !== 200) return;
    const booking = up.json().find((b) => b.practice_id === pid);
    if (!booking) {
      noBooking.add(1);
      return;
    }
    tags = { bucket: bucketTag(t0) };
    const ci = call('POST', `/api/v1/practices/${pid}/checkin`, {
      token, action: 'start_flow', ep: 'checkin', tags,
      body: { mood: 1 + Math.floor(Math.random() * 10) }, expect: [409],
    });
    tags = { bucket: bucketTag(t0) };
    call('GET', `/api/v1/practices/${pid}`, { token, action: 'start_flow', ep: 'practice_get', tags });
    const zr = call('GET', `/api/v1/practices/${pid}/zoom/resolve`, {
      token, action: 'start_flow', ep: 'zoom_resolve', tags,
    });
    const url = zr.status === 200 ? zr.json().url : null;
    if (!url) {
      noUrl.add(1);
      return;
    }
    tags = { bucket: bucketTag(t0) };
    const jn = call('POST', `/api/v1/bookings/${booking.id}/join`, {
      token, action: 'start_flow', ep: 'join', tags, expect: [409],
    });
    if (ci.status === 200 && jn.status === 200) flowOk.add(1);
  });
}

export function handleSummary(data) {
  return writeSummary(data, '03b-start-burst', [
    'per 10-second bucket:',
    ...metricLines(data, 'http_req_duration{bucket', ['med', 'p(95)', 'count']),
    ...metricLines(data, 'sys_errors{bucket', ['rate']),
    'per endpoint:',
    ...metricLines(data, 'http_req_duration{name', ['med', 'p(95)', 'count']),
    ...metricLines(data, 'start_flow_ok', ['count']),
    ...metricLines(data, 'start_no_booking', ['count']),
    ...metricLines(data, 'start_no_url', ['count']),
  ]);
}
