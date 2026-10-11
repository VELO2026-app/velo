// =============================================================================
// VELO load tests -- finding the seeded practices (setup() only)
// =============================================================================
//
// GET /api/v1/practices has no text search (practices/router.py,
// list_practices_endpoint: master_id / direction / style / difficulty /
// dates / status / paging only), so the profile's practices are found by
// TITLE, paging the default feed. The default feed is "upcoming bookable":
// scheduled/live with scheduled_at in the future -- a started practice drops
// out of it, which is exactly when it stops being usable here.
//
// Everything is refused loudly rather than guessed: two practices with one
// title, a title that is missing, a feed too short to hold the profile.
// =============================================================================

import { call } from './api.js';
import { FEED_TITLE_PREFIX, TITLE_PREFIX } from './config.js';

const PAGE = 100;
const MAX_PAGES = 50;

/** Every feed practice whose title starts with the profile prefix. */
export function listLoadPractices(token) {
  const found = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = call('GET', `/api/v1/practices?limit=${PAGE}&offset=${page * PAGE}`, {
      token,
      action: 'setup',
      ep: 'setup_list_practices',
    });
    if (res.status !== 200) {
      throw new Error(`REFUSED: practice feed answered ${res.status} during setup.`);
    }
    const body = res.json();
    for (const p of body.items) {
      if (typeof p.title === 'string' && p.title.startsWith(`${TITLE_PREFIX} `)) {
        found.push({
          id: p.id,
          title: p.title,
          scheduled_at: p.scheduled_at,
          max_participants: p.max_participants,
          current_participants: p.current_participants,
        });
      }
    }
    if ((page + 1) * PAGE >= body.total || body.items.length === 0) {
      return found;
    }
  }
  throw new Error(`REFUSED: the feed is longer than ${MAX_PAGES * PAGE} practices.`);
}

/** The feed practices of the mix (never the race / start ones). */
export function feedPractices(all) {
  const feed = all.filter((p) => p.title.startsWith(FEED_TITLE_PREFIX));
  if (feed.length === 0) {
    throw new Error(
      'REFUSED: no "[load] feed" practices in the feed. Seed the profile ' +
        '11102026-loadtest on dev (README, step 2).',
    );
  }
  return feed;
}

/** Exactly-one lookup by full title; null when the title is not in the feed. */
export function byTitle(all, title) {
  const matches = all.filter((p) => p.title === title);
  if (matches.length > 1) {
    throw new Error(`REFUSED: ${matches.length} practices are titled "${title}".`);
  }
  return matches.length === 1 ? matches[0] : null;
}
