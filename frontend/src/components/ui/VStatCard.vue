<!--
  VELO Frontend -- VStatCard Component (Phase F2.1)

  Numeric stat card. Matches mockup .stat-card styles.
  Used in dashboards (user stats, admin stats, master analytics).

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
      {{ value }}
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
  }>(),
  {
    icon: '',
    clickable: false,
    layout: 'column',
    delta: '',
    deltaTone: 'up',
    valueTone: 'default',
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
  gap: 9px;
  text-align: center;
  transition: all var(--transition-base);
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
  font-size: var(--text-xs);
}

.v-stat__icon {
  display: block;
  font-size: 24px;
  /* Vector DS icons inside the slot inherit this as currentColor. */
  color: var(--velo-text-primary);
}

.v-stat__value {
  /* Match shipped user-dashboard stat value: heading font, 32px, primary. */
  font-family: var(--font-heading);
  font-size: var(--text-xl);
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
  font-size: 13px;
  color: var(--velo-text-secondary);
  white-space: nowrap;
}

/* Optional trend line (master dashboard stats: "+3" / "+12%"). */
.v-stat__delta {
  font-size: var(--text-xs);
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
</style>
