// =============================================================================
// VELO load tests -- constant load on the mix (tests 2 and 5)
// =============================================================================
//
// STEADY_VUS is required and has no default: run.py sets it to 60 % of the
// break point this run's test 1 found, and a made-up default would put a
// made-up number in the customer's report.
//
// RAMP, THEN JUDGE (BE-147). Started at once, every VU opens the app in the
// same second -- on dev the first minute of test 2 showed a 1.7 s median
// that was the start, not the server. So the VUs ramp up over RAMP_S, every
// request carries `phase: ramp | steady`, and the verdict thresholds and the
// report's headline numbers read the steady phase only; the ramp minute is
// still on the per-minute chart, marked as such.
//
// Every request also carries a `minute` tag (m00, m01, ...; m00 is the ramp)
// with always-pass thresholds, so the per-minute line is read straight from
// <name>-summary.json.
// =============================================================================

import exec from 'k6/execution';

import { intEnv } from './config.js';
import { MIX_ACTION_TAGS, mixIteration, mixSetup } from './mix.js';
import { loadSessions } from './state.js';
import {
  ALWAYS_PASS_P95, ALWAYS_PASS_RATE, SUMMARY_TREND_STATS, metricLines,
  submetricThresholds, writeSummary,
} from './summary.js';

export const RAMP_S = 60;

export function minuteTag(m) {
  return `m${String(m).padStart(2, '0')}`;
}

/**
 * Options, setup, default and handleSummary for a constant-load mix run.
 *
 * @param {string} name      results stem ("02-steady" / "05-hour")
 * @param {number} minutes   steady duration, after the ramp
 */
export function steadyScenario(name, minutes) {
  const vus = intEnv('STEADY_VUS');
  const sessions = loadSessions(vus);
  const minuteTags = [];
  for (let m = 0; m <= minutes + 1; m += 1) minuteTags.push(minuteTag(m));

  const options = {
    summaryTrendStats: SUMMARY_TREND_STATS,
    setupTimeout: '5m',
    scenarios: {
      steady: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: `${RAMP_S}s`, target: vus },
          { duration: `${minutes}m`, target: vus },
        ],
        gracefulRampDown: '30s',
      },
    },
    thresholds: Object.assign(
      {
        // The verdict lines (shown, not aborting): steady phase only.
        'http_req_duration{phase:steady}': ['p(95)<500'],
        'sys_errors{phase:steady}': ['rate<0.01'],
        'http_req_duration{phase:ramp}': [ALWAYS_PASS_P95],
      },
      // Per action, steady phase only (the report's speed table).
      Object.fromEntries(MIX_ACTION_TAGS.map(
        (a) => [`action_duration{phase:steady,action:${a}}`, [ALWAYS_PASS_P95]],
      )),
      submetricThresholds('http_req_duration', 'action', ['health']),
      submetricThresholds('http_req_duration', 'minute', minuteTags, ALWAYS_PASS_P95),
      submetricThresholds('sys_errors', 'minute', minuteTags, ALWAYS_PASS_RATE),
    ),
  };

  function setup() {
    return mixSetup();
  }

  function run(ctx) {
    const session = sessions[exec.vu.idInTest - 1];
    const elapsed = Date.now() - exec.scenario.startTime;
    mixIteration(session.token, ctx, {
      minute: minuteTag(Math.floor(elapsed / 60000)),
      phase: elapsed < RAMP_S * 1000 ? 'ramp' : 'steady',
    });
  }

  function summary(data) {
    return writeSummary(data, name, [
      `ramp ${RAMP_S} s to ${vus} VUs, then ${minutes} min steady`,
      ...metricLines(data, 'http_req_duration{phase', ['med', 'p(95)', 'count']),
      'per minute (m00 = ramp):',
      ...metricLines(data, 'http_req_duration{minute', ['med', 'p(95)', 'count']),
      ...metricLines(data, 'sys_errors{minute', ['rate']),
    ]);
  }

  return { options, setup, run, summary };
}
