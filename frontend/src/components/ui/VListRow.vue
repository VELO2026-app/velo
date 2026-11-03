<!--
  VELO Frontend -- VListRow (Admin DS, 2026-06-14, operator SVG return/revenue/check-in lists)

  A white card list row: an optional leading visual (avatar / ring icon), a title +
  subtitle text column, and an optional trailing visual (value / chevron). Used by
  the admin detail lists (low check-in practices, top loyal users, per-master payouts).

  Usage:
    <VListRow title="Anna K." subtitle="15 practices • 3 masters">
      <template #lead><VAvatar /></template>
      <template #trailing>€24,300</template>
    </VListRow>
-->

<template>
  <component
    :is="clickable ? 'button' : 'div'"
    :type="clickable ? 'button' : undefined"
    class="v-list-row"
    :class="{ 'v-list-row--clickable': clickable }"
    @click="clickable ? $emit('click') : undefined"
  >
    <span v-if="$slots.lead" class="v-list-row__lead"><slot name="lead" /></span>
    <div class="v-list-row__text">
      <span class="v-list-row__title">{{ title }}</span>
      <span v-if="subtitle" class="v-list-row__sub">{{ subtitle }}</span>
    </div>
    <span v-if="$slots.trailing" class="v-list-row__trailing"><slot name="trailing" /></span>
  </component>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
  clickable?: boolean
}>()

defineEmits<{ click: [] }>()
</script>

<style scoped>
.v-list-row {
  width: 100%;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  text-align: left;
  font-family: var(--font-body);
}

.v-list-row--clickable {
  cursor: pointer;
}

.v-list-row--clickable:active {
  opacity: 0.85;
}

.v-list-row__lead {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.v-list-row__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-3);
}

.v-list-row__title {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.v-list-row__sub {
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.v-list-row__trailing {
  flex-shrink: 0;
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}
</style>
