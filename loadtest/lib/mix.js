// =============================================================================
// VELO load tests -- the "live student" mix (tests 1, 2, 5)
// =============================================================================
//
// One VU is one student with the Mini App open. The requests below are the
// ones the frontend actually sends (read from frontend/src, 2026-10-11):
//
//   OPEN APP   App.vue initAuth -> restoreSession GET /users/me; UserShell ->
//              GET /curator-groups/mine; UserDashboardView onMounted ->
//              GET /notifications, /bookings/me, /bookings/me/upcoming,
//              /bookings/me/stats (fired together -> one http.batch).
//              A REAL cold open logs in first (the token lives in
//              sessionStorage, which a relaunched Mini App loses). Logins are
//              rate-limited per source address, so the mix does NOT log in --
//              an assumption the report states, with the login cost measured
//              separately by the warmup.
//   BACKGROUND useRoleFreshness: GET /users/me every 30 s while foregrounded;
//              dashboard bell: GET /notifications every 60 s (a proxy into
//              comms -- this is the comms share of the load).
//
// Actions, one per think pause of 10-30 s (owner-approved split, gate R7):
//   feed 35 | practice 25 | diary 15 | profile 10 | book 7 | cancel 5 |
//   diary_write 3
// A "session" lasts 5-15 actions, then the app is opened again.
//
// The mix books ONLY "[load] feed" practices: the race and start practices
// are single-use, and a mix student taking a seat would spoil test 3 or 4.
// =============================================================================

import http from 'k6/http';
import { sleep } from 'k6';

import { BASE_URL, FEED_TITLE_PREFIX, REQUEST_TIMEOUT } from './config.js';
import { call, classify, measureFloor, timedAction } from './api.js';
import { feedPractices, listLoadPractices } from './practices.js';

export const MIX_ACTIONS = [
  ['feed', 35],
  ['practice', 25],
  ['diary', 15],
  ['profile', 10],
  ['book', 7],
  ['cancel', 5],
  ['diary_write', 3],
];

/** Every action tag the mix emits (for per-action sub-metrics). */
export const MIX_ACTION_TAGS = ['open_app', 'bg_me', 'bg_bell']
  .concat(MIX_ACTIONS.map(([name]) => name));

const ME_POLL_MS = 30000;
const BELL_POLL_MS = 60000;

// Per-VU state (module scope is per VU in k6).
const state = { actionsLeft: 0, lastMe: 0, lastBell: 0 };

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function pickAction() {
  let roll = Math.random() * 100;
  for (const [name, weight] of MIX_ACTIONS) {
    roll -= weight;
    if (roll < 0) return name;
  }
  return MIX_ACTIONS[0][0];
}

function batchGet(token, action, paths, tags) {
  const requests = paths.map(([ep, path]) => ({
    method: 'GET',
    url: `${BASE_URL}${path}`,
    params: {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      tags: Object.assign({ action, name: ep }, tags),
      timeout: REQUEST_TIMEOUT,
    },
  }));
  const responses = http.batch(requests);
  responses.forEach((res, i) => classify(res, requests[i].params.tags, []));
  return responses;
}

function openApp(token, tags) {
  timedAction('open_app', tags, () => {
    call('GET', '/api/v1/users/me', { token, action: 'open_app', ep: 'users_me', tags });
    batchGet(token, 'open_app', [
      ['curator_groups_mine', '/api/v1/curator-groups/mine'],
      ['notifications', '/api/v1/notifications'],
      ['bookings_me', '/api/v1/bookings/me?limit=20&offset=0'],
      ['bookings_upcoming', '/api/v1/bookings/me/upcoming'],
      ['bookings_stats', '/api/v1/bookings/me/stats'],
    ], tags);
  });
  const now = Date.now();
  state.lastMe = now;
  state.lastBell = now;
  state.actionsLeft = Math.floor(rand(5, 16));
}

function backgroundPolls(token, tags) {
  const now = Date.now();
  if (now - state.lastMe >= ME_POLL_MS) {
    timedAction('bg_me', tags, () => call('GET', '/api/v1/users/me', {
      token, action: 'bg_me', ep: 'users_me', tags,
    }));
    state.lastMe = now;
  }
  if (now - state.lastBell >= BELL_POLL_MS) {
    timedAction('bg_bell', tags, () => call('GET', '/api/v1/notifications', {
      token, action: 'bg_bell', ep: 'notifications', tags,
    }));
    state.lastBell = now;
  }
}

function weekWindow() {
  // Calendar week request: [day-1 .. day+8), the frontend widens by a day.
  const from = new Date(Date.now() + Math.floor(rand(0, 7)) * 86400000);
  from.setUTCHours(0, 0, 0, 0);
  from.setTime(from.getTime() - 86400000);
  const to = new Date(from.getTime() + 9 * 86400000 - 1);
  return `date_from=${encodeURIComponent(from.toISOString())}` +
    `&date_to=${encodeURIComponent(to.toISOString())}`;
}

const DIRECTIONS = ['meditation', 'yoga', 'somatic', 'breathwork', 'sound_healing',
  'narrative', 'circles', 'movement', 'art', 'tantra'];

const ACTIONS = {
  feed(token, ctx, tags) {
    const filter = Math.random() < 0.3 ? `&direction=${pick(DIRECTIONS)}` : '';
    call('GET', `/api/v1/practices?${weekWindow()}${filter}&limit=100&offset=0`, {
      token, action: 'feed', ep: 'practices_list', tags,
    });
  },
  practice(token, ctx, tags) {
    const p = pick(ctx.feed);
    call('GET', `/api/v1/practices/${p.id}`, { token, action: 'practice', ep: 'practice_get', tags });
    call('GET', '/api/v1/bookings/me?limit=20&offset=0', {
      token, action: 'practice', ep: 'bookings_me', tags,
    });
  },
  diary(token, ctx, tags) {
    call('GET', '/api/v1/diary/feed?limit=20', { token, action: 'diary', ep: 'diary_feed', tags });
  },
  profile(token, ctx, tags) {
    call('GET', '/api/v1/users/me', { token, action: 'profile', ep: 'users_me', tags });
    call('GET', '/api/v1/bookings/me/stats', { token, action: 'profile', ep: 'bookings_stats', tags });
  },
  book(token, ctx, tags) {
    // BookingPopup: open (balance refresh = GET /users/me), preview, purchase.
    const p = pick(ctx.feed);
    call('GET', `/api/v1/practices/${p.id}`, { token, action: 'book', ep: 'practice_get', tags });
    call('GET', '/api/v1/users/me', { token, action: 'book', ep: 'users_me', tags });
    call('POST', `/api/v1/practices/${p.id}/preview-purchase`, {
      token, action: 'book', ep: 'preview_purchase', body: {}, tags,
    });
    // 409: this student already holds a booking on that practice.
    call('POST', `/api/v1/practices/${p.id}/purchase`, {
      token, action: 'book', ep: 'purchase', body: {}, expect: [409], tags,
    });
  },
  cancel(token, ctx, tags) {
    const res = call('GET', '/api/v1/bookings/me?status=confirmed&limit=20&offset=0', {
      token, action: 'cancel', ep: 'bookings_me', tags,
    });
    if (res.status !== 200) return;
    const own = res.json().items.filter(
      (b) => b.practice && typeof b.practice.title === 'string' &&
        b.practice.title.startsWith(FEED_TITLE_PREFIX),
    );
    if (own.length === 0) return;
    // 400/404/409: the booking changed state between the list and the
    // cancel (only this student touches it, so this is not expected to fire;
    // it is listed so a real occurrence is visible as "expected", not lost).
    call('DELETE', `/api/v1/bookings/${pick(own).id}`, {
      token, action: 'cancel', ep: 'booking_cancel', expect: [400, 404, 409], tags,
    });
  },
  diary_write(token, ctx, tags) {
    call('POST', '/api/v1/diary', {
      token, action: 'diary_write', ep: 'diary_create', tags,
      body: { content: 'Нагрузочный тест: короткая запись в дневник.', mood: 1 + Math.floor(Math.random() * 10) },
    });
  },
};

/**
 * One mix iteration for a VU: (re)open the app when the session is over,
 * background polls that are due, one action, one think pause.
 *
 * @param {string} token  this VU's session token
 * @param {object} ctx    setup data: { feed: [practice...] }
 * @param {object} tags   extra tags for every request (stage / minute)
 */
export function mixIteration(token, ctx, tags) {
  if (state.actionsLeft <= 0) {
    openApp(token, tags);
  }
  backgroundPolls(token, tags);
  const action = pickAction();
  timedAction(action, tags, () => ACTIONS[action](token, ctx, tags));
  state.actionsLeft -= 1;
  sleep(rand(10, 30));
}

/**
 * setup() of a mix scenario: the network floor, then the feed practices the
 * mix may book. Returned as setup data ({ feed }), copied to every VU.
 */
export function mixSetup(sessions) {
  measureFloor();
  const feed = feedPractices(listLoadPractices(sessions[0].token)).map(
    (p) => ({ id: p.id, title: p.title }),
  );
  console.log(`mix: ${feed.length} feed practices`);
  return { feed };
}
