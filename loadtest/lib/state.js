// =============================================================================
// VELO load tests -- the sessions file and the results directory
// =============================================================================
//
// WHY ABSOLUTE PATHS. open() resolves relative to the script, handleSummary
// writes relative to the shell's working directory, and k6 creates no
// directories when it writes. A relative path would therefore read one file
// and write another as soon as k6 is started from anywhere but loadtest/ --
// and the warmup's logins (rate-limited, ~23 minutes for 2000) would be lost.
// import.meta.resolve() pins both sides to this module's own directory.
//
// THE SESSIONS FILE IS A SECRET: 30-day bearer tokens for every load
// student. It is git-ignored (loadtest/.gitignore), never printed, and the
// README's last step deletes it.
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

/** Absolute path of a file in loadtest/results/. */
export function resultPath(name) {
  return toPath(import.meta.resolve(`../results/${name}`));
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
        `not ${BASE_URL}. Re-run 00-warmup.js.`,
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
      `REFUSED: no sessions in ${SESSIONS_PATH}. Run 00-warmup.js first.`,
    );
  }
  if (sessions.length < needed) {
    throw new Error(
      `REFUSED: this scenario needs ${needed} sessions, the file has ` +
        `${sessions.length}. Re-run 00-warmup.js until it reports "missing: 0".`,
    );
  }
  return sessions;
}

/** Serialize the sessions file content (used by the warmup's handleSummary). */
export function sessionsFileContent(sessions) {
  return JSON.stringify({ format: SESSIONS_FORMAT, base_url: BASE_URL, sessions });
}
