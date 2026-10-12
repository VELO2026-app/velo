// =============================================================================
// VELO load tests -- constant load on the mix (tests 2 and 5)
// =============================================================================
//
// STEADY_VUS is required and has no default: it is 60 % of the break point
// that 01-break.js printed, and a made-up default would put a made-up number
// on the investor's chart.
//
// Every request carries a `minute` tag (m00, m01, ...), and each minute gets
// always-pass thresholds so its numbers land in the summary: the
// per-minute line of test 5 (and the stability of test 2) is read straight
// from <name>-summary.json, no CSV processing needed.
// =============================================================================

import exec from 'k6/execution';

import { intEnv } from './config.js';
import { MIX_ACTION_TAGS, mixIteration, mixSetup } from './mix.js';
import { loadSessions } from './state.js';
import {
  ALWAYS_PASS_P95, ALWAYS_PASS_RATE, SUMMARY_TREND_STATS, metricLines,
  submetricThresholds, writeSummary,
} from './summary.js';

export function minuteTag(m) {
  return `m${String(m).padStart(2, '0')}`;
}

/**
 * Options, setup, default and handleSummary for a constant-load mix run.
 *
 * @param {string} name      results stem ("02-steady" / "05-hour")
 * @param {number} minutes   duration
 */
export function steadyScenario(name, minutes) {
  const vus = intEnv('STEADY_VUS');
  const sessions = loadSessions(vus);
  const minuteTags = [];
  for (let m = 0; m <= minutes; m += 1) minuteTags.push(minuteTag(m));

  const options = {
    summaryTrendStats: SUMMARY_TREND_STATS,
    setupTimeout: '5m',
    scenarios: {
      steady: {
        executor: 'constant-vus',
        vus,
        duration: `${minutes}m`,
        gracefulStop: '30s',
      },
    },
    thresholds: Object.assign(
      {
        // The verdict lines of tests 2/5 (shown, not aborting).
        'http_req_duration{expected_response:true}': ['p(95)<500'],
        sys_errors: ['rate<0.01'],
      },
      submetricThresholds('action_duration', 'action', MIX_ACTION_TAGS),
      submetricThresholds('http_req_duration', 'action', ['health']),
      submetricThresholds('http_req_duration', 'minute', minuteTags, ALWAYS_PASS_P95),
      submetricThresholds('sys_errors', 'minute', minuteTags, ALWAYS_PASS_RATE),
    ),
  };

  function setup() {
    return mixSetup(sessions);
  }

  function run(ctx) {
    const session = sessions[exec.vu.idInTest - 1];
    const minute = Math.floor((Date.now() - exec.scenario.startTime) / 60000);
    mixIteration(session.token, ctx, { minute: minuteTag(minute) });
  }

  function summary(data) {
    return writeSummary(data, name, [
      `constant ${vus} VUs for ${minutes} min`,
      'per minute:',
      ...metricLines(data, 'http_req_duration{minute', ['med', 'p(95)', 'count']),
      ...metricLines(data, 'sys_errors{minute', ['rate']),
    ]);
  }

  return { options, setup, run, summary };
}
