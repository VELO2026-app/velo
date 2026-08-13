<!--
  VELO Frontend -- NotificationsView (Profile redesign Screen E; rebuilt T-26)

  The student's notification preferences. Owner ruling 2026-08-13 (option A):
  THE SCREEN FOLLOWS THE MACHINE -- the rows ARE the categories the comms
  service can actually mute, and nothing on the screen is allowed to lie.

  WHAT CHANGED AND WHY. The four rows here used to be push /
  practice_reminders / master_messages / support_messages, saved into
  credentials["notifications"] on our own backend. Nothing downstream ever
  read that store, so a user who muted was not muted. Delivery is decided by
  comms, by CATEGORY, so the rows are now categories:

    reminders         -- booking reminders (24h / 1h / 10m) + the post-practice
                         feedback and review prompts
    bookings          -- confirmations, cancellations, reschedules, waitlist
    msg_participants  -- chat messages and thread-closed notices. The two old
                         message rows (master messages / support messages)
                         MERGED into one because they were always ONE category:
                         comms picks the category by which SIDE of a thread you
                         are on, and a student is always the client side.
    finance           -- wallet top-ups and withdrawal outcomes

  `push` was not deleted, it was REDEFINED. It could never work as a channel
  switch -- comms preferences have no channel axis at all -- so it became the
  master switch: silence everything.

  THE MASTER SWITCH IS DERIVED, NEVER STORED. There is no "mute all" flag in
  comms and a second place of truth is exactly what the ruling forbade, so its
  position is computed: it reads OFF exactly when every shown category is
  muted. Re-enabling one row therefore lifts it by itself -- ruled acceptable
  because it is TRUE ("everything is off right now"), and when that stops
  being true the switch must show it. Rows stay LIVE while silenced, so one
  category can come back without losing the rest.

  FOUR, NOT FIVE. `msg_support` is a declared comms category but it reaches
  whoever OPERATES a thread -- a master -- never a student. It has no row and
  silence-everything does not touch it: a switch whose blast radius exceeds
  what it displays breaks "nothing lies" from the other side.

  BACKEND: GET/PUT /api/v1/notifications/prefs (api/notifications.ts) -> the
  comms proxy, which stamps recipient_id from the session. No mapping table --
  the rows already speak category names. credentials["notifications"] is gone.

  Route: /user/profile/notifications (name: 'user-notifications')
-->

<template>
  <div class="notifications">
    <VHeader title="Уведомления" show-back @back="router.back()" />

    <div class="notifications__content">
      <div class="notifications__row">
        <div class="notifications__text">
          <span class="notifications__label">{{ MASTER_LABEL }}</span>
          <span class="notifications__sub">{{ MASTER_SUB }}</span>
        </div>
        <VSwitch
          :model-value="anyEnabled"
          :disabled="!interactive || savingKey !== ''"
          :aria-label="MASTER_LABEL"
          @update:model-value="onMasterToggle"
        />
      </div>

      <div class="notifications__section">
        <h2 class="notifications__section-title">{{ SECTION_TITLE }}</h2>
        <div v-for="row in ROWS" :key="row.key" class="notifications__row">
          <div class="notifications__text">
            <span class="notifications__label">{{ row.label }}</span>
            <span class="notifications__sub">{{ row.sub }}</span>
          </div>
          <VSwitch
            :model-value="categories[row.key] ?? true"
            :disabled="!isControllable(row.key) || savingKey !== ''"
            :aria-label="row.label"
            @update:model-value="(value) => onRowToggle(row.key, value)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VSwitch } from '@/components/ui'
import { useToast } from '@/composables/useToast'
import { getNotificationPrefs, updateNotificationPrefs } from '@/api/notifications'

const router = useRouter()
const toast = useToast()

// The comms categories this screen governs, in display order. This list is
// ALSO the definition of "everything" for the master switch -- msg_support is
// deliberately absent (see the header).
const ROWS = [
  {
    key: 'reminders',
    // PROVISIONAL WORDING -- proposed, NOT ruled by the owner. He answered the
    // behavioural questions on 2026-08-13 and said nothing about the strings,
    // and silence is not approval. Every label below is a one-line edit; keep
    // it that way and do not treat any of them as final.
    label: 'Напоминания о практиках',
    sub: 'За сутки, за час и за 10 минут; просьба оставить отзыв',
  },
  {
    key: 'bookings',
    label: 'Записи и переносы',
    sub: 'Подтверждения, отмены, освободившееся место',
  },
  {
    key: 'msg_participants',
    label: 'Сообщения',
    sub: 'Новые сообщения в ваших чатах',
  },
  {
    key: 'finance',
    label: 'Кошелёк',
    sub: 'Пополнения и выплаты',
  },
] as const

type CategoryKey = (typeof ROWS)[number]['key']

// PROVISIONAL WORDING, same standing as the row labels above.
const MASTER_LABEL = 'Уведомления'
const MASTER_SUB = 'Выключите, чтобы не приходило ничего'
const SECTION_TITLE = 'Что присылать'

// Server state. Empty until the first successful load; a category the server
// does not report is one we cannot honestly control, so its row is disabled
// rather than shown as a working switch.
const categories = reactive<Record<string, boolean>>({})
const loadFailed = ref(false)
const savingKey = ref<string>('')

// A row is controllable only when comms actually reported its category.
function isControllable(key: string): boolean {
  return !loadFailed.value && key in categories
}

// The rows we may write: shown AND reported. Writing a category comms does not
// declare would be a 422, and writing one we do not show would exceed the
// switch's blast radius.
const writable = computed(() => ROWS.filter((row) => isControllable(row.key)))

// The master switch, derived rather than stored: ON while anything is still
// enabled, OFF exactly when every shown category is muted.
const anyEnabled = computed(() => writable.value.some((row) => categories[row.key]))

const interactive = computed(() => writable.value.length > 0)

async function loadPrefs(): Promise<void> {
  try {
    const prefs = await getNotificationPrefs()
    for (const row of ROWS) {
      const enabled = prefs.categories[row.key]
      if (enabled !== undefined) {
        categories[row.key] = enabled
      }
    }
    loadFailed.value = false
  } catch (error) {
    // comms down (502/504) or this recipient not synced yet (404). We show the
    // defaults but DISABLE every switch and say so: there is nowhere to save,
    // and a switch that accepts a flip it cannot persist is the exact lie this
    // screen was rebuilt to remove. (The master screen leaves its switches
    // live here; that difference is deliberate and was approved.)
    loadFailed.value = true
    toast.error('Не удалось загрузить настройки уведомлений')
    console.warn('notification prefs load failed', error)
  }
}
onMounted(loadPrefs)

async function persist(
  next: Partial<Record<CategoryKey, boolean>>,
  previous: Partial<Record<CategoryKey, boolean>>,
  key: string,
): Promise<void> {
  // Optimistic: apply now, revert on failure, so the switch never shows a
  // state the server did not accept.
  Object.assign(categories, next)
  savingKey.value = key
  try {
    await updateNotificationPrefs({ categories: next })
  } catch (error) {
    Object.assign(categories, previous)
    toast.error('Не удалось сохранить настройку')
    console.warn('preference save failed', error)
  } finally {
    savingKey.value = ''
  }
}

function snapshot(rows: readonly { key: CategoryKey }[]): Partial<Record<CategoryKey, boolean>> {
  const out: Partial<Record<CategoryKey, boolean>> = {}
  for (const row of rows) out[row.key] = categories[row.key]
  return out
}

function onRowToggle(key: CategoryKey, value: boolean): void {
  if (!isControllable(key) || savingKey.value) return
  void persist({ [key]: value }, { [key]: categories[key] }, key)
}

function onMasterToggle(value: boolean): void {
  if (!interactive.value || savingKey.value) return
  const rows = writable.value
  const next: Partial<Record<CategoryKey, boolean>> = {}
  for (const row of rows) next[row.key] = value
  void persist(next, snapshot(rows), '__master__')
}
</script>

<style scoped>
.notifications {
  display: flex;
  flex-direction: column;
  /* Break out of the layout's content padding so VHeader spans full width. */
  margin: calc(-1 * var(--space-4));
}

.notifications__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: 0 var(--space-4) var(--space-8);
}

.notifications__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.notifications__section-title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.notifications__row {
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

.notifications__text {
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-3);
  min-width: 0;
}

.notifications__label {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.notifications__sub {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  line-height: 1.25;
}
</style>
