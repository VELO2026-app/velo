<!--
  VELO Frontend -- MetricFacts (FE-268)

  The counts behind a rate, as a row of "caption over number" pairs
  (records and check-ins, visitors and reviews, participants and returners).
-->

<template>
  <dl class="facts">
    <div v-for="fact in facts" :key="fact.label" class="facts__item">
      <dt class="facts__label">{{ fact.label }}</dt>
      <dd class="facts__value">{{ fact.value }}</dd>
    </div>
  </dl>
</template>

<script setup lang="ts">
defineProps<{
  /** The pairs, in reading order; the value is already formatted. */
  facts: { label: string; value: string }[]
}>()
</script>

<style scoped>
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-8);
  margin: 0;
}

.facts__item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.facts__label {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.facts__value {
  margin: 0;
  font-size: var(--velo-fs-24);
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}
</style>
