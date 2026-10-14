// =============================================================================
// VELO load tests -- one HTTP wrapper, one error classification
// =============================================================================
//
// EVERY request of every scenario goes through call(), so the split the
// report depends on is made in exactly one place:
//
//   2xx                          -> success
//   4xx listed in `expect`       -> expected refusal (practice_full, already
//                                   booked, ...). NOT a system error.
//   401                          -> the session file is stale (Redis flushed,
//                                   stand reinstalled): the run is ABORTED --
//                                   every later number would be about 401s.
//   any other 4xx                -> unexpected_4xx: a harness defect or a
//                                   contract change. Counted and shown, never
//                                   folded into "fine".
//   5xx, timeout, no response    -> sys_errors. The ONLY error the charts show.
//
// http_req_failed is aligned with that split by setResponseCallback (4xx are
// "expected" for k6), so the web dashboard's error panel shows system errors
// only, the same quantity as sys_errors.
//
// The `name` tag is the action/endpoint label, never the raw URL: URLs carry
// UUIDs, and one time series per UUID would bury the dashboard.
// =============================================================================

import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

import { BASE_URL, REQUEST_TIMEOUT } from './config.js';

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

export const sysErrors = new Rate('sys_errors');
export const expected4xx = new Counter('expected_4xx');
export const unexpected4xx = new Counter('unexpected_4xx');
export const actionDuration = new Trend('action_duration', true);

let unexpectedLogged = 0;

/** The machine code of an error body ({"error": code, "message": ...}). */
export function errorCode(res) {
  try {
    const body = res.json();
    return body && typeof body.error === 'string' ? body.error : '';
  } catch (_e) {
    return '';
  }
}

/**
 * One API request.
 *
 * @param {string} method   GET / POST / DELETE
 * @param {string} path     "/api/v1/..." (query string included)
 * @param {object} opts
 *   token   session token (omit for unauthenticated calls)
 *   body    object -> JSON body; undefined -> no body
 *   action  user-level action tag (open_app, feed, book, ...)
 *   ep      endpoint label (defaults to action)
 *   expect  array of 4xx statuses that are a normal outcome here
 *   tags    extra tags (stage / bucket / minute)
 * @returns k6 Response
 */
export function call(method, path, opts = {}) {
  const tags = Object.assign(
    { action: opts.action || 'other', name: opts.ep || opts.action || 'other' },
    opts.tags || {},
  );
  const headers = { Accept: 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let payload = null;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  const res = http.request(method, `${BASE_URL}${path}`, payload, {
    headers,
    tags,
    timeout: REQUEST_TIMEOUT,
  });
  classify(res, tags, opts.expect || []);
  return res;
}

/** Record one response in the split described in the header. */
export function classify(res, tags, expect) {
  const status = res.status;
  const isSystem = status === 0 || status >= 500;
  sysErrors.add(isSystem ? 1 : 0, tags);
  if (status === 401) {
    exec.test.abort(
      `401 on "${tags.name}": the sessions file no longer matches the ` +
        'server (Redis flushed or the stand reinstalled). Delete .state/sessions.json and run run.py again.',
    );
  }
  if (status >= 400 && status < 500) {
    const code = errorCode(res);
    if (expect.includes(status)) {
      expected4xx.add(1, Object.assign({ status: String(status), code }, tags));
    } else {
      unexpected4xx.add(1, Object.assign({ status: String(status), code }, tags));
      if (unexpectedLogged < 20) {
        unexpectedLogged += 1;
        console.warn(`unexpected ${status} ${code} on ${tags.name}`);
      }
    }
  }
}

/** Run fn() and record its wall time as one user action. */
export function timedAction(action, tags, fn) {
  const started = Date.now();
  const result = fn();
  actionDuration.add(Date.now() - started, Object.assign({ action }, tags || {}));
  return result;
}

/**
 * The network floor (report §5): sequential GET /health right before the
 * test. It is not pure network -- /health pings Postgres and Redis -- so the
 * report shows it next to the connect/TLS breakdown, not instead of it.
 */
export function measureFloor(samples = 20) {
  for (let i = 0; i < samples; i += 1) {
    call('GET', '/health', { action: 'health', ep: 'health' });
  }
}
