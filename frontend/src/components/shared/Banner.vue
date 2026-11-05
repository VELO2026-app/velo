<!--
  VELO Frontend -- Banner (DS, 2026-05)

  Shared alert/notice banner. Used in:
    - UserDashboardView: the check-in reminder banner
      (i18n:user.screens.userDashboard.checkinBanner.title, warning) + the
      leave-feedback reminder banner (success)
    - PracticeDetailView: the contraindications banner
      (i18n:user.screens.practiceDetail.contraindications, warning)

  Visual spec (Figma SVGs dashboard, booked-practice):
    - Min-height 64px, full content width
    - Border 2px solid (theme color), backdrop-filter blur(2px)
    - Themed background (variant pastel) + themed icon/title/body colors
    - Layout: icon left (flex-start aligned), title + body to the right

  Variants -> color tokens (variables.css):
    warning -> --velo-glass-peach-40 / --velo-warning-border /
               --velo-peach-700 (icon+title) / --velo-peach-500 (body)
    success -> --velo-glass-teal-40 / --velo-success /
               --velo-teal-700 (icon+title) / --velo-teal-600 (body)
    info    -> --velo-glass-blue-15 / --velo-border /
               --velo-text-primary (icon+title) / --velo-text-secondary (body)
    error   -> --velo-error-bg / --velo-error-border /
               --velo-error-text / --velo-error-text
    alert   -> --velo-glass-pink-40 / --velo-pink-300 /
               --velo-danger-text (icon + title + body) -- stronger red than
               `error`; the admin moderation-queue banner
               (i18n:adminScreens.adminDashboard.moderationBanner).

  Slots:
    #icon (optional) — left-aligned icon. If empty, no icon column.

  Usage:
    <Banner variant="warning" title="Title text" body="Body text">
      <template #icon><IconClock :size="28" /></template>
    </Banner>
-->

<template>
  <component
    :is="clickable ? 'button' : 'div'"
    :type="clickable ? 'button' : undefined"
    :class="['banner', `banner--${variant}`, { 'banner--clickable': clickable }]"
    @click="clickable ? $emit('click') : null"
  >
    <span v-if="$slots.icon" class="banner__icon">
      <slot name="icon" />
    </span>
    <div class="banner__text">
      <p v-if="title" class="banner__title">{{ title }}</p>
      <p v-if="body" class="banner__body">{{ body }}</p>
      <slot name="body" />
    </div>
  </component>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'warning' | 'success' | 'info' | 'error' | 'alert'
    title?: string
    body?: string
    clickable?: boolean
  }>(),
  {
    variant: 'info',
    title: '',
    body: '',
    clickable: false,
  },
)

defineEmits<{ click: [] }>()
</script>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: var(--velo-banner-gap-icon-text);
  width: 100%;
  min-height: var(--velo-banner-min-height);
  border-radius: var(--radius-md);
  border-width: var(--velo-banner-border-width);
  border-style: solid;
  padding: var(--velo-banner-padding);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  text-align: left;
  font-family: var(--font-body);
  transition: opacity var(--transition-fast);
}

.banner--clickable {
  cursor: pointer;
}

.banner--clickable:hover {
  opacity: 0.92;
}

.banner__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.banner__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-2);
}

.banner__title {
  font-size: var(--velo-fs-18);
  margin: 0;
  letter-spacing: var(--velo-card-letter-spacing-title);
}

.banner__body {
  font-size: var(--velo-fs-14);
  margin: 0;
  letter-spacing: var(--velo-card-letter-spacing-meta);
  line-height: 1.4;
}

/* === Variants === */

.banner--warning {
  background: var(--velo-glass-peach-40);
  border-color: var(--velo-warning-border);
}
.banner--warning .banner__icon,
.banner--warning .banner__title {
  color: var(--velo-peach-700);
}
.banner--warning .banner__body {
  color: var(--velo-peach-500);
}

.banner--success {
  background: var(--velo-glass-teal-40);
  border-color: var(--velo-success);
}
.banner--success .banner__icon,
.banner--success .banner__title {
  color: var(--velo-teal-700);
}
.banner--success .banner__body {
  color: var(--velo-teal-600);
}

.banner--info {
  background: var(--velo-glass-blue-15);
  border-color: var(--velo-border);
}
.banner--info .banner__icon,
.banner--info .banner__title {
  color: var(--velo-text-primary);
}
.banner--info .banner__body {
  color: var(--velo-text-secondary);
}

.banner--error {
  background: var(--velo-error-bg);
  border-color: var(--velo-error-border);
}
.banner--error .banner__icon,
.banner--error .banner__title,
.banner--error .banner__body {
  color: var(--velo-error-text);
}

.banner--alert {
  background: var(--velo-glass-pink-40);
  border-color: var(--velo-pink-300);
}
.banner--alert .banner__icon,
.banner--alert .banner__title,
.banner--alert .banner__body {
  color: var(--velo-danger-text);
}
</style>
