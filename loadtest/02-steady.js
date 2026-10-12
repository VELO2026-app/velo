// =============================================================================
// VELO load tests -- 02 working load: how fast, per action
// =============================================================================
//
// The live-student mix at STEADY_VUS (60 % of this run's break point):
// a 60 s ramp, then 15 minutes steady. The chart: med / p95 per action --
// action_duration{action:*} in 02-steady-summary.json (steady phase:
// the first minute is a ramp, see lib/steady.js).
//
// Run by loadtest/run.py (--full).
// =============================================================================

import { steadyScenario } from './lib/steady.js';

const s = steadyScenario('02-steady', 15);

export const options = s.options;
export const setup = s.setup;
export default s.run;
export const handleSummary = s.summary;
