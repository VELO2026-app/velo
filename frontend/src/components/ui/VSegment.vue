<!--
  VELO Frontend -- VSegment Component (Phase B4.1)

  Segmented control: pick one option from a set. Covers in-page tab strips
  (Analytics, MasterPractices) and binary form toggles (Free/Paid). Glass pill
  canon: glass-blue-15 rest + primary active. Optional per-option count badge.

  Usage:
    <VSegment v-model="activeTab" :options="[
      { value: 'upcoming', label: 'Предстоящие', badge: 3 },
      { value: 'past',     label: 'Прошедшие' },
    ]" />
-->

<template>
  <div
    class="v-segment"
    :class="{ 'v-segment--compact': compact, 'v-segment--scrollable': scrollable }"
    role="tablist"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="tab"
      :aria-selected="modelValue === opt.value"
      class="v-segment__item"
      :class="{ 'v-segment__item--active': modelValue === opt.value }"
      @click="$emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
      <span
        v-if="opt.badge !== undefined && opt.badge !== null && opt.badge !== ''"
        class="v-segment__badge"
      >
        {{ opt.badge }}
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
export interface SegmentOption {
  value: string
  label: string
  /** Optional count/marker shown as a pill after the label. */
  badge?: string | number
}

withDefaults(
  defineProps<{
    modelValue: string
    options: SegmentOption[]
    /**
     * Compact/inline variant: the strip is sized to its content (not full-width
     * `flex:1`) and wrapped in a single glass pill — fits an inline title-row
     * toggle (e.g. dashboard «Неделя/Месяц»). Default false = the full-width
     * filter-strip behaviour used by the admin list screens.
     */
    compact?: boolean
    /**
     * Scrollable variant: lay the tabs on ONE line and scroll horizontally
     * instead of wrapping/clipping when there are more tabs than fit (e.g. the
     * 6-status masters filter). Items become content-sized + `nowrap`; the
     * scrollbar is hidden. Composes with `compact`. Default false.
     */
    scrollable?: boolean
  }>(),
  { compact: false, scrollable: false },
)

defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<style scoped>
.v-segment {
  display: flex;
  gap: var(--space-2);
}

.v-segment__item {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  background: var(--velo-glass-blue-15);
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-xl);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
  -webkit-tap-highlight-color: transparent;
}

.v-segment__item--active {
  color: var(--velo-white);
  background: var(--velo-primary);
  border-color: var(--velo-primary);
}

.v-segment__badge {
  background: var(--velo-glass-white-30);
  color: inherit;
  font-size: var(--text-xs);
  padding: 1px 6px;
  border-radius: var(--radius-full);
}

/* -- Compact/inline variant --
 * Content-sized single glass pill (not the full-width filter strip). The pill
 * frame lives on the container; the items are borderless transparent buttons so
 * only the active one fills. Matches the dashboard period-toggle idiom. */
.v-segment--compact {
  display: inline-flex;
  gap: var(--velo-gap-2);
  padding: var(--velo-gap-2);
  background: var(--velo-glass-blue-15);
  border: var(--velo-border-width) solid var(--velo-glass-border);
  border-radius: var(--radius-xl);
}

.v-segment--compact .v-segment__item {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  background: transparent;
  border: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.v-segment--compact .v-segment__item--active {
  color: var(--velo-white);
  background: var(--velo-primary);
  border-color: var(--velo-primary);
}

/* -- Scrollable variant --
 * Many tabs on one line: horizontal scroll instead of wrap/clip. Items are
 * content-sized + nowrap; the scrollbar is hidden (the pills hint the overflow).
 * Composes with --compact (which is otherwise content-sized inline-flex — here
 * it must be bound to the parent width so the overflow actually scrolls). */
.v-segment--scrollable {
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none; /* Firefox */
}

.v-segment--scrollable::-webkit-scrollbar {
  display: none; /* WebKit */
}

.v-segment--scrollable .v-segment__item {
  flex: 0 0 auto;
  white-space: nowrap;
}

.v-segment--compact.v-segment--scrollable {
  display: flex;
}
</style>
