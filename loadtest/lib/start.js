// =============================================================================
// VELO load tests -- choosing the "start" practice for test 3
// =============================================================================
//
// Test 3 is single-use per practice: a PRE check-in is accepted once per
// booking (diary/checkins_service.py, 409 on a repeat) and so is join
// (bookings/service.py join_booking, 409 "Already joined"). The profile
// therefore carries three copies, "[load] start 1..3", all at 00:00 UTC of
// the day after seeding, and both halves of the test pick the same one:
// the first copy still in the feed whose cohort has NOT checked in yet.
//
// "Burned" is read from the first cohort student's own bookings
// (GET /bookings/me/upcoming -> has_checkin / joined_at): the burst checks in
// every student, so one burned booking means the copy has been used.
//
// The PRE check-in window is [start - 24 h, start) (checkin_window_hours,
// diary/checkins_service.py) and the feed hides a practice once it has
// started, so after 00:00 UTC no copy is found and the test refuses: the
// copies are spent for good (the seed is idempotent by title and will not
// recreate them).
// =============================================================================

import { call } from './api.js';
import { START_COHORT, START_TITLES } from './config.js';
import { byTitle, listLoadPractices } from './practices.js';

/**
 * The start practice to use now, with its booking state for the cohort.
 *
 * @param {Array} sessions   all sessions (SharedArray)
 * @returns {{ practice: object, prepared: boolean }}
 */
export function chooseStartPractice(sessions) {
  const probe = sessions[START_COHORT.offset];
  const all = listLoadPractices(probe.token);
  const res = call('GET', '/api/v1/bookings/me/upcoming', {
    token: probe.token, action: 'setup', ep: 'setup_bookings_upcoming',
  });
  if (res.status !== 200) {
    throw new Error(`REFUSED: bookings of the probe student answered ${res.status}.`);
  }
  const bookings = res.json();
  for (const title of START_TITLES) {
    const practice = byTitle(all, title);
    if (practice === null) continue;
    const booking = bookings.find((b) => b.practice_id === practice.id);
    if (booking && (booking.has_checkin || booking.joined_at)) continue;
    return { practice, prepared: Boolean(booking) };
  }
  throw new Error(
    'REFUSED: no unused "[load] start N" practice in the feed. Either all ' +
      'three copies are spent, or it is past 00:00 UTC of the seeding day and ' +
      'they have started. Test 3 cannot run again on this stand without a ' +
      'reinstall (README, step 7).',
  );
}

/** Seconds until the practice starts. */
export function secondsToStart(practice) {
  return (Date.parse(practice.scheduled_at) - Date.now()) / 1000;
}
