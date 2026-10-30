<!--
  VELO Frontend -- VSkeletonPracticeCard

  Loading placeholder with PracticeListCard's exact box: same white card,
  min-height, paddings, icon column and meta row -- the card that replaces it
  lands in the same place. Used by list screens while their first page loads.
-->

<template>
  <div class="v-skeleton-practice" aria-hidden="true">
    <div class="v-skeleton-practice__top">
      <span class="v-skeleton-practice__iconcol">
        <VSkeleton shape="circle" size="var(--velo-size-46)" />
      </span>
      <div class="v-skeleton-practice__content">
        <VSkeleton width="68%" />
        <VSkeleton width="42%" height="0.75em" />
      </div>
    </div>
    <div class="v-skeleton-practice__meta">
      <span class="v-skeleton-practice__iconcol">
        <VSkeleton width="70%" height="0.75em" />
      </span>
      <VSkeleton width="30%" height="0.75em" />
    </div>
  </div>
</template>

<script setup lang="ts">
import VSkeleton from './VSkeleton.vue'
</script>

<style scoped>
.v-skeleton-practice {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--velo-card-height-list);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--velo-card-padding-x);
  font-size: var(--text-base);
}

.v-skeleton-practice__top {
  display: flex;
  gap: var(--space-3);
}

.v-skeleton-practice__iconcol {
  width: var(--velo-card-iconcol-w);
  flex-shrink: 0;
  display: flex;
  justify-content: center;
}

.v-skeleton-practice__content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--space-2);
}

.v-skeleton-practice__meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: auto;
}
</style>
