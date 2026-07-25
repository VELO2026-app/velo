<!--
  VELO Frontend -- NotificationsView (Profile redesign Screen E)

  Notification preferences (Figma node 4715:3735, 74_Notifications): four
  on/off rows, each a label + VSwitch.

  PERSISTENCE: each toggle auto-saves on flip (no Save button, like the
  timezone screen on Screen F), silently (no toast -- flipping a switch is its
  own feedback). We send only the flipped key; the backend merges it onto the
  stored notifications object, so the other toggles are preserved. On failure
  we revert the switch and show an error toast.

  BACKEND NOTE: preferences live in credentials.notifications (schema-on-read,
  same pattern as phone/bio). Push delivery and the messages module are NOT
  wired yet -- these are forward-looking preferences that persist and survive
  relogin, ready for when those features land. Defaults are all ON.

  Route: /user/profile/notifications (name: 'user-notifications')
-->

<template>
  <div class="notifications">
    <VHeader title="Уведомления" show-back @back="router.back()" />

    <div class="notifications__content">
      <div v-for="row in ROWS" :key="row.key" class="notifications__row">
        <span class="notifications__label">{{ row.label }}</span>
        <VSwitch
          :model-value="settings[row.key]"
          :disabled="savingKey === row.key"
          :aria-label="row.label"
          @update:model-value="(value) => onToggle(row.key, value)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VSwitch } from '@/components/ui'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

// Keys must match the backend NotificationSettings shape.
type NotificationKey = 'push' | 'practice_reminders' | 'master_messages' | 'support_messages'

interface Row {
  key: NotificationKey
  label: string
}

const ROWS: Row[] = [
  { key: 'push', label: 'Push-уведомления' },
  { key: 'practice_reminders', label: 'Напоминания о практиках' },
  { key: 'master_messages', label: 'Сообщения от мастеров' },
  { key: 'support_messages', label: 'Сообщения от поддержки' },
]

// Local switch state, initialised from the profile (defaults all true). The
// backend always returns a full notifications object, so we read it directly;
// the `?? true` is a defensive fallback for an unexpectedly missing field.
const stored = authStore.user?.notifications
const settings = reactive<Record<NotificationKey, boolean>>({
  push: stored?.push ?? true,
  practice_reminders: stored?.practice_reminders ?? true,
  master_messages: stored?.master_messages ?? true,
  support_messages: stored?.support_messages ?? true,
})

// Which key is currently saving (disables just that switch).
const savingKey = ref<NotificationKey | ''>('')

async function onToggle(key: NotificationKey, value: boolean): Promise<void> {
  if (savingKey.value) return
  const previous = settings[key]
  settings[key] = value
  savingKey.value = key
  try {
    // Send only the flipped key; the backend merges it onto the stored set.
    await authStore.updateProfile({ notifications: { [key]: value } })
  } catch (error) {
    // Revert on failure so the UI matches the server.
    settings[key] = previous
    toast.error(extractApiError(error, 'Не удалось сохранить настройку'))
  } finally {
    savingKey.value = ''
  }
}
</script>

<style scoped>
.notifications {
  display: flex;
  flex-direction: column;
  margin: calc(-1 * var(--space-4));
}

.notifications__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}

.notifications__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  background: var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
}

.notifications__label {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}
</style>
