// =============================================================================
// VELO load tests -- the sessions file and the results directory
// =============================================================================
//
// WHY ABSOLUTE PATHS. open() resolves relative to the script and
// handleSummary writes relative to the shell's working directory. The
// sessions file is pinned to this module's directory (import.meta.resolve),
// the results to RESULTS_DIR -- neither depends on where k6 was started.
// run.py writes the sessions file (its warmup logs the students in) and
// creates RESULTS_DIR; k6 only reads the one and writes into the other.
//
// THE SESSIONS FILE IS A SECRET: 30-day bearer tokens for every load
// student. It is git-ignored (loadtest/.gitignore), never printed, and the
// It never leaves the Mac it was made on.
//
// Format: { "format": 1, "base_url": "...", "sessions": [
//            { "telegram_id": 710001, "token": "...", "user_id": "uuid" }, ... ] }
// =============================================================================

import { SharedArray } from 'k6/data';

import { BASE_URL } from './config.js';

export const SESSIONS_FORMAT = 1;

function toPath(fileUrl) {
  return decodeURIComponent(fileUrl.replace(/^file:\/\//, ''));
}

export const SESSIONS_URL = import.meta.resolve('../.state/sessions.json');
export const SESSIONS_PATH = toPath(SESSIONS_URL);

// Every result file of a run goes to RESULTS_DIR, an absolute directory
// run.py creates per run (results/<date-time>/). Required: a scenario run by
// hand would otherwise scatter files that no report ever reads.
const RESULTS_DIR = (__ENV.RESULTS_DIR || '').trim();
if (RESULTS_DIR === '' || !RESULTS_DIR.startsWith('/')) {
  throw new Error('REFUSED: RESULTS_DIR must be an absolute directory. Scenarios run from loadtest/run.py.');
}

/** Absolute path of a file in this run's results directory. */
export function resultPath(name) {
  return `${RESULTS_DIR}/${name}`;
}

/**
 * Parse the sessions file, or return null when there is none yet.
 * INIT CONTEXT ONLY (open() is unavailable later).
 *
 * Throws on a file that exists but is not ours: a half-written or foreign
 * file must stop the run, not be silently treated as "no sessions".
 */
export function readSessionsFile() {
  let raw;
  try {
    raw = open(SESSIONS_URL);
  } catch (_e) {
    return null;
  }
  const data = JSON.parse(raw);
  if (!data || data.format !== SESSIONS_FORMAT || !Array.isArray(data.sessions)) {
    throw new Error(`REFUSED: ${SESSIONS_PATH} is not a sessions file (format ${SESSIONS_FORMAT}).`);
  }
  if (data.base_url !== BASE_URL) {
    throw new Error(
      `REFUSED: ${SESSIONS_PATH} holds sessions for ${data.base_url}, ` +
        `not ${BASE_URL}. Delete it; run.py logs the students in again.`,
    );
  }
  return data;
}

/**
 * The sessions as a SharedArray (parsed once, shared by all VUs -- 1600 VUs
 * each parsing their own copy would cost the generator hundreds of MB).
 *
 * @param {number} needed  how many sessions the scenario will use
 */
export function loadSessions(needed) {
  const sessions = new SharedArray('sessions', () => {
    const data = readSessionsFile();
    return data ? data.sessions : [];
  });
  if (sessions.length === 0) {
    throw new Error(
      `REFUSED: no sessions in ${SESSIONS_PATH}. Scenarios run from loadtest/run.py.`,
    );
  }
  if (sessions.length < needed) {
    throw new Error(
      `REFUSED: this scenario needs ${needed} sessions, the file has ` +
        `${sessions.length}. run.py logs the missing ones in before the tests.`,
    );
  }
  return sessions;
}

