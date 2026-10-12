// =============================================================================
// VELO load tests -- 02 working load: how fast, per action
// =============================================================================
//
// The live-student mix at STEADY_VUS (60 % of the break point from
// 01-break.js) for 15 minutes. The chart: med / p95 per action --
// action_duration{action:*} in results/02-steady-summary.json.
//
// Run (from loadtest/): see README step 5.
// =============================================================================

import { steadyScenario } from './lib/steady.js';

const s = steadyScenario('02-steady', 15);

export const options = s.options;
export const setup = s.setup;
export default s.run;
export const handleSummary = s.summary;
