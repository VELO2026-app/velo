<!--
  VELO Frontend -- VPaginationDots (DS component)

  Canonical "screen-switch" dots — the single source for the dot indicator used
  by multi-step wizards (master apply) and intro carousels (onboarding).
  Operator-canonized 2026-06-27, replacing the older 13×7 pill:
    active   = 13×13 circle, --velo-text-primary
    inactive = 7×7 circle,   rgba(76,101,137,0.6)   (brand text @ 60%; no token)

  Placement is the CONSUMER's responsibility (wizard = top-left, carousel =
  bottom-center) — this renders only the dot row.

  Usage: <VPaginationDots :total="3" :active="step" />   (active is 0-based)
-->

<template>
  <div class="v-pagination-dots" role="presentation" aria-hidden="true">
    <span
      v-for="i in total"
      :key="i"
      class="v-pagination-dots__dot"
      :class="{ 'v-pagination-dots__dot--active': i - 1 === active }"
    />
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Total number of dots (steps / slides). */
    total: number
    /** Active dot index, 0-based. */
    active?: number
  }>(),
  { active: 0 },
)
</script>

<style scoped>
.v-pagination-dots {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.v-pagination-dots__dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  /* Inactive = brand text @ 60%. No 0.6-alpha token exists; this is now the
     single canonical home for the value (operator-canonized 2026-06-27). */
  background: var(--velo-glass-blue-700-60);
  transition:
    width var(--transition-fast),
    height var(--transition-fast),
    background var(--transition-fast);
}

.v-pagination-dots__dot--active {
  width: 13px;
  height: 13px;
  background: var(--velo-text-primary);
}
</style>
