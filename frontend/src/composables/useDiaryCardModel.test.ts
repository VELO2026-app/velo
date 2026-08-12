// =============================================================================
// VELO Frontend -- useDiaryCardModel Unit Tests
// =============================================================================
//
// The kind -> form / title / preview / icon derivation shared by BOTH diary
// card renderers (DiaryFeedCard, DiaryThreadCard). Tested here rather than
// through a screen because the ICON is a component identity, not markup: the
// same assertion in the DOM would have to sniff an <svg viewBox>, which proves
// "some icon rendered" and not "the right one" (same reasoning as
// utils/ratingIcons.test.ts, which pins its maps by component identity too).
//
// The composable is plain `computed`s over two getters, so it needs no
// component instance, no Pinia and no DOM -- it is called directly.
//
// SCOPE: the `thread_started` kind added when the backend's tenth
// DiaryEventKind reached the feed (models.py DiaryEventKind.THREAD_STARTED).
// Before it existed frontend-side, FEED_KIND_TITLE[kind] was `undefined` ->
// empty title, the preview lookup read *_preview/comment fields the snapshot
// does not carry -> null, and standardIcon fell through to the default IconPen:
// a blank card with a pen and a date. The neighbouring kinds are asserted
// alongside it so a regression in the switch cannot hide behind the new case.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { useDiaryCardModel } from '@/composables/useDiaryCardModel'
import { IconMessages, IconPen, IconDiaryBook, IconDreamBook } from '@/components/icons'
import type { DiaryFeedItem } from '@/api/types'

function item(
  kind: string,
  snapshot: Record<string, unknown> = {},
  overrides: Partial<DiaryFeedItem> = {},
): DiaryFeedItem {
  return {
    id: 'e1',
    kind,
    occurred_at: '2026-07-16T10:30:00Z',
    source_type: 'thread',
    source_id: 'thread-7',
    snapshot,
    created_at: '2026-07-16T10:30:00Z',
    ...overrides,
  }
}

/** The backend snapshot for this kind, verbatim (diary/projections.py). */
function threadSnapshot(masterName: string | null = 'Анна Соколова') {
  return {
    thread_id: 'thread-7',
    master_id: 'master-3',
    master_name: masterName,
  }
}

function model(it: DiaryFeedItem, tz = 'UTC') {
  return useDiaryCardModel(
    () => it,
    () => tz,
  )
}

describe('useDiaryCardModel -- thread_started', () => {
  it('renders as a standard card, not a banner and not the practice form', () => {
    expect(model(item('thread_started', threadSnapshot())).form.value).toBe('standard')
  })

  it('has a real title -- the empty string was the blank-card bug', () => {
    const m = model(item('thread_started', threadSnapshot()))

    expect(m.baseTitle.value).toBe('Вы начали диалог')
    // No mood/rating suffix is appended for this kind -- title === baseTitle.
    expect(m.title.value).toBe('Вы начали диалог')
  })

  it("the preview line is the master's name -- the snapshot field nothing used to read", () => {
    expect(model(item('thread_started', threadSnapshot())).preview.value).toBe('Анна Соколова')
  })

  it('a null master_name degrades to no preview rather than rendering "null"', () => {
    // The backend types it `str | None` (projections.py), so this is reachable.
    expect(model(item('thread_started', threadSnapshot(null))).preview.value).toBeNull()
  })

  it('carries the messages glyph, not the fall-through pen', () => {
    const m = model(item('thread_started', threadSnapshot()))

    expect(m.standardIcon.value).toBe(IconMessages)
    expect(m.standardIcon.value).not.toBe(IconPen)
  })

  it('is not editable: it points at a conversation, not at a diary entry the user can rewrite', () => {
    expect(model(item('thread_started', threadSnapshot())).editable.value).toBe(false)
  })

  it('the date line is the event time in the viewer zone', () => {
    // occurred_at 10:30Z -- read in a +2 zone it must be 12:30, proving the
    // timezone getter is honoured and not silently dropped for this kind.
    expect(model(item('thread_started', threadSnapshot()), 'UTC').dateLine.value).toBe('10:30')
    expect(model(item('thread_started', threadSnapshot()), 'Europe/Berlin').dateLine.value).toBe(
      '12:30',
    )
  })
})

describe('useDiaryCardModel -- the neighbouring kinds still map as before', () => {
  it('note / dream keep their own titles, previews and glyphs', () => {
    const note = model(item('note', { content_preview: 'Спокойно' }))
    const dream = model(item('dream', { content_preview: 'Летал во сне' }))

    expect(note.baseTitle.value).toBe('Дневник')
    expect(note.preview.value).toBe('Спокойно')
    expect(note.standardIcon.value).toBe(IconDiaryBook)

    expect(dream.baseTitle.value).toBe('Сонник')
    expect(dream.preview.value).toBe('Летал во сне')
    expect(dream.standardIcon.value).toBe(IconDreamBook)
  })

  it('feedback still falls back through comment_preview -> comment, untouched by the thread_started branch', () => {
    expect(model(item('feedback', { comment_preview: 'Было мощно' })).preview.value).toBe(
      'Было мощно',
    )
    expect(model(item('feedback', { comment: 'Полный текст' })).preview.value).toBe('Полный текст')
  })

  it('a kind with no preview fields at all still yields null (the generic path is unchanged)', () => {
    expect(model(item('checkin', { mood: 9 })).preview.value).toBeNull()
  })
})
