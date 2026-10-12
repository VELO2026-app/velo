// =============================================================================
// VELO load tests -- 01 break point: how many students at once
// =============================================================================
//
// Ramping VUs on the live-student mix, plateau by plateau:
//   50 -> 100 -> 200 -> 400 -> 800 -> 1600   (BREAK_LEVELS overrides)
// Each plateau: RAMP (30 s) to the level, SETTLE (60 s, not judged -- the
// new VUs are still opening the app), MEASURE (BREAK_MEASURE, default 180 s).
//
// Every request carries a `stage` tag: rampN / settleN / vusN. Only vusN is
// judged, and each level has its own thresholds:
//   http_req_duration{stage:vusN}  p(95) < 500 ms
//   sys_errors{stage:vusN}         rate  < 1 %
// both abortOnFail, with delayAbortEval set to 90 s into THAT level's
// measure window (k6 counts the delay from the start of the test, per
// threshold -- metrics/thresholds.go). So a level is judged only once it has
// 90 s of its own data, and the run stops inside the first level that
// breaks. The break point is the last level that passed.
//
// Test 6 ("headroom") is the server side of this run: run.py keeps
// `velo loadtest-probe` sampling CPU, memory and connections throughout.
//
// Run by loadtest/run.py (both modes).
// =============================================================================

import exec from 'k6/execution';

import { intEnv } from './lib/config.js';
import { MIX_ACTION_TAGS, mixIteration, mixSetup } from './lib/mix.js';
import { loadSessions } from './lib/state.js';
import {
  SUMMARY_TREND_STATS, submetricThresholds, writeSummary,
} from './lib/summary.js';

const LEVELS = (__ENV.BREAK_LEVELS || '50,100,200,400,800,1600')
  .split(',')
  .map((v) => Number(v.trim()));
if (LEVELS.some((v) => !Number.isInteger(v) || v <= 0)) {
  throw new Error(`REFUSED: BREAK_LEVELS "${__ENV.BREAK_LEVELS}" is not a list of positive integers.`);
}
for (let i = 1; i < LEVELS.length; i += 1) {
  if (LEVELS[i] <= LEVELS[i - 1]) {
    throw new Error('REFUSED: BREAK_LEVELS must increase.');
  }
}
const RAMP_S = 30;
const SETTLE_S = 60;
const MEASURE_S = intEnv('BREAK_MEASURE', 180);
const JUDGE_AFTER_S = 90;
const P95_LIMIT_MS = 500;
const ERROR_LIMIT = 0.01;

const MAX_VUS = LEVELS[LEVELS.length - 1];
const sessions = loadSessions(MAX_VUS);

// The timeline: [{ until, tag }] in seconds from scenario start.
const timeline = [];
const stages = [];
const thresholds = {
  // Safety net over the whole run, independent of the per-level verdicts.
  sys_errors: [{ threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '120s' }],
};
let t = 0;
for (const level of LEVELS) {
  stages.push({ duration: `${RAMP_S}s`, target: level });
  stages.push({ duration: `${SETTLE_S + MEASURE_S}s`, target: level });
  timeline.push({ until: t + RAMP_S, tag: `ramp${level}` });
  timeline.push({ until: t + RAMP_S + SETTLE_S, tag: `settle${level}` });
  const measureStart = t + RAMP_S + SETTLE_S;
  timeline.push({ until: measureStart + MEASURE_S, tag: `vus${level}` });
  const judgeAt = `${measureStart + Math.min(JUDGE_AFTER_S, MEASURE_S)}s`;
  thresholds[`http_req_duration{stage:vus${level}}`] = [
    { threshold: `p(95)<${P95_LIMIT_MS}`, abortOnFail: true, delayAbortEval: judgeAt },
  ];
  thresholds[`sys_errors{stage:vus${level}}`] = [
    { threshold: `rate<${ERROR_LIMIT}`, abortOnFail: true, delayAbortEval: judgeAt },
  ];
  t = measureStart + MEASURE_S;
}
Object.assign(
  thresholds,
  submetricThresholds('action_duration', 'action', MIX_ACTION_TAGS),
  submetricThresholds('http_req_duration', 'action', ['health']),
);

function stageTag() {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  for (const seg of timeline) {
    if (elapsed < seg.until) return seg.tag;
  }
  return 'tail';
}

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,
  setupTimeout: '5m',
  scenarios: {
    break: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages,
      gracefulRampDown: '30s',
    },
  },
  thresholds,
};

export function setup() {
  return mixSetup();
}

export default function (ctx) {
  const session = sessions[exec.vu.idInTest - 1];
  mixIteration(session.token, ctx, { stage: stageTag() });
}

export function handleSummary(data) {
  const rows = [];
  let breakPoint = null;
  let firstFailed = null;
  for (const level of LEVELS) {
    const d = data.metrics[`http_req_duration{stage:vus${level}}`];
    const e = data.metrics[`sys_errors{stage:vus${level}}`];
    const reached = d && d.values.count > 0;
    const p95 = reached ? d.values['p(95)'] : null;
    const med = reached ? d.values.med : null;
    const rate = e && e.values ? e.values.rate : null;
    const ok = reached && p95 < P95_LIMIT_MS && rate !== null && rate < ERROR_LIMIT;
    if (reached && ok && firstFailed === null) breakPoint = level;
    if (reached && !ok && firstFailed === null) firstFailed = level;
    rows.push(
      `  ${String(level).padStart(5)} VUs  ` +
        (reached
          ? `med=${med.toFixed(0)}ms  p95=${p95.toFixed(0)}ms  ` +
            `errors=${(rate * 100).toFixed(2)}%  requests=${d.values.count}  ${ok ? 'PASS' : 'FAIL'}`
          : 'not reached'),
    );
  }
  const extra = [
    'per level (measure window only):',
    ...rows,
    `break point: ${breakPoint === null ? 'none passed' : `${breakPoint} VUs`}` +
      (firstFailed !== null
        ? `  (first failing level: ${firstFailed})`
        : '  (no level failed: the top level held -- the break is above it)'),
    breakPoint === null
      ? 'STEADY_VUS for tests 2 and 5: undetermined'
      : `STEADY_VUS for tests 2 and 5 (60 %): ${Math.floor(breakPoint * 0.6)}`,
  ];
  return writeSummary(data, '01-break', extra);
}
