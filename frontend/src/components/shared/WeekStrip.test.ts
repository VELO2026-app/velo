// =============================================================================
// VELO Frontend -- WeekStrip day-ribbon tests (owner pass, 2026-08-27)
// =============================================================================
//
// The strip is a DAY RIBBON: dragging slides day pills through the viewport
// one by one (the ribbon renders -beforeDays..+27 days around the window
// start); release snaps to the NEAREST WHOLE DAY and commits via `shift-days`
// with the day delta. Back is clamped by maxBackDays (rubber band at today).
// No arrows (owner pass): the drag IS the navigation.
//
// Pointer events are dispatched as MouseEvent('pointer...') -- the handlers
// only read clientX/clientY/button, and the event TYPE is what routes, so
// no PointerEvent polyfill is needed in happy-dom. Pills have no layout
// there (offsetWidth 0), so the component's stride fallback (50px) drives
// the snap math: -60px -> 1 day, -120px -> 2, +80px -> 2 back, -20px -> 0.
//
// The commit sleeps ~220ms before the emit -- tests await real timers
// (~700ms worst case), comfortably inside the 5s per-test budget.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import WeekStrip from './WeekStrip.vue'

// A stable week: Mon 2026-08-24 .. Sun 2026-08-30.
const DAYS = [24, 25, 26, 27, 28, 29, 30].map((d) => new Date(2026, 7, d))

function keyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

let host: HTMLElement | null = null
let app: App | null = null
let shiftDays: ReturnType<typeof vi.fn>
let selectDay: ReturnType<typeof vi.fn>

function mount(maxBackDays = 7, days: Date[] = DAYS): void {
  shiftDays = vi.fn()
  selectDay = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(WeekStrip, {
    days,
    selectedDate: keyOf(DAYS[3]!),
    daysWithPractices: new Set([keyOf(DAYS[2]!)]),
    localDateKey: keyOf,
    maxBackDays,
    onShiftDays: shiftDays,
    onSelectDay: selectDay,
  })
  app.mount(host)
}

function unmount(): void {
  app?.unmount()
  host?.remove()
  host = null
}

function viewport(): HTMLElement {
  const el = host?.querySelector('.week-strip__viewport')
  if (!el) throw new Error('viewport did not render')
  return el as HTMLElement
}

function ptr(type: string, x: number, y = 10): void {
  viewport().dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }))
}

async function settle(): Promise<void> {
  // Snap animation (220) + margin.
  await new Promise((r) => setTimeout(r, 700))
  await nextTick()
}

describe('WeekStrip -- day ribbon', () => {
  it('a one-day drag (-60px) commits shift-days(1) -- ONE day, not a week', async () => {
    mount()
    ptr('pointerdown', 200)
    ptr('pointermove', 140)
    ptr('pointerup', 140)
    await settle()
    expect(shiftDays).toHaveBeenCalledTimes(1)
    expect(shiftDays).toHaveBeenCalledWith(1)
    unmount()
  })

  it('a longer drag (-120px) commits TWO days -- days flow one by one', async () => {
    mount()
    ptr('pointerdown', 200)
    ptr('pointermove', 80)
    ptr('pointerup', 80)
    await settle()
    expect(shiftDays).toHaveBeenCalledWith(2)
    unmount()
  })

  it('a right drag (+80px) commits shift-days(-2) when there is room back', async () => {
    mount(7)
    ptr('pointerdown', 100)
    ptr('pointermove', 180)
    ptr('pointerup', 180)
    await settle()
    expect(shiftDays).toHaveBeenCalledWith(-2)
    unmount()
  })

  it('at today (maxBackDays 0) a right drag rubber-bands, renders NO past pills, and NEVER commits back', async () => {
    mount(0)
    // The backward headroom is ZERO at the today limit: nothing renders
    // before day 0 (indices 0..RIBBON_AFTER only = 28 pills, not 42).
    expect(host!.querySelectorAll('.week-strip__day').length).toBe(28)
    ptr('pointerdown', 100)
    ptr('pointermove', 300) // +200px raw -> ~70px after the 0.35 band
    ptr('pointerup', 300)
    await settle()
    expect(shiftDays).not.toHaveBeenCalled()
    unmount()
  })

  it('backward drag is bounded by the ribbon headroom (14 days), even when maxBackDays is larger', async () => {
    mount(30)
    ptr('pointerdown', 100)
    ptr('pointermove', 800) // +700px = exactly 14 strides (fallback 50px)
    ptr('pointerup', 800)
    await settle()
    expect(shiftDays).toHaveBeenCalledTimes(1)
    expect(shiftDays).toHaveBeenCalledWith(-14)
    unmount()
  })

  it('a sub-day drag (-20px) snaps back -- no shift, no week emit', async () => {
    mount()
    ptr('pointerdown', 200)
    ptr('pointermove', 180)
    ptr('pointerup', 180)
    await settle()
    expect(shiftDays).not.toHaveBeenCalled()
    unmount()
  })

  it('a clean day tap still selects (the drag guard did not eat it)', async () => {
    mount()
    // The ribbon renders -beforeDays..+27 around the window (beforeDays =
    // min(14, maxBackDays) = 7 here); the VISIBLE first pill (day 0) is at
    // array index beforeDays, so DAYS[2] is at index 9.
    const day = host!.querySelectorAll('.week-strip__day')[9]! as HTMLElement
    day.click()
    await nextTick()
    expect(selectDay).toHaveBeenCalledWith(keyOf(DAYS[2]!))
    unmount()
  })

  it('[baseline] the resting transform pins day 0 at column 0: -beforeDays strides', () => {
    // At today (beforeDays 0): identity.
    mount(0)
    const t0 = host!.querySelector<HTMLElement>('.week-strip__days')!.style.transform
    expect(t0).toBe('translateX(0px)')
    unmount()

    // A week past today (beforeDays 7, fallback stride 50): -350px. THE
    // SIGN is the assertion -- a + here is the ribbon-flys-away bug.
    mount(7)
    const t7 = host!.querySelector<HTMLElement>('.week-strip__days')!.style.transform
    expect(t7).toBe('translateX(-350px)')
    unmount()
  })

  it('[month chip] one month visible -> a single line; a straddling span -> TWO stacked lines', async () => {
    mount()
    // Visible five: 24..28 Aug.
    const lines = () =>
      Array.from(host!.querySelectorAll('.week-strip__month-chip-months span')).map((s) =>
        s.textContent?.trim(),
      )
    expect(lines()).toEqual(['Авг'])
    unmount()

    // Aug 28 .. Sep 3: visible five = 28,29,30,31,01 -> two lines, no dash.
    const straddle = [28, 29, 30, 31].map((d) => new Date(2026, 7, d))
    straddle.push(new Date(2026, 8, 1))
    mount(7, straddle)
    expect(lines()).toEqual(['Авг', 'Сен'])
    unmount()
  })
})
