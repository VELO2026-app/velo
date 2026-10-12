// =============================================================================
// VELO load tests -- this run's practices (from run.py)
// =============================================================================
//
// run.py creates the practices of every run through the API -- the feed for
// the mix, the race practice (test 4), the "start" practice (test 3) -- and
// cancels them after the run (BE-147). It hands their ids over in one JSON
// file, PRACTICES_FILE:
//
//   { "format": 1, "run_id": "...",
//     "feed":  [ { "id": "...", "title": "..." }, ... ],
//     "race":  { "id": "...", "title": "...", "max_participants": 20 },
//     "start": { "id": "...", "title": "...", "scheduled_at": "..." } }
//
// Read in the init context (open() exists only there). A missing or foreign
// file stops the run before the first request -- a scenario never guesses
// which practice to load.
// =============================================================================

const PRACTICES_FORMAT = 1;

function readPractices() {
  const path = (__ENV.PRACTICES_FILE || '').trim();
  if (path === '') {
    throw new Error('REFUSED: PRACTICES_FILE is empty. Scenarios run from loadtest/run.py.');
  }
  const data = JSON.parse(open(path));
  if (!data || data.format !== PRACTICES_FORMAT || !Array.isArray(data.feed)) {
    throw new Error(`REFUSED: ${path} is not a practices file (format ${PRACTICES_FORMAT}).`);
  }
  return data;
}

export const PRACTICES = readPractices();

/** The feed practices of the mix: [{ id, title }]. */
export function feedPractices() {
  if (PRACTICES.feed.length === 0) {
    throw new Error('REFUSED: the practices file has no feed practices.');
  }
  return PRACTICES.feed.map((p) => ({ id: p.id, title: p.title }));
}

/** One named practice ("race" / "start"), refused when absent. */
export function namedPractice(kind) {
  const p = PRACTICES[kind];
  if (!p || typeof p.id !== 'string') {
    throw new Error(`REFUSED: the practices file has no "${kind}" practice.`);
  }
  return p;
}
