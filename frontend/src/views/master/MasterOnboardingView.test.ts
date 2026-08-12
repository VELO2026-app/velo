// =============================================================================
// VELO Frontend -- MasterOnboardingView Screen Tests
// =============================================================================
//
// WHY THIS FILE EXISTS (probekit-screen-test audit, rank 6, grouped with the
// user OnboardingView): a 3-slide carousel with NO store, NO API call at all
// (the SFC's own banner says persistence + hiding are the PARENT's job --
// this view only emits `done`) -- deliberately the simplest of the batch, but
// it still has its own re-entry guard (`finished`, .vue:85,93-97) worth
// proving rather than assuming from the sibling.
//
// PATTERN: no Pinia, no API mock -- nothing to seam. `done` is a root emit,
// captured the same way as auth/OnboardingView.test.ts: `onDone` passed as a
// root prop to createApp(MasterOnboardingView, { onDone }).
//
// THE GUARD, and how it differs from the user carousel's: `finished` is a
// single boolean, not a two-flag microtask race -- there is no timezone-step
// analogue here (no async gap to land inside), so `if (finished.value) return`
// at the very top of finish() (.vue:94) is a plain, always-effective re-entry
// guard: a same-tick double click at ANY point (mid-carousel OR on the last
// slide OR after Skip) fires `done` exactly once. Proven with true zero-tick
// double clicks (SC-17 idiom), not the "await between clicks" shape that
// would just prove the disabled attribute instead.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import MasterOnboardingView from '@/views/master/MasterOnboardingView.vue'

let app: App | null = null
let host: HTMLElement | null = null

function mount(onDone: () => void = () => {}): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(MasterOnboardingView, { onDone })
  app.mount(host)
  return host
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await nextTick()
}

function text(): string {
  return host?.textContent ?? ''
}

function primaryButton(): HTMLButtonElement {
  const b = host?.querySelector<HTMLButtonElement>('.master-onboarding__button')
  if (!b) throw new Error('.master-onboarding__button did not render')
  return b
}

function skipButton(): HTMLButtonElement {
  const b = host?.querySelector<HTMLButtonElement>('.master-onboarding__skip')
  if (!b) throw new Error('.master-onboarding__skip did not render')
  return b
}

function activeDotIndex(): number {
  const dots = Array.from(host?.querySelectorAll('.v-pagination-dots__dot') ?? [])
  return dots.findIndex((d) => d.classList.contains('v-pagination-dots__dot--active'))
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  vi.clearAllMocks()
})

describe('MasterOnboardingView', () => {
  it('starts on slide 0 with «Далее», dot 0 active', async () => {
    mount()
    await flush()

    expect(text()).toContain('Добро пожаловать')
    expect(primaryButton().textContent?.trim()).toBe('Далее')
    expect(activeDotIndex()).toBe(0)
  })

  it('«Далее» advances one slide per click and relabels the CTA on the last one', async () => {
    mount()
    await flush()

    primaryButton().click()
    await flush()
    expect(text()).toContain('Ваше пространство')
    expect(activeDotIndex()).toBe(1)
    expect(primaryButton().textContent?.trim()).toBe('Далее')

    primaryButton().click()
    await flush()
    expect(text()).toContain('AI-аналитика о состоянии группы')
    expect(activeDotIndex()).toBe(2)
    expect(primaryButton().textContent?.trim()).toBe('Войти в кабинет')
  })

  it('advancing never overshoots the last slide even with extra clicks', async () => {
    // Math.min(step+1, TOTAL_STEPS-1) (.vue:104) -- a click on the LAST slide
    // takes the isLastStep branch (finish()) instead, so this only proves the
    // cap holds for clicks that land while still short of it.
    mount()
    await flush()
    primaryButton().click()
    await flush()
    primaryButton().click()
    await flush()
    expect(activeDotIndex()).toBe(2)
    expect(primaryButton().textContent?.trim()).toBe('Войти в кабинет')
  })

  it('«Войти в кабинет» on the last slide finishes -- emits done exactly once', async () => {
    const onDone = vi.fn()
    mount(onDone)
    await flush()
    primaryButton().click()
    await flush()
    primaryButton().click()
    await flush()
    expect(text()).toContain('AI-аналитика о состоянии группы')

    primaryButton().click()
    await flush()

    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('«Пропустить» finishes immediately from slide 0, without visiting slides 1-2', async () => {
    const onDone = vi.fn()
    mount(onDone)
    await flush()

    skipButton().click()
    await flush()

    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('a same-tick double tap of the last-slide CTA emits done ONCE, not twice', async () => {
    // SC-17: no await between the clicks, so a :disabled/:loading binding (if
    // one existed) could not be what stops the second call -- there is none
    // here, so `finished` (.vue:85,94) is the ONLY thing standing.
    const onDone = vi.fn()
    mount(onDone)
    await flush()
    primaryButton().click()
    await flush()
    primaryButton().click()
    await flush()
    expect(primaryButton().textContent?.trim()).toBe('Войти в кабинет')

    const btn = primaryButton()
    btn.click()
    btn.click() // zero ticks between
    await flush()

    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('Skip after Skip (or after done) does not emit a second time', async () => {
    const onDone = vi.fn()
    mount(onDone)
    await flush()

    const skip = skipButton()
    skip.click()
    skip.click() // zero ticks between -- same `finished` guard, entered via Skip
    await flush()

    expect(onDone).toHaveBeenCalledTimes(1)
  })
})

// =============================================================================
// NOT COVERED, deliberately
// =============================================================================
// - What the PARENT does with `done` (persisting master_onboarding_completed,
//   hiding the overlay): explicitly the parent's job per the SFC's own
//   banner (.vue:20-21), not this screen's.
// =============================================================================
