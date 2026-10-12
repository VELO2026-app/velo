// =============================================================================
// VELO load tests -- what every scenario leaves in loadtest/results/
// =============================================================================
//
// <name>-summary.json : k6's end-of-test data (all metrics, all tagged
//                       sub-metrics, threshold verdicts) WITHOUT setup_data.
//                       setup_data never holds secrets here, and still
//                       never goes into a results file.
// stdout              : a short table of the headline numbers.
//
// The raw time series (--out csv=<RESULTS_DIR>/<name>.csv.gz) is set by
// run.py on the k6 command line; render.py reads both.
// =============================================================================

import { resultPath } from './state.js';

// A threshold that cannot fail. k6 puts a tagged sub-metric into the summary
// ONLY when a threshold names it, so per-action / per-stage / per-minute
// numbers are made visible this way; the real verdicts are separate.
export const ALWAYS_PASS_P95 = 'p(95)<1000000000';
export const ALWAYS_PASS_RATE = 'rate<=1';
export const ALWAYS_PASS_COUNT = 'count>=0';

// Percentiles in every summary: k6's default set has no p(50) ("med") count
// pair the report needs, so every scenario uses this one.
export const SUMMARY_TREND_STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'];

/**
 * Always-pass thresholds for `metric{tag:value}` over `values`, so each
 * sub-metric lands in the summary data.
 */
export function submetricThresholds(metric, tag, values, expr = ALWAYS_PASS_P95) {
  const out = {};
  for (const v of values) out[`${metric}{${tag}:${v}}`] = [expr];
  return out;
}

function fmt(value) {
  if (value === undefined || value === null) return '-';
  if (typeof value === 'number') return value.toFixed(value >= 100 ? 0 : 2);
  return String(value);
}

/**
 * One line per metric (or sub-metric) matching `prefix`: "name" matches the
 * metric and all its sub-metrics, "name{tag" only the sub-metrics by tag.
 */
export function metricLines(data, prefix, fields) {
  const match = prefix.includes('{')
    ? (k) => k.startsWith(prefix)
    : (k) => k === prefix || k.startsWith(`${prefix}{`);
  return Object.keys(data.metrics)
    .filter(match)
    .sort()
    .map((k) => {
      const v = data.metrics[k].values;
      return `  ${k}  ${fields.map((f) => `${f}=${fmt(v[f])}`).join('  ')}`;
    });
}

/**
 * Build the handleSummary result for scenario `name`.
 *
 * @param {object} data   k6 summary data
 * @param {string} name   results file stem, e.g. "01-break"
 * @param {string[]} extraLines  scenario-specific stdout lines
 */
export function writeSummary(data, name, extraLines = []) {
  const clean = Object.assign({}, data);
  delete clean.setup_data;
  const lines = [
    `=== ${name} ===`,
    ...metricLines(data, 'action_duration', ['med', 'p(95)', 'count']),
    ...metricLines(data, 'sys_errors', ['rate', 'passes']),
    ...metricLines(data, 'unexpected_4xx', ['count']),
    ...metricLines(data, 'expected_4xx', ['count']),
    ...extraLines,
    `results: ${resultPath(`${name}-summary.json`)}`,
    '',
  ];
  return {
    stdout: lines.join('\n'),
    [resultPath(`${name}-summary.json`)]: JSON.stringify(clean, null, 2),
  };
}
