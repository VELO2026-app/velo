// =============================================================================
// VELO Frontend -- DiaryThreadCard Tests (thread-events UI)
// =============================================================================
//
// Kind -> MARKUP coverage for the thread renderer: each of the five explicit
// visual forms (system banner / check-in bubble / mirrored feedback bubble /
// practice card / split entry) plus the unknown-kind fallback. happy-dom
// proves structure (classes, text, tap payloads) -- never pixel geometry: the
// exact Figma silhouette and slot offsets are reviewed in a real browser.
//
// Mount convention: this repo's component tests use createApp + a wrapper
// component (no @vue/test-utils); events are captured through handler props.
//
// Icon identity cannot be asserted by class (the glyphs are <component :is>
// svgs with no stable DOM hook), so "mood/rating affects the icon" is proven
// by comparing the rendered slot svg between two scores; the component
// identity mapping itself is pinned in useDiaryCardModel.test.ts.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import DiaryThreadCard from '@/components/shared/DiaryThreadCard.vue'
import type { DiaryFeedItem } from '@/api/types'

function feedItem(
  kind: string,
  snapshot: Record<string, unknown> = {},
  overrides: Partial<DiaryFeedItem> = {},
): DiaryFeedItem {
  return {
    id: 'e1',
    kind,
    occurred_at: '2026-07-16T10:30:00Z',
    source_type: 'diary_entry',
    source_id: 'src_1',
    snapshot,
    created_at: '2026-07-16T10:30:00Z',
    ...overrides,
  }
}

let app: App | null = null
let host: HTMLElement | null = null
let taps: { item: DiaryFeedItem; editable: boolean }[] = []

function mountCard(item: DiaryFeedItem, timezone = 'UTC'): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  taps = []
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(DiaryThreadCard, {
          item,
          timezone,
          onTap: (p: { item: DiaryFeedItem; editable: boolean }) => taps.push(p),
        })
    },
  })
  app = createApp(Wrapper)
  app.mount(host)
  return host
}

function q<E extends HTMLElement = HTMLElement>(selector: string): E | null {
  return host?.querySelector<E>(selector) ?? null
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('DiaryThreadCard -- system banner', () => {
  it('booking_confirmed: «Вы записались на» + [practice с master] in brackets, teal tone', () => {
    mountCard(
      feedItem('booking_confirmed', {
        practice_title: 'Вечерняя медитация',
        master_name: 'Анна Соколова',
      }),
    )

    expect(q('.tcard--banner-teal')).not.toBeNull()
    expect(q('.tcard__banner-title')?.textContent?.trim()).toBe('Вы записались на')
    // Square brackets preserved; the master joins with «с» only when present.
    expect(q('.tcard__banner-subtitle')?.textContent?.trim()).toBe(
      '[Вечерняя медитация с Анна Соколова]',
    )
  })

  it('booking_confirmed without a master name omits «с» cleanly, brackets stay', () => {
    mountCard(feedItem('booking_confirmed', { practice_title: 'Вечерняя медитация' }))

    expect(q('.tcard__banner-subtitle')?.textContent?.trim()).toBe('[Вечерняя медитация]')
  })

  it('the other banner kinds keep the neutral tone and their semantic copy', () => {
    mountCard(feedItem('booking_cancelled_by_user', { practice_title: 'Йога' }))

    expect(q('.tcard--banner-neutral')).not.toBeNull()
    expect(q('.tcard__banner-title')?.textContent?.trim()).toBe('Вы отменили запись')
  })

  it('banners are inert status content -- not buttons', () => {
    mountCard(feedItem('booking_confirmed', { practice_title: 'Вечерняя медитация' }))

    expect(q('button')).toBeNull()
  })
})

describe('DiaryThreadCard -- check-in bubble', () => {
  const CHECKIN = feedItem('checkin', { mood: 9, comment_preview: 'Спокойно, как всегда' })

  it('left-lobed bubble: base title Check-in, the comment preview as line 2', () => {
    mountCard(CHECKIN)

    const btn = q<HTMLButtonElement>('.tcard--checkin')
    expect(btn).not.toBeNull()
    expect(btn?.getAttribute('aria-label')).toContain('Check-in')
    expect(q('.tcard__bubble-title')?.textContent?.trim()).toBe('Check-in')
    expect(q('.tcard__bubble-preview')?.textContent?.trim()).toBe('Спокойно, как всегда')
    // No mood suffix in the heading -- mood picks the icon, never the title.
    expect(q('.tcard__bubble-title')?.textContent).not.toContain('Хорошо')
  })

  it('renders the exact Figma silhouette at its native 267x47, unmirrored', () => {
    mountCard(CHECKIN)

    const svg = q('svg.bubble')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('width')).toBe('267')
    expect(svg?.getAttribute('height')).toBe('47')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 267 47')
    expect(svg?.classList.contains('bubble--mirrored')).toBe(false)
  })

  it('mood changes the glyph, never the heading', () => {
    mountCard(feedItem('checkin', { mood: 2 }))
    const lowSvg = q('.tcard__slot svg')?.outerHTML
    const lowTitle = q('.tcard__bubble-title')?.textContent?.trim()

    mountCard(feedItem('checkin', { mood: 9 }))
    expect(q('.tcard__bubble-title')?.textContent?.trim()).toBe(lowTitle)
    expect(q('.tcard__slot svg')?.outerHTML).not.toBe(lowSvg)
  })

  it('no comment -> the mood label becomes line 2 (still not a title suffix)', () => {
    mountCard(feedItem('checkin', { mood: 9 }))

    expect(q('.tcard__bubble-title')?.textContent?.trim()).toBe('Check-in')
    expect(q('.tcard__bubble-preview')?.textContent?.trim()).toBe('Хорошо')
  })
})

describe('DiaryThreadCard -- feedback bubble', () => {
  const FEEDBACK = feedItem('feedback', { rating: 9, comment_preview: 'Было мощно' })

  it('mirrored bubble: base title Feedback + the comment preview as line 2', () => {
    mountCard(FEEDBACK)

    expect(q<HTMLButtonElement>('.tcard--feedback')).not.toBeNull()
    expect(q('.tcard__bubble-title')?.textContent?.trim()).toBe('Feedback')
    expect(q('.tcard__bubble-preview')?.textContent?.trim()).toBe('Было мощно')
    // The same exact silhouette, mirrored for this side.
    expect(q('svg.bubble--mirrored')).not.toBeNull()
  })

  it('no synthetic scale dots and no rating text tag anywhere on the card', () => {
    mountCard(FEEDBACK)

    expect(q('.tcard__scale')).toBeNull()
    expect(q('.tcard__dot')).toBeNull()
    expect(q('.tcard__tag')).toBeNull()
    // The rating label must not leak into the card text (old tag behaviour).
    expect(host?.textContent).not.toContain('Огонь!')
  })

  it('rating changes the glyph, never the heading', () => {
    mountCard(feedItem('feedback', { rating: 2 }))
    const confusedSvg = q('.tcard__slot svg')?.outerHTML

    mountCard(feedItem('feedback', { rating: 9 }))
    expect(q('.tcard__bubble-title')?.textContent?.trim()).toBe('Feedback')
    expect(q('.tcard__slot svg')?.outerHTML).not.toBe(confusedSvg)
  })

  it('no comment -> the rating label becomes line 2', () => {
    mountCard(feedItem('feedback', { rating: 9 }))

    expect(q('.tcard__bubble-preview')?.textContent?.trim()).toBe('Огонь!')
  })
})

describe('DiaryThreadCard -- practice outcome', () => {
  const PRACTICE_SNAPSHOT = {
    practice_title: 'Утренняя йога',
    direction: 'yoga',
    master_name: 'Мария Петрова',
    master_verified: true,
    scheduled_at: '2026-07-16T08:00:00Z',
    duration_minutes: 60,
    outcome_status: 'attended',
  }

  it('attended: full metadata card with BOTH the check and Done', () => {
    mountCard(feedItem('practice_outcome', PRACTICE_SNAPSHOT))

    expect(q('.tcard__prac-title')?.textContent?.trim()).toBe('Утренняя йога')
    expect(host?.textContent).toContain('Мария Петрова')
    // 08:00Z rendered in UTC; formatDuration(60) -> «1 час».
    expect(q('.tcard__prac-meta')?.textContent).toContain('08:00')
    expect(q('.tcard__prac-meta')?.textContent).toContain('1 час')
    const status = q('.tcard__prac-status--attended')
    expect(status).not.toBeNull()
    expect(status?.querySelector('svg')).not.toBeNull() // the check half of «✓ Done»
    expect(status?.textContent?.trim()).toBe('Done') // ...and the word half
  })

  it('no_show: «Вы не пришли», neutral status', () => {
    mountCard(feedItem('practice_outcome', { ...PRACTICE_SNAPSHOT, outcome_status: 'no_show' }))

    expect(q('.tcard__prac-status--no_show')?.textContent?.trim()).toBe('Вы не пришли')
    expect(host?.textContent).not.toContain('Done')
  })

  it('is its own dedicated button -- not the feedback bubble', () => {
    mountCard(feedItem('practice_outcome', PRACTICE_SNAPSHOT))

    expect(q('.tcard--practice')?.tagName).toBe('BUTTON')
    expect(q('.tcard--feedback')).toBeNull()
  })
})

describe('DiaryThreadCard -- note / dream split entry', () => {
  it('note: «Дневник» + content_preview -- the time never substitutes for it', () => {
    mountCard(feedItem('note', { content_preview: 'Сегодня на работе было спокойно' }))

    expect(q('.tcard--entry')).not.toBeNull()
    expect(q('.tcard__entry-title')?.textContent?.trim()).toBe('Дневник')
    expect(q('.tcard__entry-preview')?.textContent?.trim()).toBe('Сегодня на работе было спокойно')
    // dateLine (the event time) must not appear anywhere on the card.
    expect(host?.textContent).not.toContain('10:30')
  })

  it('dream: «Сонник» and its own glyph, distinct from the note icon', () => {
    mountCard(feedItem('note', { content_preview: 'x' }))
    const noteSvg = q('.tcard__entry-icon svg')?.outerHTML

    mountCard(feedItem('dream', { content_preview: 'Летал во сне' }))
    expect(q('.tcard__entry-title')?.textContent?.trim()).toBe('Сонник')
    expect(q('.tcard__entry-preview')?.textContent?.trim()).toBe('Летал во сне')
    expect(q('.tcard__entry-icon svg')?.outerHTML).not.toBe(noteSvg)
  })
})

describe('DiaryThreadCard -- tap payloads', () => {
  it('every interactive card emits the unchanged { item, editable } payload', () => {
    const cases: [DiaryFeedItem, boolean][] = [
      [feedItem('checkin', { mood: 9 }, { id: 'c1' }), false],
      [feedItem('feedback', { rating: 9 }, { id: 'f1' }), false],
      [feedItem('practice_outcome', { outcome_status: 'attended' }, { id: 'p1' }), false],
      [feedItem('note', { content_preview: 'n' }, { id: 'n1' }), true],
      [feedItem('dream', { content_preview: 'd' }, { id: 'd1' }), true],
    ]

    for (const [item, editable] of cases) {
      mountCard(item)
      q<HTMLButtonElement>('button')?.click()
      expect(taps).toEqual([{ item, editable }])
    }
  })
})

describe('DiaryThreadCard -- unknown kinds', () => {
  it('an unrecognized kind falls to the explicit fallback, never a known form', () => {
    mountCard(feedItem('custom_offline_event', { title: 'Медитация' }))

    expect(q('.tcard--fallback')).not.toBeNull()
    for (const known of [
      '.tcard--feedback',
      '.tcard--practice',
      '.tcard--checkin',
      '.tcard--entry',
      '.tcard--banner',
    ]) {
      expect(q(known)).toBeNull()
    }
    expect(q('button')).toBeNull()
  })

  it('thread_started (backend-excluded from the feed) also renders the safe fallback', () => {
    mountCard(feedItem('thread_started', { master_name: 'Анна Соколова' }))

    expect(q('.tcard--fallback')).not.toBeNull()
    expect(host?.textContent).toContain('Вы начали диалог')
  })
})
