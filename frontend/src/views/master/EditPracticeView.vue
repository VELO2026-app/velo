<!--
  VELO Frontend -- EditPracticeView (Phase F6.2 + F6.3, fixed W-2..W-9)

  Edit an existing practice and trigger state machine transitions.
  Protected by masterStatusGuard. Rendered inside MasterShell.

  Load order:
    1. Try masterStore.practices cache (instant if already loaded)
    2. Fallback: GET /api/v1/practices/:id

  Editable fields (draft / scheduled only -- completed/cancelled are readonly):
    title, description, what_to_prepare, contraindications,
    scheduled_at (date+time), duration_minutes,
    timezone, max_participants, is_free, price_cents, zoom_link

  State machine action buttons (below form):
    draft      -> "Опубликовать"  PATCH status=scheduled
                  "Удалить"       DELETE  (soft-delete, draft only)
    scheduled  -> "Отменить"      POST /cancel (+ confirm dialog)
    live       -> "Отменить"      POST /cancel   (+ confirm dialog)
                  (no manual scheduled->live nor live->finalize here: going live
                   and completion are auto-by-schedule/duration, pending backend.
                   The «Начать эфир» button was removed — operator 2026-06-24.)
    completed / cancelled / deleted -> readonly info banner

  After any successful mutation:
    - refreshMyPractices() to invalidate cache
    - navigate back to master-practices

  Fixes:
    W-2: DURATION_OPTIONS / TIMEZONE_OPTIONS imported from @/utils/practiceOptions
    W-3: anyLoading computed = saving || transitioning || cancelling || deleting.
         All action buttons and Save use :disabled="anyLoading" -- prevents
         concurrent save + publish / save + cancel / etc.
    W-5: confirm dialog overlay click blocked while confirmDialog.loading is true
    W-6: priceCents uses eurStringToCents() -- no float arithmetic.
         populateForm uses centsToEurString() -- no float precision issues.
    W-8: date input has :min="todayDate" to prevent setting past dates
    W-9: commission calc uses COMMISSION_RATE from @/utils/commission
    A4 V3 (ПРОМТ №571): Направление/Вид options filtered to the master's own
        CONFIRMED methods (mirrors CreatePracticeView), and the taxonomy
        rejection codes (direction_not_confirmed/style_not_confirmed) get the
        same Russian toast translation as CreatePracticeView's submit() catch.
-->

<template>
  <div class="edit-practice">
    <!-- Back returns to the practice screen; that screen decides where to go next
         (dashboard or practices, depending on origin) — operator 2026-06-17.
         Deep-link-safe: pop the existing detail entry (router.back) instead of
         PUSHing a new one — pushing grew history and ping-ponged edit<->detail
         (the back-loop, operator 2026-06-24). Mirror of CreatePracticeView.onBack. -->
    <VHeader title="Редактировать" show-back @back="onBack" />

    <!-- Loading -->
    <div v-if="loading" class="edit-practice__loader">
      <VLoader size="lg" />
    </div>

    <!-- Error / not found -->
    <div v-else-if="!practice" class="edit-practice__content">
      <VEmptyState icon="warning" title="Практика не найдена">
        <VButton size="sm" variant="outline" @click="router.push({ name: 'master-practices' })">
          Назад
        </VButton>
      </VEmptyState>
    </div>

    <template v-else>
      <!-- ================================================================
           READONLY BANNER for terminal statuses
           ================================================================ -->
      <div v-if="isTerminal" class="edit-practice__readonly-banner">
        <VBadge
          v-if="masterPracticeBadge(practice.status)"
          :variant="masterPracticeBadge(practice.status)!.variant"
        >
          {{ masterPracticeBadge(practice.status)!.label }}
        </VBadge>
        <span class="edit-practice__readonly-text">Редактирование недоступно</span>
      </div>

      <div class="edit-practice__content">
        <!-- ================================================================
             FORM (editable for draft / scheduled only)
             ================================================================ -->
        <fieldset :disabled="isTerminal || saving" class="edit-practice__fieldset">
          <!-- Реш. В (2026-06-12): поля по SVG Edit (label-above, белая плашка),
               БЕЗ секций-заголовков. Уровень/таймзона/цена по-прежнему опущены —
               они задаются на создании и блокируются после (хранятся в form,
               уходят на submit неизменными, данные не теряем). Направление/вид
               ДОБАВЛЕНЫ (operator, T2, 2026-07-15 — override навигатора: не
               отдельным батчем позже, а прямо в этом). Дата и Zoom возвращены
               по логике (см. комментарии ниже). -->
          <VInput v-model="form.title" label="Название" :error="errors.title" />

          <!-- Направление — options catalog-first (T2 stage 2), см. CreatePracticeView. -->
          <VSelect
            v-model="form.direction"
            label="Направление"
            :options="directionOptions"
            :error="errors.direction"
            @update:modelValue="onDirectionChange"
          />

          <!-- Вид практики — показываем только если у направления есть виды
               (Q4=А, mirrors CreatePracticeView: без явного «Без вида»). -->
          <div v-if="styleOptionsForForm.length > 0">
            <VSelect v-model="form.style" label="Вид практики" :options="styleOptionsForForm" />
          </div>

          <!-- Дата — DS-пикер (реш. В: возвращена по логике — перенос практики
               норм. операция; нативный type=date заменён на брендовый пикер). -->
          <div class="edit-practice__field">
            <label class="edit-practice__field-label">Дата</label>
            <button
              type="button"
              class="edit-practice__picker"
              :class="{ 'edit-practice__picker--empty': !form.date }"
              @click="showDate = true"
            >
              {{ form.date ? dateDisplay : 'Выберите дату' }}
            </button>
          </div>

          <!-- Время — DS-пикер (24ч, шаг 5 мин). -->
          <div class="edit-practice__field">
            <label class="edit-practice__field-label">Время</label>
            <button
              type="button"
              class="edit-practice__picker"
              :class="{ 'edit-practice__picker--empty': !form.time }"
              @click="showTime = true"
            >
              {{ form.time || 'Выберите время' }}
            </button>
          </div>

          <VSelect
            v-model="form.duration_minutes"
            label="Длительность"
            :options="DURATION_OPTIONS"
          />

          <VInput
            v-model="form.max_participants_raw"
            label="Максимум мест"
            type="number"
            :error="errors.max_participants"
          />

          <VTextarea v-model="form.description" label="Описание" :rows="4" autogrow />

          <VTextarea
            v-model="form.contraindications"
            label="Противопоказания"
            placeholder="Беременность, сердечно-сосудистые заболевания"
            :rows="2"
            autogrow
          />

          <VTextarea
            v-model="form.what_to_prepare"
            label="Что подготовить"
            placeholder="Коврик, плед, вода"
            :rows="3"
            autogrow
          />

          <!-- Zoom (T21-1, ПРОМТ №541, owner decision D1): the backend now
               ALWAYS creates a real Zoom meeting automatically on publish --
               this field is an EMERGENCY fallback only (Zoom's daily creation
               quota can fail it), kept so a master is never left with no way
               to run the session. Honest label states the cost of using it. -->
          <p class="edit-practice__hint">
            Ссылка создаётся автоматически. Указывайте свою только как запасной
            вариант — посещение по ней не засчитается автоматически.
          </p>
          <VInput
            v-model="form.zoom_link"
            label="Запасная Zoom ссылка"
            type="url"
            :error="errors.zoom_link"
          />

          <!-- W-3: :disabled="anyLoading" prevents Save while an action runs. -->
          <VButton
            v-if="!isTerminal"
            variant="primary"
            block
            :loading="saving"
            :disabled="anyLoading"
            @click="save"
          >
            Сохранить
          </VButton>
        </fieldset>

        <!-- ================================================================
             STATE MACHINE ACTIONS
             Q2=А (2026-06-12): лайфсайкл-переходы СОХРАНЕНЫ ВРЕМЕННО (в SVG Edit
             их нет) — пока хаб Practice-detail (WI-B) их не заберёт. Выкинуть
             сейчас = оставить мастера без публикации/завершения вовсе (в макете
             хаба их тоже нет). При сборке WI-B этот блок мигрирует туда.
             W-3: all buttons :disabled="anyLoading" -- prevents concurrent
             save + publish / save + cancel / save + delete etc.
             ================================================================ -->
        <div v-if="!isTerminal" class="edit-practice__actions">
          <!-- draft -> scheduled -->
          <VButton
            v-if="practice.status === 'draft'"
            variant="primary"
            block
            :loading="transitioning"
            :disabled="anyLoading"
            @click="publish"
          >
            Опубликовать практику
          </VButton>

          <!-- «Начать эфир» (scheduled->live) removed (operator 2026-06-24): it
               surfaced only because Create now auto-publishes to `scheduled`, and
               it must not live on the edit screen. Going live is auto-by-schedule
               (Zod) / lives on the practice hub, not here. -->

          <!-- «Завершить практику» + «Посещаемость» removed (operator 2026-06-17):
               finalize is non-obvious behind the edit form; a practice is meant to
               complete automatically by its duration (unless cancelled) once the
               backend implements it — see the Zod note. Attendance/check-ins stay
               reachable from the dashboard «Check-ins» and the practice screen. -->

          <!-- draft -> deleted -->
          <VButton
            v-if="practice.status === 'draft'"
            variant="danger"
            block
            :loading="deleting"
            :disabled="anyLoading"
            @click="confirmDelete"
          >
            Удалить черновик
          </VButton>

          <!-- scheduled / live -> cancelled -->
          <VButton
            v-if="practice.status === 'scheduled' || practice.status === 'live'"
            variant="danger"
            block
            :loading="cancelling"
            :disabled="anyLoading"
            @click="confirmCancel"
          >
            Отменить практику
          </VButton>
        </div>
      </div>

      <!-- W-5: cancel/overlay blocked while confirmDialog.loading is true (VConfirmDialog) -->
      <VConfirmDialog
        :open="confirmDialog.visible"
        :message="confirmDialog.message"
        :confirm-label="confirmDialog.confirmLabel"
        :danger="confirmDialog.danger"
        :loading="confirmDialog.loading"
        @confirm="confirmDialog.onConfirm"
        @cancel="confirmDialog.visible = false"
      />

      <!-- Branded cancel-practice modal (replaces the generic confirm for cancel;
           operator SVG «Abolish the practice»). cancelPractice = real refund;
           series-scope radio inside is captured-only (→ Zod). -->
      <CancelPracticeDialog
        :open="cancelModalOpen"
        :practice="practice"
        :loading="cancelling"
        @confirm="cancel"
        @cancel="cancelModalOpen = false"
      />

      <!-- Date/time picker sheets (teleport to body; open on field tap). -->
      <DatePickerSheet
        :open="showDate"
        :model-value="form.date"
        :min="todayDate"
        @update:model-value="form.date = $event"
        @close="showDate = false"
      />
      <TimePickerSheet
        :open="showTime"
        :model-value="form.time"
        @update:model-value="form.time = $event"
        @close="showTime = false"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { DateTime } from 'luxon'
import { useRoute, useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import {
  VButton,
  VInput,
  VTextarea,
  VSelect,
  VBadge,
  VLoader,
  VEmptyState,
  VConfirmDialog,
} from '@/components/ui'
import DatePickerSheet from '@/components/shared/DatePickerSheet.vue'
import TimePickerSheet from '@/components/shared/TimePickerSheet.vue'
import CancelPracticeDialog from '@/components/shared/CancelPracticeDialog.vue'
import { useToast } from '@/composables/useToast'
import { useMasterStore } from '@/stores/master'
import { getPractice, updatePractice, deletePractice, cancelPractice } from '@/api/practices'
import { formatShortDate, todayLocalISO } from '@/utils/format'
import { masterPracticeBadge } from '@/utils/practiceStatus'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import { DURATION_OPTIONS, catalogDirectionOptions, catalogStylesForDirection } from '@/utils/practiceOptions'
import { ensureTaxonomyCatalog, parseMethods } from '@/utils/methodTaxonomy'
import { eurStringToCents, centsToEurString } from '@/utils/currency'
import type { TaxonomyListResponse } from '@/api/taxonomy'
import type { PracticeResponse } from '@/api/types'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const masterStore = useMasterStore()

const practiceId = route.params.id as string

// Back to the practice screen. Deep-link-safe: if there's history, pop to the
// detail entry that pushed us here (avoids the edit<->detail back-loop); else
// (cold deep-link) push the detail route. Mirror of CreatePracticeView.onBack.
function onBack(): void {
  if (window.history.state?.back)
    router.back()
  else router.push({ name: 'master-practice-detail', params: { id: practiceId } })
}

// -- Practice data --
const practice = ref<PracticeResponse | null>(null)
const loading = ref(false)

// -- Action loading states --
const saving = ref(false)
const transitioning = ref(false)
const cancelling = ref(false)
const deleting = ref(false)

// Date/time picker sheets + branded cancel modal (Q1=В / Q3=А, 2026-06-12).
const showDate = ref(false)
const showTime = ref(false)
const cancelModalOpen = ref(false)

// T2 stage 2 (2026-07-15): taxonomy catalog, primed in parallel with the
// practice fetch below (mirrors CreatePracticeView). Rides the shared cache
// (ensureTaxonomyCatalog()) -- zero fetch if another screen already warmed it.
const catalog = ref<TaxonomyListResponse | null>(null)

// W-3: single guard covering all mutually exclusive actions.
// Every action button and the Save button use :disabled="anyLoading".
// Prevents concurrent save + publish, save + cancel, etc.
const anyLoading = computed(
  () => saving.value || transitioning.value || cancelling.value || deleting.value,
)

// -- Confirm dialog state --
const confirmDialog = reactive({
  visible: false,
  message: '',
  confirmLabel: 'Подтвердить',
  danger: false,
  loading: false,
  onConfirm: (): void => {
    /* filled per use */
  },
})

// W-8: computed so todayDate is never stale after midnight. Local-time date floor
// (not UTC) so it doesn't drift a day near midnight for east/west-of-UTC users.
const todayDate = computed(() => todayLocalISO())

// Friendly date for the picker trigger, e.g. "25 янв. 2026" (mirrors Create).
const dateDisplay = computed((): string =>
  form.date ? `${formatShortDate(`${form.date}T12:00:00`)} ${form.date.slice(0, 4)}` : '',
)

// -- Form state (populated from practice on load) --
const form = reactive({
  title: '',
  direction: 'meditation',
  difficulty: 'beginner',
  style: '',
  date: '',
  time: '',
  duration_minutes: '60',
  timezone: 'Europe/Moscow',
  max_participants_raw: '',
  is_free: false,
  price_eur_raw: '',
  description: '',
  what_to_prepare: '',
  contraindications: '',
  zoom_link: '',
})

const errors = reactive({
  title: '',
  direction: '',
  max_participants: '',
  zoom_link: '',
})

// -- Derived --
const isTerminal = computed(
  (): boolean =>
    practice.value?.status === 'completed' ||
    practice.value?.status === 'cancelled' ||
    practice.value?.status === 'deleted',
)

// W-6: use eurStringToCents() -- avoids parseFloat(raw) * 100 float precision trap.
const priceCents = computed((): number => eurStringToCents(form.price_eur_raw))

// A4 V3 (ПРОМТ №571): this master's OWN CONFIRMED methods, same resolver
// and same fail-CLOSED posture as CreatePracticeView (ПРОМТ №556/№546) --
// this screen shares masterStatusGuard with master-practice-new (router/
// index.ts), so masterStore.profileLoaded is already true on first render
// in the normal navigation case; the "not loaded yet" branch below is a
// defensive fallback, not the master line of defense. Deliberately reads
// masterStore.profile?.methods, never method_change_request.proposed_
// methods -- a pending, unapproved request must not unlock a direction
// early.
const confirmedMethods = computed(() => {
  const methods = masterStore.profile?.methods
  if (!methods) return null
  return parseMethods(methods)
})

// Direction/style options, catalog-first (T2 stage 2), filtered to the
// master's own confirmed methods -- mirrors CreatePracticeView's
// directionOptions/styleOptionsForForm exactly (ПРОМТ №556/№546). Before
// this, EditPracticeView offered the WHOLE active catalogue unfiltered,
// so a master could re-pick (or leave untouched, see populateForm) a
// direction/style their profile was never confirmed for and only find out
// from the backend's raw rejection on save -- see the catch block below.
const directionOptions = computed(() => {
  if (!masterStore.profileLoaded) return []
  const confirmed = confirmedMethods.value
  if (!confirmed) return []
  const all = catalogDirectionOptions(catalog.value)
  return all.filter((opt) => confirmed.directions.includes(opt.value))
})
const styleOptionsForForm = computed(() => {
  if (!masterStore.profileLoaded) return []
  const confirmed = confirmedMethods.value
  if (!confirmed) return []
  const all = catalogStylesForDirection(catalog.value, form.direction)
  const confirmedStyleValues = confirmed.styles[form.direction as string] ?? []
  return all.filter((opt) => confirmedStyleValues.includes(opt.value))
})

/** Reset style when direction changes — the previous value is likely
 *  invalid for the new direction (mirrors CreatePracticeView). */
function onDirectionChange(): void {
  form.style = ''
}

// -- Populate form from practice --
function populateForm(p: PracticeResponse): void {
  form.title = p.title
  // Taxonomy (data.taxonomy on the backend). Older practices created before
  // the Calendar iteration may have null facets -> fall back to defaults so
  // the selects always show a valid option.
  form.direction = p.direction ?? 'meditation'
  form.difficulty = p.difficulty ?? 'beginner'
  form.style = p.style ?? ''
  // Render the stored UTC instant as wall-clock date + time in the practice's
  // OWN timezone (the one the master created it in), so the form shows the
  // same values the master originally entered -- not the editor's browser tz.
  const scheduledDt = DateTime.fromISO(p.scheduled_at, { zone: 'utc' }).setZone(p.timezone)
  form.date = scheduledDt.toFormat('yyyy-MM-dd')
  form.time = scheduledDt.toFormat('HH:mm')
  form.duration_minutes = String(p.duration_minutes)
  form.timezone = p.timezone
  form.max_participants_raw = p.max_participants != null ? String(p.max_participants) : ''
  form.is_free = p.is_free
  // W-6: centsToEurString uses integer division + toFixed(2), no float multiplication.
  form.price_eur_raw = p.is_free ? '' : centsToEurString(p.price_cents)
  form.description = p.description ?? ''
  form.what_to_prepare = p.what_to_prepare ?? ''
  form.contraindications = p.contraindications ?? ''
  form.zoom_link = p.zoom_link ?? ''
}

// -- Load practice --
onMounted(async () => {
  // T2 stage 2: prime the taxonomy catalog IN PARALLEL with the practice
  // fetch below, not sequenced after it -- fire-and-forget so it runs
  // regardless of which branch (cached vs network) the practice load takes.
  void ensureTaxonomyCatalog().then((c) => {
    catalog.value = c
  })

  const cached = masterStore.practices.find((p) => p.id === practiceId)
  if (cached) {
    practice.value = cached
    populateForm(cached)
    return
  }
  loading.value = true
  try {
    const p = await getPractice(practiceId)
    practice.value = p
    populateForm(p)
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось загрузить практику'))
  } finally {
    loading.value = false
  }
})

// -- Validate --
function validate(): boolean {
  let ok = true
  errors.title = ''
  errors.direction = ''
  errors.max_participants = ''
  errors.zoom_link = ''

  if (!form.title.trim()) {
    errors.title = 'Введите название'
    ok = false
  }
  if (!form.direction) {
    errors.direction = 'Выберите направление'
    ok = false
  }
  if (form.max_participants_raw) {
    const n = parseInt(form.max_participants_raw, 10)
    if (isNaN(n) || n < 1) {
      errors.max_participants = 'Введите положительное число или оставьте пустым'
      ok = false
    }
  }
  if (form.zoom_link && !form.zoom_link.startsWith('https://')) {
    errors.zoom_link = 'Ссылка должна начинаться с https://'
    ok = false
  }
  return ok
}

// -- Save --
async function save(): Promise<void> {
  if (!validate() || saving.value) return
  saving.value = true
  try {
    // Convert the wall-clock date + time back to a UTC instant in the
    // selected timezone (mirrors CreatePracticeView). undefined when either
    // field is empty so we don't send a bad scheduled_at.
    let scheduledAt: string | undefined
    if (form.date && form.time) {
      const dt = DateTime.fromISO(`${form.date}T${form.time}`, {
        zone: form.timezone,
      })
      if (!dt.isValid) {
        toast.error('Некорректные дата или время')
        saving.value = false
        return
      }
      scheduledAt = dt.toUTC().toISO() ?? undefined
    }

    const updated = await updatePractice(practiceId, {
      title: form.title.trim(),
      direction: form.direction,
      difficulty: form.difficulty,
      style: form.style.trim() || null,
      description: form.description.trim() || null,
      what_to_prepare: form.what_to_prepare.trim() || null,
      contraindications: form.contraindications.trim() || null,
      scheduled_at: scheduledAt ?? null,
      duration_minutes: parseInt(form.duration_minutes, 10),
      timezone: form.timezone,
      max_participants: form.max_participants_raw ? parseInt(form.max_participants_raw, 10) : null,
      zoom_link: form.zoom_link.trim() || null,
      is_free: form.is_free,
      price_cents: form.is_free ? 0 : priceCents.value,
    })
    practice.value = updated
    toast.success('Сохранено')
    await masterStore.refreshMyPractices()
  } catch (e) {
    // A4 V3 (ПРОМТ №571): _assert_master_confirmed_taxonomy's rejection is a
    // raw, English, API-shaped message (e.detail) -- must never reach a human
    // directly. Same codes, same translation, same pattern as
    // CreatePracticeView's submit() catch (ПРОМТ №556, OWNER-2).
    if (e instanceof ApiResponseError && e.code === 'direction_not_confirmed') {
      toast.error('Это направление ещё не подтверждено в вашем профиле')
    } else if (e instanceof ApiResponseError && e.code === 'style_not_confirmed') {
      toast.error('Этот вид практики ещё не подтверждён в вашем профиле')
    } else {
      toast.error(extractApiError(e, 'Ошибка сохранения'))
    }
  } finally {
    saving.value = false
  }
}

// -- Publish: draft -> scheduled --
async function publish(): Promise<void> {
  if (anyLoading.value) return
  transitioning.value = true
  try {
    const updated = await updatePractice(practiceId, { status: 'scheduled' })
    practice.value = updated
    toast.success('Практика опубликована!')
    await masterStore.refreshMyPractices()
    router.push({ name: 'master-practices' })
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось опубликовать'))
  } finally {
    transitioning.value = false
  }
}

// -- Confirm cancel: open the branded modal (CancelPracticeDialog). --
function confirmCancel(): void {
  cancelModalOpen.value = true
}

// -- Cancel: scheduled/live -> cancelled (full refund). Driven by the branded
//    modal; uses the `cancelling` flag (modal :loading). --
async function cancel(scope: 'this' | 'this_and_future'): Promise<void> {
  if (cancelling.value) return
  cancelling.value = true
  try {
    const updated = await cancelPractice(practiceId, scope)
    practice.value = updated
    cancelModalOpen.value = false
    toast.success('Практика отменена, возвраты выполнены')
    await masterStore.refreshMyPractices()
    router.push({ name: 'master-practices' })
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отменить'))
  } finally {
    cancelling.value = false
  }
}

// -- Confirm delete --
function confirmDelete(): void {
  confirmDialog.message = 'Удалить черновик? Это действие нельзя отменить.'
  confirmDialog.confirmLabel = 'Удалить'
  confirmDialog.danger = true
  confirmDialog.visible = true
  confirmDialog.onConfirm = remove
}

// -- Delete: draft -> deleted (soft) --
async function remove(): Promise<void> {
  if (confirmDialog.loading) return
  confirmDialog.loading = true
  try {
    await deletePractice(practiceId)
    confirmDialog.visible = false
    toast.success('Черновик удалён')
    await masterStore.refreshMyPractices()
    router.push({ name: 'master-practices' })
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось удалить'))
  } finally {
    confirmDialog.loading = false
  }
}
</script>

<style scoped>
.edit-practice {
  min-height: 100%;
  background: transparent;
  display: flex;
  flex-direction: column;
}

.edit-practice__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-12) 0;
}

/* -- Readonly banner -- */
.edit-practice__readonly-banner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--velo-glass-blue-15);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.edit-practice__readonly-text {
  font-family: var(--font-body);
  font-size: var(--text-sm);  color: var(--velo-text-muted);
}

/* -- Content -- */
.edit-practice__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding).
     Top trimmed to sit closer to the header (operator 2026-06-17). */
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* -- Fieldset reset -- (flat field list; spacing via each field's own
   margin-bottom, so gap is 0 to avoid double spacing). -- */
.edit-practice__fieldset {
  border: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.edit-practice__fieldset:disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* -- Date/time picker trigger field (mirrors the white VInput plate). -- */
.edit-practice__field {
  margin-bottom: var(--space-4);
}

.edit-practice__field-label {
  display: block;
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-2);
}

/* T21-1 (ПРОМТ №541): honest caption for the now-fallback Zoom field. */
.edit-practice__hint {
  margin: 0 0 var(--space-2);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.4;
}

.edit-practice__picker {
  display: flex;
  align-items: center;
  width: 100%;
  height: var(--velo-size-40);
  text-align: left;
  padding: 0 var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  background: var(--velo-bg-card-solid);
  border: 2px solid transparent;
  border-radius: var(--velo-radius-badge);
  cursor: pointer;
}

.edit-practice__picker--empty {
  color: var(--velo-text-muted);
}

/* -- Actions section (no «Действия» label/divider — just the buttons; operator
   EP-B2). The --space-5 content gap separates them from «Сохранить» above. -- */
.edit-practice__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* (confirm dialog now provided by <VConfirmDialog>) */
</style>
