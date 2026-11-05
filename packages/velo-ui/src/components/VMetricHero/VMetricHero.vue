<!--
  @velo/ui -- VMetricHero (Admin DS, 2026-06-14, operator SVG
  check-in/feedback/return; migrated FE-140 batch B)

  Hero metric card: a glass-teal icon circle + a large value + a caption. Used at the
  top of the admin metric-detail screens (Check-in / Feedback / Return rate).

  Stub-friendly: pass value="—" until the backend metric exists (build-full-design).

  Usage:
    <VMetricHero value="78%" label="Average check-in rate">
      <template #icon><IconCheck :size="30" /></template>
    </VMetricHero>
-->

<template>
  <div class="v-metric-hero">
    <span class="v-metric-hero__icon"><slot name="icon" /></span>
    <div class="v-metric-hero__body">
      <div class="v-metric-hero__value">{{ value }}</div>
      <div class="v-metric-hero__label">{{ label }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  value: string | number
  label: string
}>()
</script>

<style scoped>
.v-metric-hero {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4) var(--space-5);
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.v-metric-hero__icon {
  width: 52px;
  height: 52px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-400);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.v-metric-hero__body {
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-2);
  min-width: 0;
}

.v-metric-hero__value {
  font-family: var(--font-heading);
  font-size: var(--velo-fs-32);
  color: var(--velo-text-primary);
  letter-spacing: 0.64px;
  line-height: 1.05;
}

.v-metric-hero__label {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}
</style>
