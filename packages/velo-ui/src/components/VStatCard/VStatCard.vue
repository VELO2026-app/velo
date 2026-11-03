<!--
  @velo/ui -- VStatCard Component (Phase F2.1; migrated FE-140 batch B)

  Numeric stat card. Matches mockup .stat-card styles.
  Used in dashboards (user stats, admin stats, master analytics).

  §7.2 (FE-140): the batch A deferral's VSkeleton dependency (the skeleton
  family lives outside this batch's map) is cut the VButton-spinner way --
  the pending placeholder is a `pending` slot with the canonical fallback
  below; a host may substitute its own skeleton without forking the card.

  Usage:
    <VStatCard value="156" label="участников">
      <template #icon><IconGroup :size="24" /></template>
    </VStatCard>
    <VStatCard value="€1,280" label="доход" />
-->

<template>
  <div
    class="v-stat"
    :class="[`v-stat--${layout}`, { 'v-stat--clickable': clickable }]"
    :role="clickable ? 'button' : undefined"
    :tabindex="clickable ? 0 : undefined"
    :data-velo-layout="layout"
    :data-velo-clickable="clickable || undefined"
    :data-velo-pending="valuePending || undefined"
    :data-velo-value-tone="valueTone"
    @click="clickable ? $emit('click') : undefined"
    @keydown.enter.space.prevent="clickable ? $emit('click') : undefined"
  >
    <span v-if="$slots.icon || icon" class="v-stat__icon">
      <slot name="icon">{{ icon }}</slot>
    </span>
    <div
      class="v-stat__value"
      :class="valueTone !== 'default' ? `v-stat__value--${valueTone}` : null"
    >
      <template v-if="valuePending"
        >&#8203;<slot name="pending">
          <span class="v-stat__value-skeleton" aria-hidden="true" /> </slot
      ></template>
      <template v-else>{{ value }}</template>
    </div>
    <div class="v-stat__label">{{ label }}</div>
    <div v-if="delta" class="v-stat__delta" :class="`v-stat__delta--${deltaTone}`">{{ delta }}</div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    value: string | number
    label: string
    icon?: string
    clickable?: boolean
    /** 'column' (default, stacked value/label) or 'row' (compact baseline row). */
    layout?: 'column' | 'row'
    /** Optional trend line under the label (e.g. "+3", "+12%"). Empty = hidden. */
    delta?: string
    /** Delta tone: 'up' (teal, positive, default) / 'down' (rose, negative) /
     *  'muted' (zero or placeholder). */
    deltaTone?: 'up' | 'down' | 'muted'
    /** Value colour: 'default' (primary) / 'teal' (attended) / 'rose' (no-show).
     *  Used by the practice-detail + attendance-roster stat cards. */
    valueTone?: 'default' | 'teal' | 'rose'
    /** The value is still loading: a placeholder of the value's own line
     *  height stands in, so the card does not resize -- and no false «0»
     *  is ever shown before the real number arrives. */
    valuePending?: boolean
  }>(),
  {
    icon: '',
    clickable: false,
    layout: 'column',
    delta: '',
    deltaTone: 'up',
    valueTone: 'default',
    valuePending: false,
  },
)

defineEmits<{
  click: []
}>()
</script>

<style scoped>
.v-stat {
  /* White surface standard (Figma 2026-06), matching the shipped user-dashboard
     stat cards: opaque white + 1px white border + radius-md, content centred.
     Replaces the old glass fill + blue border + radius-lg. */
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  text-align: center;
  transition: transform var(--transition-base);
}

.v-stat--clickable {
  cursor: pointer;
}

.v-stat--clickable:hover {
  /* box-shadow: var(--shadow-md) removed PROMPT №437 (operator ruling: VELO is
     flat). --shadow-md was `none`, so the hover shadow never existed; the lift
     below is what the interaction actually shows. Renders identically. */
  transform: translateY(-2px);
}

/* Row layout: compact baseline row (value + label inline). Used on the master
   public profile stats (migrated from a hand-rolled pattern, U3 2026-06-06). */
.v-stat--row {
  flex-direction: row;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-3);
}

.v-stat--row .v-stat__value {
  letter-spacing: normal;
}

.v-stat--row .v-stat__label {
  font-size: var(--velo-fs-14);
}

.v-stat__icon {
  display: block;
  font-size: var(--velo-fs-24);
  /* Vector DS icons inside the slot inherit this as currentColor. */
  color: var(--velo-text-primary);
}

.v-stat__value {
  /* Match shipped user-dashboard stat value: heading font, 32px, primary. */
  font-family: var(--font-heading);
  font-size: var(--velo-fs-32);
  color: var(--velo-text-primary);
  letter-spacing: 0.64px;
  line-height: 1.1;
}

/* Optional value tones (practice-detail / attendance-roster stat cards). */
.v-stat__value--teal {
  color: var(--velo-teal-600);
}

.v-stat__value--rose {
  color: var(--velo-pink-500);
}

.v-stat__label {
  /* 13px (slightly under --text-xs) + secondary, no-wrap — matches user dash. */
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
  white-space: nowrap;
}

/* Optional trend line (master dashboard stats: "+3" / "+12%"). */
.v-stat__delta {
  font-size: var(--velo-fs-14);
  line-height: 1;
}

.v-stat__delta--up {
  color: var(--velo-teal-600);
}

/* Negative trend — reuses the falling-income rose token (AnalyticsView income
   delta + v-stat value--rose). Additive: only the 'down' value selects it. */
.v-stat__delta--down {
  color: var(--velo-pink-500);
}

.v-stat__delta--muted {
  color: var(--velo-text-muted);
}
/* Canonical pending placeholder (§7.2, FE-140) -- the exact recipe the app's
   VSkeleton rendered for this spot (loading system §8.3.3, carried verbatim):
   a calm opacity "breath", never a sweep; fades in only after
   --velo-skeleton-delay, so a fast answer never flashes it; decorative, so
   aria-hidden. Own keyframe names -- the kit must not lean on app CSS. */
.v-stat__value-skeleton {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
  width: 1.6em;
  height: 0.8em;
  background: var(--velo-skeleton-fill);
  border-radius: var(--radius-full);
  animation:
    v-stat-skeleton-appear var(--velo-dur-base) var(--velo-ease-out) var(--velo-skeleton-delay) both,
    v-stat-skeleton-breath var(--velo-dur-pulse) var(--velo-ease-breath)
      calc(var(--velo-skeleton-delay) + var(--velo-dur-base)) infinite;
}

@keyframes v-stat-skeleton-appear {
  from {
    opacity: 0;
  }
}

@keyframes v-stat-skeleton-breath {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.55;
  }
}

@media (prefers-reduced-motion: reduce) {
  .v-stat__value-skeleton {
    animation: v-stat-skeleton-appear var(--velo-dur-base) linear var(--velo-skeleton-delay) both;
  }
}
</style>
