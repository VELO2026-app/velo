<!--
  VELO Frontend -- NotificationRow (T-26 bell, PROMPT №704)

  One bell item: a LEFT icon block (the diary's tcard__ibox recipe, list
  scale) with the unread dot UNDER it, then title + relative time on one
  vertically-centered line and the body full-width, clamped to 2 lines with
  an ellipsis. Mirrors ChatListRow.vue's shape (button, own click ->
  emit('open')) for the same reason -- a single tappable row in a list,
  degrading rather than breaking on missing data.

  `icon` is optional: 'message' (IconMessages) / 'event' (IconCalendar).
  Absent = dot only, no icon block -- the master inbox's approved T-26 look.

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
    <span class="notif-row__side">
      <span v-if="icon" class="notif-row__ibox">
        <IconMessages v-if="icon === 'message'" :size="20" />
        <IconCalendar v-else :size="20" />
      </span>
      <span v-if="unread" class="notif-row__dot" />
    </span>
    <span class="notif-row__body">
      <span class="notif-row__head">
        <span class="notif-row__title">{{ title }}</span>
        <span class="notif-row__time">{{ formatRelative(sentAt) }}</span>
      </span>
      <span class="notif-row__text">{{ body }}</span>
    </span>
  </button>
</template>

<script setup lang="ts">
import { IconCalendar, IconMessages } from '@/components/icons'
import { formatRelative } from '@/utils/adminHelpers'

defineProps<{
  title: string
  body: string
  sentAt: string
  unread: boolean
  /** Optional type marker: 'message' | 'event'. Absent = no icon. */
  icon?: 'message' | 'event'
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

/* Left side: the diary's icon-box recipe (tcard__ibox, DiaryThreadCard) at
   list scale -- a 36px block, badge radius, glass tint on the card -- with
   the unread dot centered UNDER it. */
.notif-row__side {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
}

.notif-row__ibox {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--velo-radius-badge);
  /* No background tint (owner ask FE-12): the icon block is a bare glyph on
     the card, like the read state already renders. */
  color: var(--velo-text-primary);
}

.notif-row--read .notif-row__ibox {
  color: var(--velo-text-secondary);
}

.notif-row__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
}

.notif-row__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: var(--space-1);
}

/* Title + time on one line, centered vertically; the title is the flexible
   middle that ellipsizes so the time never leaves the line. */
.notif-row__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.notif-row__title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.notif-row--read .notif-row__title {
  color: var(--velo-text-secondary);
}

.notif-row__time {
  flex-shrink: 0;
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

/* Full-width body, at most 2 lines, then an ellipsis. */
.notif-row__text {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
</style>
