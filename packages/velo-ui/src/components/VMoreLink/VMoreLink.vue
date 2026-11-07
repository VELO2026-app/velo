<!--
  VELO Frontend -- VMoreLink (the single "more" control, i18n:ui.more)

  The ONE forward-link look for the whole project: a text label on the left +
  a white pill with the `IconArrowRight` arrow on the right (the same white
  63×40 pill as VBackButton -- the canon: a clear arrow on a white
  background). The word comes BEFORE the arrow.

  Canon fixed by the operator 2026-06-04: so the more link (i18n:ui.more)
  never drifts out of shape across screens -- every use-site takes this
  component instead of hand-rolling its own.

  Use-sites: MasterCard (the more link -> the master's profile),
  UserDashboardView (AI summary -> the detail screen). Navigation stays with
  the caller (emits click).

  Usage:
    <VMoreLink @click="router.push(...)" />
    <VMoreLink label="All reviews" @click="..." />
-->

<template>
  <button type="button" class="v-more" @click="$emit('click')">
    <span class="v-more__text">{{ label ?? t('ui.more') }}</span>
    <span class="v-more__pill">
      <IconArrowRight :size="18" />
    </span>
  </button>
</template>

<script setup lang="ts">
import { t } from '../../i18n'
import { IconArrowRight } from '../../icons'

// tz-i18n 1.3: label fallback resolves at render time (?? t() in template).

defineProps<{
  /** Text to the left of the arrow. Defaults to the more copy (i18n:ui.more). */
  label?: string
}>()

defineEmits<{ click: [] }>()
</script>

<style scoped>
.v-more {
  display: flex;
  align-items: center;
  /* The content (text + pill) is flushed right; width:100% -- so the flush
   * works in any parent (not only a stretch column). */
  justify-content: flex-end;
  width: 100%;
  gap: var(--space-3);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.v-more:hover,
.v-more:active {
  opacity: 0.8;
}

.v-more__text {
  font-family: var(--font-body);
  font-size: var(--velo-fs-14);
  letter-spacing: var(--velo-card-letter-spacing-meta);
  color: var(--velo-text-primary);
}

/* White pill with the arrow -- the same size/look as VBackButton (the
 * canon: a clear arrow on a white background). A right-pointing arrow
 * means forward. */
.v-more__pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 63px;
  height: var(--velo-size-40);
  border-radius: var(--radius-full);
  background: var(--velo-bg-card-solid);
  color: var(--velo-text-primary);
}
</style>
