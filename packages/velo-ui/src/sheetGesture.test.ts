import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVelocityTracker, rubberBand, springTo } from './sheetGesture'

describe('rubberBand', () => {
  it('passes nothing for a pull that has not started', () => {
    expect(rubberBand(0, 72)).toBe(0)
    expect(rubberBand(-10, 72)).toBe(0)
  })

  it('resists more the further it is pulled, and never passes the limit', () => {
    const near = rubberBand(20, 72)
    const far = rubberBand(200, 72)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(20)
    expect(far).toBeGreaterThan(near)
    expect(far).toBeLessThan(72)
    expect(rubberBand(1e6, 72)).toBeLessThan(72)
  })
})

describe('createVelocityTracker', () => {
  it('is 0 before two samples exist', () => {
    const tracker = createVelocityTracker()
    expect(tracker.velocity()).toBe(0)
    tracker.push(10, 0)
    expect(tracker.velocity()).toBe(0)
  })

  it('reads speed over the last 100 ms only: an old fast start does not count', () => {
    const tracker = createVelocityTracker()
    tracker.push(0, 0)
    tracker.push(500, 10) // fast start, long gone by the end
    tracker.push(500, 200)
    tracker.push(510, 260)
    // Window = samples at 200 and 260 (and 10 dropped): 10 px in 60 ms.
    expect(tracker.velocity()).toBeCloseTo(10 / 60, 5)
  })

  it('reset forgets everything', () => {
    const tracker = createVelocityTracker()
    tracker.push(0, 0)
    tracker.push(50, 10)
    tracker.reset()
    expect(tracker.velocity()).toBe(0)
  })
})

describe('springTo', () => {
  let frames: Array<(now: number) => void>

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = []
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  /** Run frames at 60 fps until the spring stops asking for more. */
  function run(): void {
    let now = 0
    while (frames.length > 0 && now < 5000) {
      const next = frames.shift()!
      now += 16
      next(now)
    }
  }

  it('settles at exactly 0 and reports done once', () => {
    const applied: number[] = []
    const done = vi.fn()
    springTo(80, 0, (x) => applied.push(x), done)
    run()
    expect(applied.at(-1)).toBe(0)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('a start velocity away from rest carries the offset further out before it returns', () => {
    const slow: number[] = []
    springTo(40, 0, (x) => slow.push(x), vi.fn())
    run()
    const fast: number[] = []
    springTo(40, 2000, (x) => fast.push(x), vi.fn())
    run()
    expect(Math.max(...fast)).toBeGreaterThan(Math.max(...slow))
  })

  it('cancel stops it where it is: no more frames, no done', () => {
    const done = vi.fn()
    const cancel = springTo(80, 0, vi.fn(), done)
    cancel()
    run()
    expect(done).not.toHaveBeenCalled()
  })
})
