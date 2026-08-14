<!--
  VELO Frontend -- NotificationRow (T-26 bell, PROMPT №704)

  One bell item: unread dot + title + body (one line, ellipsized) + relative
  time. Mirrors ChatListRow.vue's shape (button, own click -> emit('open'))
  for the same reason -- a single tappable row in a list, degrading rather
  than breaking on missing data.

  formatRelative is @/utils/adminHelpers -- the name is legacy (ModerationFilterModal.vue
  already reuses it outside admin), not an admin-only utility.
-->

<template>
  <button
    type="button"
    class="notif-row"
    :class="{ 'notif-row--read': !unread }"
    @click="emit('open')"
  >
    <span class="notif-row__dot" :class="{ 'notif-row__dot--hidden': !unread }" />
    <span class="notif-row__body">
      <span class="notif-row__title">{{ title }}</span>
      <span class="notif-row__text">{{ body }}</span>
    </span>
    <span class="notif-row__time">{{ formatRelative(sentAt) }}</span>
  </button>
</template>

<script setup lang="ts">
import { formatRelative } from '@/utils/adminHelpers'

defineProps<{
  title: string
  body: string
  sentAt: string
  unread: boolean
}>()

const emit = defineEmits<{ open: [] }>()
</script>

<style scoped>
.notif-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--velo-inset-row);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  cursor: pointer;
  text-align: left;
}

.notif-row__dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  flex-shrink: 0;
}

.notif-row__dot--hidden {
  background: transparent;
}

.notif-row__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.notif-row__title {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.notif-row--read .notif-row__title {
  color: var(--velo-text-secondary);
}

.notif-row__text {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notif-row__time {
  flex-shrink: 0;
  align-self: flex-start;
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}
</style>
