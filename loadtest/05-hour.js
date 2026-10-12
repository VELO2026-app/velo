// =============================================================================
// VELO load tests -- 05 one hour: stable over time
// =============================================================================
//
// The live-student mix at STEADY_VUS (60 % of this run's break point):
// a 60 s ramp, then 60 minutes steady. The chart: p95 and errors per minute --
// http_req_duration{minute:*} and sys_errors{minute:*} in
// 05-hour-summary.json; memory over the hour comes from the server probe.
//
// Run by loadtest/run.py (--full).
// =============================================================================

import { steadyScenario } from './lib/steady.js';

const s = steadyScenario('05-hour', 60);

export const options = s.options;
export const setup = s.setup;
export default s.run;
export const handleSummary = s.summary;
