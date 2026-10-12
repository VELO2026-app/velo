// =============================================================================
// VELO load tests -- 05 one hour: stable over time
// =============================================================================
//
// The live-student mix at STEADY_VUS (60 % of the break point from
// 01-break.js) for 60 minutes. The chart: p95 and errors per minute --
// http_req_duration{minute:*} and sys_errors{minute:*} in
// results/05-hour-summary.json; memory over the hour comes from the server
// sampling (README step 6), which runs for the whole hour.
//
// Run (from loadtest/): see README step 9.
// =============================================================================

import { steadyScenario } from './lib/steady.js';

const s = steadyScenario('05-hour', 60);

export const options = s.options;
export const setup = s.setup;
export default s.run;
export const handleSummary = s.summary;
