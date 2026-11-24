<!--
  VELO Frontend -- ConsoleSplit (FE-262)

  Master-detail of the web console: a list on the left, the open item on the
  right, both filling the page height and scrolling on their own (complaints,
  support tickets, the catalog). The list keeps a fixed width.

  Slots: `list`, `detail`.
-->

<template>
  <div class="console-split">
    <div class="console-split__list" :style="{ flexBasis: `${listWidth}px` }">
      <slot name="list" />
    </div>
    <div class="console-split__detail">
      <slot name="detail" />
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Width of the list column, px. */
    listWidth?: number
  }>(),
  { listWidth: 400 },
)
</script>

<style scoped>
.console-split {
  display: flex;
  flex: 1 1 auto;
  align-items: stretch;
  gap: var(--space-4);
  min-height: 0;
}

.console-split__list {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.console-split__detail {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}
</style>
