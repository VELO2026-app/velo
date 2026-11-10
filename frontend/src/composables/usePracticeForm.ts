// =============================================================================
// VELO Frontend -- usePracticeForm (FE-157 stage 4, track 4A)
// =============================================================================
//
// The ONE model of the practice form behind CreatePracticeView and
// EditPracticeView: the field shape, the validation both screens run, and the
// two request builders (POST body for create, changed-fields PATCH for edit).
// Before FE-157 each screen carried its own copy, and the copies drifted:
// Edit did not check the start time, the difficulty or the duration.
//
// Is a practice whose start has passed still editable? Measured on the
// backend, not assumed:
//   - update_practice refuses only a DELETED practice
//     (backend/app/modules/practices/service.py:2448-2449); a live practice,
//     or a scheduled one the lifecycle worker has not flipped yet, takes a
//     PATCH of any other field;
//   - UpdatePracticeRequest.scheduled_at_must_be_future
//     (backend/app/modules/practices/schemas.py:589-600) refuses a past
//     start, but only when scheduled_at is IN the request.
// So the future check runs on create always, and on edit only when the
// schedule itself changed -- exactly when the PATCH carries scheduled_at
// (`scheduleChanged` decides both). Completed / cancelled practices
// stay read-only on the edit screen by product rule (isTerminal there).
// =============================================================================

import { reactive, ref, watch, nextTick, onMounted, type Ref } from 'vue'
import { DateTime } from 'luxon'
import { t } from '@/locales'
import { ApiResponseError } from '@/api/client'
import { getGroups, type GroupListItem } from '@/api/groups'
import { errorMessage, extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { queryDocument } from '@/platform/dom'
import { centsToEurString, eurStringToCents } from '@/utils/currency'
import type {
  CreatePracticeRequest,
  PracticeAudienceKind,
  PracticeResponse,
  RecurrenceSpec,
  UpdatePracticeRequest,
} from '@/api/types'

/** Values of the practice form, as the controls hold them (strings for selects and inputs). */
export interface PracticeFormValues {
  title: string
  /** Empty until picked, so the field name shows as the in-field placeholder. */
  direction: string
  difficulty: string
  style: string
  /** Drives practice_type: series when on, live when off. */
  is_recurring: boolean
  recurrence: RecurrenceSpec['period']
  /** VDayPicker codes ('mon'..'sun'), mapped to ISO weekdays on submit. */
  recurrence_days: string[]
  recurrence_end: RecurrenceSpec['end']
  /** Empty until the master types a count (NP-11) -- no auto-filled default. */
  recurrence_count: number | null
  /** ISO 'YYYY-MM-DD' when recurrence_end is 'until_date'. */
  recurrence_end_date: string
  /** Wall-clock date and time in `PracticeFormValues.timezone`. */
  date: string
  time: string
  duration_minutes: string
  /** IANA zone the date and time are typed in (the master's profile zone). */
  timezone: string
  /** Raw input; empty means no seat limit. */
  max_participants_raw: string
  is_free: boolean
  /** Raw euro amount; neither screen offers a price field today (free only). */
  price_eur_raw: string
  audience_kind: PracticeAudienceKind
  audience_group_ids: string[]
  /** The one school the practice belongs to (BE-74); null for a practice of no school. */
  audience_school_id: string | null
  description: string
  what_to_prepare: string
  contraindications: string
}

/** Zone used when the master's profile carries none. */
export const FALLBACK_PRACTICE_TIMEZONE = 'Europe/Moscow'

/**
 * The audience pair a practice of a school may carry (BE-74
 * check_school_audience): the curator-on-behalf create offers it, and the
 * edit screen keeps a school practice within it.
 */
export const SCHOOL_AUDIENCE_KINDS: PracticeAudienceKind[] = ['public', 'schools']

/**
 * A blank form: nothing picked, a one-off free public practice.
 *
 * @param timezone - The master's profile zone; falls back to `FALLBACK_PRACTICE_TIMEZONE`.
 */
export function emptyPracticeForm(timezone?: string | null): PracticeFormValues {
  return {
    title: '',
    direction: '',
    difficulty: '',
    style: '',
    is_recurring: false,
    recurrence: 'weekly',
    recurrence_days: [],
    recurrence_end: 'never',
    recurrence_count: null,
    recurrence_end_date: '',
    date: '',
    time: '',
    duration_minutes: '',
    timezone: timezone || FALLBACK_PRACTICE_TIMEZONE,
    max_participants_raw: '',
    is_free: true,
    price_eur_raw: '',
    audience_kind: 'public',
    audience_group_ids: [],
    audience_school_id: null,
    description: '',
    what_to_prepare: '',
    contraindications: '',
  }
}

/**
 * The form values of a stored practice.
 *
 * @remarks The stored UTC instant is rendered as wall-clock date and time in
 * the practice's OWN zone, so the form shows what the master originally
 * typed, not the editor's browser zone. Missing taxonomy facets stay empty;
 * a caller that needs a default applies it. Audience group ids are left
 * empty: the response carries group NAMES only, the edit screen resolves them.
 */
export function practiceToForm(p: PracticeResponse): PracticeFormValues {
  const start = DateTime.fromISO(p.scheduled_at, { zone: 'utc' }).setZone(p.timezone)
  return {
    ...emptyPracticeForm(p.timezone),
    title: p.title,
    direction: p.direction ?? '',
    difficulty: p.difficulty ?? '',
    style: p.style ?? '',
    date: start.toFormat('yyyy-MM-dd'),
    time: start.toFormat('HH:mm'),
    duration_minutes: String(p.duration_minutes),
    max_participants_raw: p.max_participants != null ? String(p.max_participants) : '',
    is_free: p.is_free,
    // W-6: integer division + toFixed(2), no float multiplication.
    price_eur_raw: p.is_free ? '' : centsToEurString(p.price_cents),
    audience_kind: p.audience_kind ?? 'public',
    audience_school_id: p.school_id ?? null,
    description: p.description ?? '',
    what_to_prepare: p.what_to_prepare ?? '',
    contraindications: p.contraindications ?? '',
  }
}

/** A detached copy of the values (arrays copied), for diff bases and drafts. */
export function snapshotPracticeForm(v: PracticeFormValues): PracticeFormValues {
  return {
    ...v,
    recurrence_days: [...v.recurrence_days],
    audience_group_ids: [...v.audience_group_ids],
  }
}

// -- Value conversions shared by both request builders ------------------------

/** The typed wall-clock as an instant in the form's zone (luxon handles DST). */
function startInstant(v: PracticeFormValues): DateTime {
  return DateTime.fromISO(`${v.date}T${v.time}`, { zone: v.timezone })
}

/**
 * The UTC ISO instant of the typed date and time.
 *
 * @returns Null when the date or time is empty or does not form a valid instant.
 */
export function toScheduledAt(v: PracticeFormValues): string | null {
  if (!v.date || !v.time) return null
  const start = startInstant(v)
  return start.isValid ? start.toUTC().toISO() : null
}

const optionalText = (s: string): string | null => s.trim() || null

const maxParticipantsOf = (v: PracticeFormValues): number | null =>
  v.max_participants_raw ? parseInt(v.max_participants_raw, 10) : null

// W-6: eurStringToCents avoids the parseFloat(raw) * 100 precision trap.
const priceCentsOf = (v: PracticeFormValues): number =>
  v.is_free ? 0 : eurStringToCents(v.price_eur_raw)

// VDayPicker emits day codes ('mon'..'sun') in Mon->Sun order;
// RecurrenceSpec.days needs ISO weekday ints (1=Mon..7=Sun).
const WEEKDAY_ISO: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
}

/** The series spec of a recurring form (E3 series engine). */
function toRecurrenceSpec(v: PracticeFormValues): RecurrenceSpec {
  const spec: RecurrenceSpec = { period: v.recurrence, end: v.recurrence_end }
  // Daily ignores days; weekly/biweekly send the selected ISO weekdays.
  if (v.recurrence !== 'daily') {
    spec.days = v.recurrence_days.map((d) => WEEKDAY_ISO[d]).filter((n) => n != null)
  }
  if (v.recurrence_end === 'after_count') {
    if (v.recurrence_count != null) spec.count = v.recurrence_count
  } else if (v.recurrence_end === 'until_date') {
    spec.until_date = v.recurrence_end_date || null
  }
  return spec
}

// -- Validation ----------------------------------------------------------------

/** The form's error slots; an empty string is "no error". */
export const PRACTICE_FORM_ERROR_KEYS = [
  'title',
  'direction',
  'difficulty',
  'date',
  'time',
  'duration_minutes',
  'max_participants',
  'recurrence_days',
  'recurrence_end_date',
  'recurrence_count',
  'audience_group_ids',
] as const

/** One error message per slot of `PRACTICE_FORM_ERROR_KEYS`. */
export type PracticeFormErrors = Record<(typeof PRACTICE_FORM_ERROR_KEYS)[number], string>

/** Per-screen switches of `validatePracticeForm`. */
export interface PracticeFormRules {
  /** Require the start to lie in the future; see the module header for when edit sets it. */
  checkFuture: boolean
  /** Reference instant in epoch ms. @defaultValue Date.now() */
  now?: number
}

function noErrors(): PracticeFormErrors {
  return Object.fromEntries(PRACTICE_FORM_ERROR_KEYS.map((k) => [k, ''])) as PracticeFormErrors
}

/**
 * Validate the form values; the same rules on create and on edit.
 *
 * @remarks The schools audience reports into the audience_group_ids slot:
 * the audience picker renders one error line for both targeted kinds.
 * @returns The message per slot; every slot empty means the form may be sent.
 */
export function validatePracticeForm(
  v: PracticeFormValues,
  rules: PracticeFormRules,
): PracticeFormErrors {
  const e = noErrors()
  if (!v.title.trim()) e.title = t('masterScreens.createPractice.validation.enterTitle')
  if (!v.direction) e.direction = t('masterScreens.createPractice.validation.chooseDirection')
  if (!v.difficulty) e.difficulty = t('masterScreens.createPractice.validation.chooseDifficulty')
  if (!v.date) e.date = t('masterScreens.createPractice.validation.chooseDate')
  if (!v.time) e.time = t('masterScreens.createPractice.validation.chooseTime')
  // Interpreted in the form's zone, not the browser's: a master scheduling
  // for another zone is checked against the wall-clock they actually picked.
  if (rules.checkFuture && v.date && v.time) {
    const start = startInstant(v)
    if (!start.isValid || start.toMillis() <= (rules.now ?? Date.now())) {
      e.date = t('masterScreens.createPractice.validation.futureDate')
    }
  }
  if (!v.duration_minutes) {
    e.duration_minutes = t('masterScreens.createPractice.validation.chooseDuration')
  }
  if (v.max_participants_raw) {
    const n = parseInt(v.max_participants_raw, 10)
    if (isNaN(n) || n < 1) {
      e.max_participants = t('masterScreens.createPractice.validation.positiveNumber')
    }
  }
  // Weekly / biweekly series need at least one weekday; daily ignores days.
  if (v.is_recurring && v.recurrence !== 'daily' && v.recurrence_days.length === 0) {
    e.recurrence_days = t('masterScreens.createPractice.validation.chooseWeekday')
  }
  // Without these two the backend answers a 422 the master cannot read.
  if (v.is_recurring && v.recurrence_end === 'until_date' && !v.recurrence_end_date) {
    e.recurrence_end_date = t('masterScreens.createPractice.validation.chooseEndDate')
  }
  if (
    v.is_recurring &&
    v.recurrence_end === 'after_count' &&
    (!v.recurrence_count || v.recurrence_count < 1)
  ) {
    e.recurrence_count = t('masterScreens.createPractice.validation.repeatMin1')
  }
  // The backend's own checks: group_ids non-empty for 'groups', school_id
  // set for 'schools'.
  if (v.audience_kind === 'groups' && v.audience_group_ids.length === 0) {
    e.audience_group_ids = t('masterScreens.createPractice.validation.chooseGroup')
  }
  if (v.audience_kind === 'schools' && v.audience_school_id === null) {
    e.audience_group_ids = t('masterScreens.createPractice.validation.chooseSchool')
  }
  return e
}

/** The toast for a date and time that do not form an instant (should not pass validation). */
export function invalidScheduleText(): string {
  return t('masterScreens.createPractice.validation.invalidDateTime')
}

/**
 * Bring the first invalid field of the form into view.
 *
 * @remarks The first invalid field may sit far above the submit button on a
 * long form; without this a failed submit reads as a dead click.
 */
export async function revealFirstFieldError(): Promise<void> {
  await nextTick()
  queryDocument(
    '.v-input--error, .v-select--error, .practice-schedule-picker__trigger--error, .v-field-error--open',
  )?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/**
 * The reactive practice form with its error slots and validation.
 *
 * @remarks Owner TZ 2026-11-01 §6: after the FIRST failed validation, a field
 * the person fixed loses its own error immediately, and editing never ADDS an
 * error before the next submit. One watcher over the whole validation result
 * does this for every slot (it replaced nine per-field watchers).
 * @param initial - Starting values; the returned `form` is a reactive copy.
 * @param rules - Read on every validation; receives the current values.
 */
export function usePracticeForm(
  initial: PracticeFormValues,
  rules: (v: PracticeFormValues) => PracticeFormRules,
): {
  form: PracticeFormValues
  errors: PracticeFormErrors
  validate: () => boolean
} {
  const form = reactive(initial)
  const errors = reactive(noErrors())
  const attempted = ref(false)

  function validate(): boolean {
    const next = validatePracticeForm(form, rules(form))
    Object.assign(errors, next)
    const ok = PRACTICE_FORM_ERROR_KEYS.every((k) => !next[k])
    if (!ok) attempted.value = true
    return ok
  }

  watch(
    () => validatePracticeForm(form, rules(form)),
    (fresh) => {
      if (!attempted.value) return
      for (const k of PRACTICE_FORM_ERROR_KEYS) if (errors[k] && !fresh[k]) errors[k] = ''
    },
  )

  return { form, errors, validate }
}

// -- Request builders ----------------------------------------------------------

/**
 * The POST /practices body of a validated form.
 *
 * @remarks practice_type follows the recurrence toggle (series / live);
 * group_ids ships empty and school_id null for any kind that does not read
 * them. Delegation fields (master_id, a curator's school) are the caller's.
 * @returns Null when the date and time do not form an instant.
 */
export function toCreatePayload(v: PracticeFormValues): CreatePracticeRequest | null {
  const scheduledAt = toScheduledAt(v)
  if (!scheduledAt) return null
  return {
    practice_type: v.is_recurring ? 'series' : 'live',
    direction: v.direction,
    difficulty: v.difficulty,
    style: optionalText(v.style),
    title: v.title.trim(),
    description: optionalText(v.description),
    what_to_prepare: optionalText(v.what_to_prepare),
    contraindications: optionalText(v.contraindications),
    scheduled_at: scheduledAt,
    duration_minutes: parseInt(v.duration_minutes, 10),
    timezone: v.timezone,
    max_participants: maxParticipantsOf(v),
    is_free: v.is_free,
    price_cents: priceCentsOf(v),
    currency: 'eur',
    recurrence: v.is_recurring ? toRecurrenceSpec(v) : null,
    audience_kind: v.audience_kind,
    group_ids: v.audience_kind === 'groups' ? [...v.audience_group_ids] : [],
    school_id: v.audience_kind === 'schools' ? v.audience_school_id : null,
  }
}

/** True when the date, time or zone differ from the base -- the PATCH then carries scheduled_at. */
export function scheduleChanged(v: PracticeFormValues, base: PracticeFormValues | null): boolean {
  return !base || v.date !== base.date || v.time !== base.time || v.timezone !== base.timezone
}

const PATCH_TEXT_FIELDS = ['description', 'what_to_prepare', 'contraindications'] as const

/**
 * The PATCH /practices/:id body: only what changed since `base`.
 *
 * @remarks Unchanged fields are omitted (the backend applies exclude_unset),
 * so a stale form cannot overwrite a concurrent edit of a field it never
 * touched. Two people editing the SAME field still race (last write wins):
 * the backend has no version check yet -- see BE-204. Coupled fields travel
 * together: date/time/timezone, is_free/price, and the audience pair (the
 * backend checks each pair as a whole). The school is never sent: it is
 * fixed at creation (BE-74).
 * @param audienceChanged - Whether the audience differs from the SAVED one;
 *   the edit screen decides it against the practice record.
 * @returns The partial body, null when nothing changed, or undefined when
 *   the date and time cannot be turned into an instant.
 */
export function toPracticePatch(
  v: PracticeFormValues,
  base: PracticeFormValues,
  audienceChanged: boolean,
): UpdatePracticeRequest | null | undefined {
  const body: UpdatePracticeRequest = {}
  if (v.title !== base.title) body.title = v.title.trim()
  if (v.direction !== base.direction) body.direction = v.direction
  if (v.difficulty !== base.difficulty) body.difficulty = v.difficulty
  if (v.style !== base.style) body.style = optionalText(v.style)
  for (const key of PATCH_TEXT_FIELDS) if (v[key] !== base[key]) body[key] = optionalText(v[key])

  if (scheduleChanged(v, base)) {
    // Omitted when a field is empty: never send a bad instant.
    if (v.date && v.time) {
      const scheduledAt = toScheduledAt(v)
      if (!scheduledAt) return undefined
      body.scheduled_at = scheduledAt
    }
    if (v.timezone !== base.timezone) body.timezone = v.timezone
  }
  if (v.duration_minutes !== base.duration_minutes) {
    body.duration_minutes = parseInt(v.duration_minutes, 10)
  }
  if (v.max_participants_raw !== base.max_participants_raw) {
    body.max_participants = maxParticipantsOf(v)
  }
  if (v.is_free !== base.is_free || v.price_eur_raw !== base.price_eur_raw) {
    body.is_free = v.is_free
    body.price_cents = priceCentsOf(v)
  }
  // P5 port (PROMPT №606): group_ids only means something for kind 'groups'.
  if (audienceChanged) {
    body.audience_kind = v.audience_kind
    body.group_ids = v.audience_kind === 'groups' ? [...v.audience_group_ids] : []
  }
  return Object.keys(body).length > 0 ? body : null
}

/**
 * The toast text for a failed create or save.
 *
 * @remarks The taxonomy refusals (_assert_master_confirmed_taxonomy) carry a
 * raw English detail that must never reach a person: they are switched on the
 * machine code (PROMPT №556, B8 PROMPT №746). Anything else goes through
 * extractApiError with the screen's own fallback.
 */
export function practiceSaveErrorText(e: unknown, fallback: string): string {
  if (
    e instanceof ApiResponseError &&
    (e.code === 'direction_not_confirmed' || e.code === 'style_not_confirmed')
  ) {
    return errorMessage(e.code)
  }
  return extractApiError(e, fallback)
}

/**
 * Whether a stored create draft is worth offering back.
 *
 * @remarks Only when the master actually started composing (some field
 * beyond the empty defaults) -- a bare open must not nag on the next visit.
 */
export function isMeaningfulPracticeDraft(d: Record<string, unknown>): boolean {
  const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  return Boolean(
    s(d.title) ||
    d.direction ||
    d.difficulty ||
    d.style ||
    d.date ||
    d.time ||
    d.duration_minutes ||
    s(d.max_participants_raw) ||
    s(d.description) ||
    s(d.what_to_prepare) ||
    s(d.contraindications) ||
    d.is_recurring,
  )
}

/**
 * The master's own custom groups for the specific-groups audience
 * (i18n:practice.audience.groups), loaded on mount.
 *
 * @remarks The deleted bucket is a system slug and the default students
 * group cannot be targeted either; getGroups() returns both next to the
 * custom ones, so they are filtered here. A failure toasts instead of an
 * empty list that would read as "no groups yet".
 * @param onLoaded - Runs after the list landed (the edit screen re-resolves
 *   its saved group names to ids).
 */
export function usePracticeCustomGroups(onLoaded?: () => void): Ref<GroupListItem[]> {
  const groups = ref<GroupListItem[]>([])
  const toast = useToast()
  onMounted(() => {
    void getGroups()
      .then((res) => {
        groups.value = res.items.filter((g) => g.kind === 'custom')
        onLoaded?.()
      })
      .catch(() => {
        toast.error(t('masterScreens.createPractice.error.loadGroups'))
      })
  })
  return groups
}
