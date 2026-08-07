<!--
  VELO Frontend -- MasterNotificationsView (Phase-3 Master DS)

  Master-side notification preferences, reached from the master profile hub
  («Уведомления»). Operator decision 2026-06-13 (В1=Б): this is a SEPARATE
  master-only screen, NOT the shared user NotificationsView. The master design is
  far richer (bookings / participants / messages / analytics + a delivery
  schedule); the user view stays untouched (user role is frozen).

  Grouped on/off rows (label + optional sub + VSwitch) plus a «График
  уведомлений» block: a from/to delivery window (VSelect) and a VDayPicker.

  BACKEND (Phase 6 / T1): the CATEGORY toggles and the schedule now read and
  write the comms service through the velo proxy
  (GET/PUT /api/v1/notifications/prefs, api/notifications.ts). Mapping, per
  the locked grid §3 (Velo-Comms-Integration-Design.md):
    new_booking + booking_cancelled -> category `bookings` (ONE category --
        the two rows flip together; the split is a profile edit later)
    reminder                        -> category `reminders`
    msg_participants / msg_support  -> their own categories
    schedule                        -> comms quiet hours (the proxy converts
        the delivery-window semantics both ways)
  The four remaining rows (new_checkin / new_feedback / ai_summary /
  monthly_report) have NO comms types yet and stay LOCAL stubs -- explicit
  disposition (Master-chat 2026-07-28): when their types appear, move them
  into comms and drop the local persistence.

  Route: /master/profile/notifications (name 'master-notifications',
  meta.hideTabBar — back-nav settings sub-screen, no tab bar per the design).
-->
<template>
  <div class="master-notifications">
    <VHeader title="Уведомления" show-back @back="router.back()" />

    <div class="master-notifications__content">
      <section v-for="group in GROUPS" :key="group.title" class="mn-section">
        <h2 class="mn-section__title">{{ group.title }}</h2>
        <div v-for="row in group.rows" :key="row.key" class="mn-card">
          <div class="mn-card__text">
            <span class="mn-card__title">{{ row.label }}</span>
            <span v-if="row.sub" class="mn-card__sub">{{ row.sub }}</span>
          </div>
          <VSwitch
            :model-value="toggles[row.key]"
            :aria-label="row.label"
            @update:model-value="(v) => onToggle(row.key, v)"
          />
        </div>
      </section>

      <!-- Delivery schedule -->
      <section class="mn-section">
        <h2 class="mn-section__title">График уведомлений</h2>
        <p class="mn-section__sub">Получать уведомления с</p>
        <div class="mn-sched">
          <button type="button" class="mn-sched__field" @click="openTimePicker('from')">
            {{ schedule.from }}
          </button>
          <span class="mn-sched__sep">до</span>
          <button type="button" class="mn-sched__field" @click="openTimePicker('to')">
            {{ schedule.to }}
          </button>
        </div>
        <div class="mn-days-card">
          <VDayPicker
            :model-value="schedule.days"
            aria-label="Дни доставки уведомлений"
            @update:model-value="onScheduleDays"
          />
        </div>
      </section>
    </div>

    <TimePickerSheet
      :open="timePickerOpen"
      :model-value="schedule[timePickerEdge]"
      title="Время уведомлений"
      @update:model-value="onTimePicked"
      @close="timePickerOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VSwitch, VDayPicker } from '@/components/ui'
import TimePickerSheet from '@/components/shared/TimePickerSheet.vue'
import {
  getNotificationPrefs,
  updateNotificationPrefs,
} from '@/api/notifications'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const toast = useToast()

// --- Toggle rows -----------------------------------------------------------
// Forward-looking keys (not yet in the typed NotificationSettings contract; see
// the file header), grouped exactly as the operator design.
type ToggleKey =
  | 'new_booking'
  | 'booking_cancelled'
  | 'reminder'
  | 'new_checkin'
  | 'new_feedback'
  | 'msg_participants'
  | 'msg_support'
  | 'ai_summary'
  | 'monthly_report'

interface Row {
  key: ToggleKey
  label: string
  sub?: string
}
interface Group {
  title: string
  rows: Row[]
}

const GROUPS: Group[] = [
  {
    title: 'Практики',
    rows: [
      { key: 'new_booking', label: 'Новое бронирование', sub: 'Кто-то записался' },
      { key: 'booking_cancelled', label: 'Отмена бронирования', sub: 'Кто-то отменил' },
      { key: 'reminder', label: 'Напоминание', sub: 'За 1 час до начала' },
    ],
  },
  {
    title: 'Участники',
    rows: [
      {
        key: 'new_checkin',
        label: 'Новый check-in',
        sub: 'Участник отметился о состоянии перед практикой',
      },
      { key: 'new_feedback', label: 'Новый feedback', sub: 'Участник оставил отзыв' },
    ],
  },
  {
    title: 'Сообщения',
    // P-2 (H-T2-UI): labels follow the RECEIVER side of the msg.* axis
    // (comms app/notifier.py:214-232): a thread's OPERATOR -- the master --
    // receives students' chat messages as msg.support_message -> category
    // msg_support, REGARDLESS of thread form; msg_participants reaches the
    // master only where they are the CLIENT of somebody else's thread. The
    // old labels («От участников» / «От поддержки») said the opposite of
    // what the toggles do. msg_support first: it is the one that matters
    // to a master. Texts approved by Master-chat (Т-10); wording is the
    // boss's to replay after the show -- a two-line edit here.
    rows: [
      {
        key: 'msg_support',
        label: 'Сообщения учеников',
        sub: 'Новые сообщения в ваших чатах',
      },
      {
        key: 'msg_participants',
        label: 'Ответы в ваших обращениях',
        sub: 'Чаты, где вы — автор',
      },
    ],
  },
  {
    title: 'Аналитика',
    rows: [
      { key: 'ai_summary', label: 'AI-саммари', sub: 'По понедельникам' },
      { key: 'monthly_report', label: 'Ежемесячный отчет', sub: '1-го числа месяца' },
    ],
  },
]

// toggle key -> comms category (T1). Keys absent here are local stubs.
const CATEGORY_BY_KEY: Partial<Record<ToggleKey, string>> = {
  new_booking: 'bookings',
  booking_cancelled: 'bookings',
  reminder: 'reminders',
  msg_participants: 'msg_participants',
  msg_support: 'msg_support',
}

// Defaults mirror the operator-approved design (all on except the monthly report).
const toggles = reactive<Record<ToggleKey, boolean>>({
  new_booking: true,
  booking_cancelled: true,
  reminder: true,
  new_checkin: true,
  new_feedback: true,
  msg_participants: true,
  msg_support: true,
  ai_summary: true,
  monthly_report: false,
})

// --- Delivery schedule -----------------------------------------------------
const schedule = reactive<{ from: string; to: string; days: string[] }>({
  from: '08:00',
  to: '22:00',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
})

// Wheel time-picker (operator 2026-06-19: switch the from/to dropdowns to the same
// scroll-wheel sheet as the practice form). One sheet, reused for both edges.
const timePickerOpen = ref(false)
const timePickerEdge = ref<'from' | 'to'>('from')

function openTimePicker(edge: 'from' | 'to'): void {
  timePickerEdge.value = edge
  timePickerOpen.value = true
}
function onTimePicked(value: string): void {
  schedule[timePickerEdge.value] = value
  timePickerOpen.value = false
  persistSchedule()
}

// --- Comms persistence (Phase 6 / T1) --------------------------------------
// Category toggles + schedule live in comms; loading merges the server state
// over the local defaults (stub keys keep their defaults). A failed load
// (comms down -> 502/504, or the recipient not yet synced -> 404) leaves the
// defaults on screen -- the settings screen degrades, it never crashes.
async function loadPrefs(): Promise<void> {
  try {
    const prefs = await getNotificationPrefs()
    for (const [key, category] of Object.entries(CATEGORY_BY_KEY)) {
      // noUncheckedIndexedAccess: read once, narrow on the value --
      // an `in` guard does not narrow indexed access.
      const enabled = category ? prefs.categories[category] : undefined
      if (enabled !== undefined) {
        toggles[key as ToggleKey] = enabled
      }
    }
    if (prefs.schedule) {
      schedule.from = prefs.schedule.from
      schedule.to = prefs.schedule.to
      schedule.days = prefs.schedule.days
    }
  } catch (error) {
    // H-R2 (3.6): a silent load failure left the screen showing defaults
    // the server never confirmed -- surface it (same tone as the
    // category handler below).
    toast.error('Не удалось загрузить настройки уведомлений')
    console.warn('notification prefs load failed', error)
  }
}
onMounted(loadPrefs)

function persistSchedule(): void {
  updateNotificationPrefs({
    schedule: { from: schedule.from, to: schedule.to, days: [...schedule.days] },
  }).catch((error) => {
    // H-R2 (3.6): the schedule save failing silently meant the picker
    // showed a schedule the server never accepted.
    toast.error('Не удалось сохранить расписание')
    console.warn('schedule save failed', error)
  })
}

// --- Handlers --------------------------------------------------------------
function onToggle(key: ToggleKey, value: boolean): void {
  const category = CATEGORY_BY_KEY[key]
  if (!category) {
    // Local stub (no comms type yet) -- see the file header disposition.
    toggles[key] = value
    return
  }
  // Optimistic: flip now, revert on failure so the switch never shows a
  // state the server did not accept (the screen must not lie about
  // whether a category is muted).
  const prev = toggles[key]
  const prevBookingPair =
    category === 'bookings'
      ? { nb: toggles.new_booking, bc: toggles.booking_cancelled }
      : null
  toggles[key] = value
  if (category === 'bookings') {
    // ONE category behind two rows -- keep them visually in sync.
    toggles.new_booking = value
    toggles.booking_cancelled = value
  }
  updateNotificationPrefs({ categories: { [category]: value } }).catch(
    (error) => {
      toggles[key] = prev
      if (prevBookingPair) {
        toggles.new_booking = prevBookingPair.nb
        toggles.booking_cancelled = prevBookingPair.bc
      }
      toast.error('Не удалось сохранить настройку')
      console.warn('preference save failed', error)
    },
  )
}
function onScheduleDays(days: string[]): void {
  schedule.days = days
  persistSchedule()
}
</script>

<style scoped>
.master-notifications {
  display: flex;
  flex-direction: column;
  /* Break out of the layout's content padding so VHeader spans full width —
     mirrors the sibling settings screens (NotificationsView/LanguageTimezone). */
  margin: calc(-1 * var(--space-4));
}

.master-notifications__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  /* Extra bottom space so the «График уведомлений» block isn't glued to the
     bottom edge (operator 2026-06-19). */
  padding: 0 var(--space-4) var(--space-8);
}

.mn-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.mn-section__title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.mn-section__sub {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  margin: calc(-1 * var(--space-1)) 0 0;
}

.mn-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-height: 51px;
  padding: var(--space-3) var(--velo-inset-row);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
}

.mn-card__text {
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-3);
  min-width: 0;
}

.mn-card__title {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.mn-card__sub {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  line-height: 1.25;
}

.mn-sched {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* Tappable time field — white plate that opens the wheel sheet (mirrors a select). */
.mn-sched__field {
  flex: 1;
  height: var(--velo-size-40);
  padding: 0 var(--space-4);
  display: flex;
  align-items: center;
  background: var(--velo-bg-card-solid);
  border: 2px solid transparent;
  border-radius: var(--velo-radius-badge);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  cursor: pointer;
  transition: border-color var(--transition-base);
}

.mn-sched__field:focus-visible {
  outline: none;
  border-color: var(--velo-border-input-focus);
}

.mn-sched__sep {
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
}

/* Day-of-week pills sit on a white plate (operator 2026-06-19). */
.mn-days-card {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--velo-inset-row);
}
</style>
