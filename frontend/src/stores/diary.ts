// =============================================================================
// VELO Frontend -- Diary Store (Diary redesign: unified feed)
// =============================================================================
//
// The diary's client state and its mutations. The server data -- the feed,
// the search jump window, one entry, a practice's insights -- lives in Pinia
// Colada (composables/queries/diary.ts, FE-182); every mutation here that
// moves the timeline calls diaryFeedChanged() on success.
//
//   submit (CheckinView / FeedbackView / ReflectionView / outside activity):
//     submitCheckin() / submitFeedback() / submitReflection() /
//     submitExternalActivity()
//
//   feed (DiaryFeedView): the filters it is read under, the saved scroll
//     offset, the open search jump -- setFeedFilters() / clearFeedFilters() /
//     runFeedSearch() / jumpToEntry() / exitJump()
//
//   diary entry CRUD: sendEntry() / retryEntry() (the composer's optimistic
//     send queue), updateEntry() / deleteEntry() / restoreEntry()
// =============================================================================

import { defineStore } from 'pinia'
import { useQueryCache } from '@pinia/colada'
import { invalidateAfter } from '@/composables/queries/invalidation'
import { diaryFeedChanged, type DiaryJumpTarget } from '@/composables/queries/diary'
import { keys } from '@/composables/queries/keys'
import { ref, reactive } from 'vue'
import { newIdempotencyKey } from '@/api/chats'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import i18n from '@/locales'

const { t } = i18n.global
import {
  upsertCheckin,
  upsertFeedback,
  createReflection,
  createDiaryEntry,
  updateDiaryEntry,
  deleteDiaryEntry,
  restoreDiaryEntry,
  createExternalActivity,
} from '@/api/diary'
import type {
  CheckinRequest,
  FeedbackRequest,
  ReflectionRequest,
  CreateDiaryEntryRequest,
  CreateExternalActivityRequest,
  UpdateDiaryEntryRequest,
  DiaryEntryResponse,
  DiaryFeedItem,
  DiaryFeedFilters,
} from '@/api/types'

/** Result of a diary submit: ok/error plus the backend error code when one reached the store. */
export interface SubmitResult {
  ok: boolean
  error: string
  /** P5 (PROMPT №594): ApiResponseError.code when the failure is one, so a
   *  caller (CheckinView.vue) can switch on it for a specific message
   *  instead of the generic `error` string. Undefined on success or a
   *  non-ApiResponseError failure. */
  code?: string
}

/** The request fields POST /diary/external-activities can attach a 422 to. */
const EXTERNAL_ACTIVITY_FIELDS = [
  'occurred_at',
  'activity_type',
  'custom_activity_name',
  'mood',
  'thoughts',
] as const

/** Field-attributed 422 errors: the backend's `loc` (minus the "body" prefix)
 *  `->` that entry's msg. FE-70: the endpoint deliberately answers with SEVERAL
 *  field errors at once, so the form must be able to highlight two controls
 *  simultaneously instead of walking them one at a time. */
export type ExternalActivityFieldErrors = Partial<
  Record<(typeof EXTERNAL_ACTIVITY_FIELDS)[number], string>
>

/** An entry the composer handed over that the feed does not carry yet. */
export interface PendingDiaryEntry {
  /** Idempotency key -- also the row key, before and after delivery. */
  key: string
  body: CreateDiaryEntryRequest
  status: 'sending' | 'failed' | 'sent'
  /** The stand-in feed row (id `pending:<key>`). */
  item: DiaryFeedItem
}

/** Diary client state: submits, the feed's filters and jump, the optimistic send queue, entry CRUD. */
export const useDiaryStore = defineStore('diary', () => {
  // Colada entries of the booking data go stale with each mutation below
  // (composables/queries/invalidation.ts holds the map); the diary's own
  // entries are refreshed through diaryFeedChanged().
  const queryCache = useQueryCache()
  // Bumped by $reset (the account boundary): an answer that lands after it
  // belongs to the previous account -- it writes nothing and refreshes
  // nothing. On a 401 the reset runs before the failing request's own catch.
  let generation = 0

  // ===========================================================================
  // Check-in submit (CheckinView)
  // ===========================================================================

  const checkinSubmitting = ref(false)

  /**
   * Submit a check-in for a practice.
   *
   * @returns `{ ok, error }` so the view can show a toast on failure.
   */
  async function submitCheckin(practiceId: string, body: CheckinRequest): Promise<SubmitResult> {
    if (checkinSubmitting.value) return { ok: false, error: '' }
    checkinSubmitting.value = true
    const gen = generation
    try {
      await upsertCheckin(practiceId, body)
      if (gen === generation) void invalidateAfter(queryCache, 'submitCheckin')
      // The check-in is now a feed event and flips the booking's has_checkin
      // flag -- refresh both so the diary feed and dashboard banner update.
      // Not awaited: the check-in is saved, so the «done» screen shows now;
      // the timeline catches up in the background (it never fails the submit).
      if (gen === generation) void diaryFeedChanged(queryCache)
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.diary.sendCheckin'))
      const code = e instanceof ApiResponseError ? e.code : undefined
      return { ok: false, error: message, code }
    } finally {
      checkinSubmitting.value = false
    }
  }

  // ===========================================================================
  // Feedback submit (FeedbackView)
  // ===========================================================================

  const feedbackSubmitting = ref(false)

  /**
   * Submit a feedback for a practice.
   *
   * @returns `{ ok, error }` so the view can show a toast on failure.
   */
  async function submitFeedback(practiceId: string, body: FeedbackRequest): Promise<SubmitResult> {
    if (feedbackSubmitting.value) return { ok: false, error: '' }
    feedbackSubmitting.value = true
    const gen = generation
    try {
      await upsertFeedback(practiceId, body)
      if (gen === generation) void invalidateAfter(queryCache, 'submitFeedback')
      // The feedback is now a feed event and flips the booking's has_feedback
      // flag -- refresh both so the diary feed and dashboard banner update.
      // Not awaited -- see submitCheckin.
      if (gen === generation) void diaryFeedChanged(queryCache)
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.diary.sendFeedback'))
      return { ok: false, error: message }
    } finally {
      feedbackSubmitting.value = false
    }
  }

  // ===========================================================================
  // Reflection submit (ReflectionView, no-show, BE-108)
  // ===========================================================================

  const reflectionSubmitting = ref(false)

  /**
   * Submit a no-show reflection for a practice.
   *
   * @returns `{ ok, error }` so the view can show a toast on failure.
   *
   * The reflection projects nothing into the diary feed, so there is no feed
   * to refresh here. The booking's has_reflection flag comes back with the
   * booking keys, which the success makes stale (INVALIDATES.submitReflection).
   */
  async function submitReflection(
    practiceId: string,
    body: ReflectionRequest,
  ): Promise<SubmitResult> {
    if (reflectionSubmitting.value) return { ok: false, error: '' }
    reflectionSubmitting.value = true
    const gen = generation
    try {
      await createReflection(practiceId, body)
      if (gen === generation) void invalidateAfter(queryCache, 'submitReflection')
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.diary.send'))
      return { ok: false, error: message }
    } finally {
      reflectionSubmitting.value = false
    }
  }

  // ===========================================================================
  // External activity submit (ExternalActivityCreateView, FE-70 / BE-27)
  // ===========================================================================

  const externalActivitySubmitting = ref(false)

  /**
   * Record a hand-entered activity that happened outside velo, then refresh
   * the feed (the backend writes the activity AND its diary event in one
   * transaction, so the refresh already sees it -- nothing is inserted
   * optimistically).
   *
   * On a 422, `fieldErrors` carries the backend's per-loc messages so the form
   * can highlight several controls at once (see ExternalActivityFieldErrors).
   * The view owns URL/transport-free toasts and navigation.
   */
  async function submitExternalActivity(
    body: CreateExternalActivityRequest,
  ): Promise<SubmitResult & { fieldErrors?: ExternalActivityFieldErrors }> {
    if (externalActivitySubmitting.value) return { ok: false, error: '' }
    externalActivitySubmitting.value = true
    const gen = generation
    try {
      await createExternalActivity(body)
      if (gen === generation) await diaryFeedChanged(queryCache)
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.diary.saveEvent'))
      const code = e instanceof ApiResponseError ? e.code : undefined
      const fieldErrors: ExternalActivityFieldErrors = {}
      if (e instanceof ApiResponseError && e.validation) {
        for (const entry of e.validation) {
          // FastAPI locs arrive prefixed: ["body", "<field>"].
          const raw = entry.loc[entry.loc[0] === 'body' ? 1 : 0]
          if (
            typeof raw === 'string' &&
            (EXTERNAL_ACTIVITY_FIELDS as readonly string[]).includes(raw)
          ) {
            const field = raw as (typeof EXTERNAL_ACTIVITY_FIELDS)[number]
            if (!fieldErrors[field]) fieldErrors[field] = entry.msg
          }
        }
      }
      return {
        ok: false,
        error: message,
        code,
        fieldErrors: Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined,
      }
    } finally {
      externalActivitySubmitting.value = false
    }
  }

  // ===========================================================================
  // The feed's client state (DiaryFeedView): the filters it is read under, the
  // saved scroll offset, the open search jump. The feed itself is a Colada
  // query per filter set (composables/queries/diary.ts): changing a filter
  // switches the screen to that set's entry, from its first page.
  // ===========================================================================

  const feedFilters = reactive<DiaryFeedFilters>({
    categories: [],
    date_from: undefined,
    date_to: undefined,
    search: undefined,
  })

  // Saved feed scroll offset, so returning from an entry/detail restores the
  // user's place on the timeline instead of jumping back to "today" (bottom).
  const feedScrollTop = ref(0)

  /**
   * Apply new filters (merge): the feed reads from the first page under them.
   * Pass a fresh categories array / dates / search; omitted keys are kept.
   */
  function setFeedFilters(patch: Partial<DiaryFeedFilters>): void {
    exitJump()
    Object.assign(feedFilters, patch)
  }

  /**
   * Clear all filters (back to the all-categories chip, i18n:common.all, no
   * date range, no search).
   */
  function clearFeedFilters(): void {
    exitJump()
    feedFilters.categories = []
    feedFilters.date_from = undefined
    feedFilters.date_to = undefined
    feedFilters.search = undefined
  }

  /** Run a text search (an empty string clears it). */
  function runFeedSearch(query: string): void {
    // Typing again is a new search: any open jump window is left behind (the
    // view swaps back to the results list).
    exitJump()
    const trimmed = query.trim()
    feedFilters.search = trimmed.length > 0 ? trimmed : undefined
  }

  // -- Search jump (Telegram-style "scroll to the found entry") --------------
  //
  // The event whose window the thread shows instead of the results list
  // (composables/queries/diary.ts, diaryJumpQuery); null when none is open.

  const jumpTarget = ref<DiaryJumpTarget | null>(null)

  /** Open the jump window around one search result. */
  function jumpToEntry(item: DiaryJumpTarget): void {
    jumpTarget.value = { id: item.id, occurred_at: item.occurred_at }
  }

  /**
   * Leave the jump window. Called by every search/filter reset (the query
   * change owns it -- the view swaps back to whatever the new filter shows),
   * by a failed window load, and by $reset on logout.
   */
  function exitJump(): void {
    jumpTarget.value = null
  }

  // ===========================================================================
  // Optimistic entries (the composer's send, owner decision)
  //
  // The entry shows in the thread at once as a "sending" row; the server's
  // feed item later takes over the SAME row key (feedItemKey), so the card
  // stays one DOM node and only brightens -- no flicker, no reorder. A
  // failed one stays in place, marked, and retries under its own key.
  // ===========================================================================

  /** Row id prefix of an optimistic feed item. */
  const PENDING_ID_PREFIX = 'pending:'

  const pendingEntries = ref<PendingDiaryEntry[]>([])
  /** `Server entry id -> the client key its row was rendered under.` */
  const keyByEntryId = new Map<string, string>()

  /** The v-for key of a feed row: a delivered optimistic entry keeps the key
   * it was first rendered with. */
  function feedItemKey(item: DiaryFeedItem): string {
    if (item.source_type === 'diary_entry') {
      const key = keyByEntryId.get(item.source_id)
      if (key) return PENDING_ID_PREFIX + key
    }
    return item.id
  }

  function pendingFor(item: DiaryFeedItem): PendingDiaryEntry | undefined {
    if (!item.id.startsWith(PENDING_ID_PREFIX)) return undefined
    return pendingEntries.value.find((p) => p.item.id === item.id)
  }

  async function deliverEntry(p: PendingDiaryEntry): Promise<SubmitResult> {
    p.status = 'sending'
    const gen = generation
    try {
      const entry = await createDiaryEntry(p.body, p.key)
      // Saved, but for the previous account: its row is already gone.
      if (gen !== generation) return { ok: true, error: '' }
      keyByEntryId.set(entry.id, p.key)
      p.item = { ...p.item, source_id: entry.id }
      p.status = 'sent'
      await diaryFeedChanged(queryCache)
      // The feed now carries the entry under the same row key (or does not
      // show it at all under an active filter): the stand-in has done its job.
      pendingEntries.value = pendingEntries.value.filter((x) => x.key !== p.key)
      return { ok: true, error: '' }
    } catch (e) {
      p.status = 'failed'
      return { ok: false, error: extractApiError(e, t('storeErrors.diary.create')) }
    }
  }

  /**
   * Optimistic create: the entry is on screen before the request leaves.
   * Re-sending the text of a failed entry retries THAT entry (same key, same
   * place) instead of adding a second one.
   */
  function sendEntry(body: CreateDiaryEntryRequest): Promise<SubmitResult> {
    const failed = pendingEntries.value.find(
      (p) =>
        p.status === 'failed' &&
        p.body.content === body.content &&
        p.body.entry_type === body.entry_type,
    )
    if (failed) return deliverEntry(failed)
    const key = newIdempotencyKey()
    const now = new Date().toISOString()
    pendingEntries.value = [
      ...pendingEntries.value,
      {
        key,
        body,
        status: 'sending',
        item: {
          id: PENDING_ID_PREFIX + key,
          kind: body.entry_type ?? 'note',
          occurred_at: now,
          source_type: 'diary_entry',
          source_id: '',
          snapshot: { content_preview: body.content },
          created_at: now,
        },
      },
    ]
    const p = pendingEntries.value[pendingEntries.value.length - 1]
    return p ? deliverEntry(p) : Promise.resolve({ ok: false, error: '' })
  }

  /** The failed row's own retry. */
  function retryEntry(key: string): Promise<SubmitResult> {
    const p = pendingEntries.value.find((x) => x.key === key && x.status === 'failed')
    return p ? deliverEntry(p) : Promise.resolve({ ok: false, error: '' })
  }

  // ===========================================================================
  // Diary entry edit / delete / restore (EntryView, the feed's undo bar)
  //
  // An edited / deleted / restored note is a feed event, so each one reloads
  // the feed's first page (diaryFeedChanged) before it resolves.
  // ===========================================================================

  /**
   * Update an existing diary entry: its answer becomes the held entry
   * (composables/queries/diary.ts, diaryEntryQuery), then the feed reloads.
   */
  async function updateEntry(
    id: string,
    body: UpdateDiaryEntryRequest,
  ): Promise<SubmitResult & { entry: DiaryEntryResponse | null }> {
    const gen = generation
    try {
      const entry = await updateDiaryEntry(id, body)
      if (gen !== generation) return { ok: true, error: '', entry }
      queryCache.setQueryData(keys.diary.entry(id), entry)
      await diaryFeedChanged(queryCache)
      return { ok: true, error: '', entry }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.diary.update'))
      return { ok: false, error: message, entry: null }
    }
  }

  /** Soft-delete a diary entry, then reload the feed. */
  async function deleteEntry(id: string): Promise<SubmitResult> {
    const gen = generation
    try {
      await deleteDiaryEntry(id)
      if (gen === generation) await diaryFeedChanged(queryCache)
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.diary.delete'))
      return { ok: false, error: message }
    }
  }

  /**
   * Restore a soft-deleted diary entry (undo delete), then reload the feed so
   * the entry's event reappears in the timeline.
   */
  async function restoreEntry(id: string): Promise<SubmitResult> {
    const gen = generation
    try {
      await restoreDiaryEntry(id)
      if (gen === generation) await diaryFeedChanged(queryCache)
      return { ok: true, error: '' }
    } catch (e) {
      const message = extractApiError(e, t('storeErrors.diary.restore'))
      return { ok: false, error: message }
    }
  }

  // ===========================================================================
  // Reset (the account boundary: logout, a 401, any session end --
  // platform/session.ts calls it; the Colada caches have their own member,
  // queries/setup.ts)
  // ===========================================================================

  /** Back to the initial state; answers still in flight land nowhere. */
  function $reset(): void {
    generation += 1
    checkinSubmitting.value = false
    feedbackSubmitting.value = false
    reflectionSubmitting.value = false
    externalActivitySubmitting.value = false
    exitJump()
    feedFilters.categories = []
    feedFilters.date_from = undefined
    feedFilters.date_to = undefined
    feedFilters.search = undefined
    feedScrollTop.value = 0
    pendingEntries.value = []
    keyByEntryId.clear()
  }

  return {
    // Check-in / feedback submit
    checkinSubmitting,
    submitCheckin,
    feedbackSubmitting,
    submitFeedback,
    reflectionSubmitting,
    submitReflection,
    externalActivitySubmitting,
    submitExternalActivity,

    // The feed's client state
    feedFilters,
    feedScrollTop,
    setFeedFilters,
    clearFeedFilters,
    runFeedSearch,

    // Search jump
    jumpTarget,
    jumpToEntry,
    exitJump,

    // Entry CRUD
    pendingEntries,
    sendEntry,
    retryEntry,
    feedItemKey,
    pendingFor,
    updateEntry,
    deleteEntry,
    restoreEntry,

    // Reset
    $reset,
  }
})
