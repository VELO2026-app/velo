// =============================================================================
// @velo/ui -- bottom-sheet drag physics (FE-233, package 2)
// =============================================================================
//
// Three small pure helpers behind VBottomSheet's swipe:
//
//  - rubberBand: a pull past the resting position meets rising resistance
//    instead of a hard stop.
//  - createVelocityTracker: finger speed over the last ~100 ms, so a release
//    hands the sheet the speed the finger really had (not just the last delta).
//  - springTo: a damped spring from the release offset back to rest, started
//    with the finger's velocity.
//
// The shapes follow the rubber-band, velocity and spring modules of Vercel's
// UI SDK (https://github.com/vercel-labs/ui, Apache-2.0); this is an
// independent re-implementation, not a copy.
// =============================================================================

/** Rubber-band constant: the share of the pull that passes through at the start. */
const RUBBER_COEFFICIENT = 0.55

/**
 * Resist a pull of `distance` px: it grows with `distance` but never passes `limit`.
 *
 * @param distance - Raw finger travel past the resting position, px (>= 0).
 * @param limit - The asymptote the result approaches, px.
 */
export function rubberBand(distance: number, limit: number): number {
  if (distance <= 0) return 0
  return (1 - 1 / ((distance * RUBBER_COEFFICIENT) / limit + 1)) * limit
}

/** How far back a velocity sample still counts, ms. */
const VELOCITY_WINDOW_MS = 100

/** Finger speed over a short sliding window. */
export interface VelocityTracker {
  /** Record the finger's Y at time `t` (ms). */
  push: (y: number, t: number) => void
  /** Speed in px/ms (positive = downward); 0 with fewer than two samples. */
  velocity: () => number
  /** Forget all samples. */
  reset: () => void
}

/** Make a velocity tracker over the last 100 ms of samples. */
export function createVelocityTracker(): VelocityTracker {
  let samples: Array<{ y: number; t: number }> = []
  return {
    push(y, t) {
      samples.push({ y, t })
      samples = samples.filter((s) => t - s.t <= VELOCITY_WINDOW_MS)
    },
    velocity() {
      const first = samples[0]
      const last = samples[samples.length - 1]
      if (!first || !last || last.t <= first.t) return 0
      return (last.y - first.y) / (last.t - first.t)
    },
    reset() {
      samples = []
    },
  }
}

const SPRING_STIFFNESS = 420
// zeta ~ 0.88: settles fast with a small, natural overshoot.
const SPRING_DAMPING = 36
const SPRING_STEP_S = 1 / 240
const SPRING_MAX_FRAME_S = 1 / 20
const SPRING_REST_PX = 0.4
const SPRING_REST_PX_PER_S = 8

/**
 * Spring from `from` px to 0, starting at `velocity` px/s.
 *
 * @param apply - Called with the current offset on every frame.
 * @param done - Called once, after the final `apply(0)`; not called if cancelled.
 * @returns A cancel function: stops the spring where it is.
 */
export function springTo(
  from: number,
  velocity: number,
  apply: (offset: number) => void,
  done: () => void,
): () => void {
  let x = from
  let v = velocity
  let last: number | null = null
  let frame = 0
  const tick = (now: number): void => {
    const elapsed =
      last === null ? SPRING_STEP_S : Math.min((now - last) / 1000, SPRING_MAX_FRAME_S)
    last = now
    for (let spent = 0; spent < elapsed; spent += SPRING_STEP_S) {
      v += (-SPRING_STIFFNESS * x - SPRING_DAMPING * v) * SPRING_STEP_S
      x += v * SPRING_STEP_S
    }
    if (Math.abs(x) < SPRING_REST_PX && Math.abs(v) < SPRING_REST_PX_PER_S) {
      apply(0)
      done()
      return
    }
    apply(x)
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(frame)
}
