<!--
  VELO Frontend -- ConsoleSplit (FE-262)

  Master-detail of the web console: a list on the left, the open item on the
  right, both filling the page height and scrolling on their own (complaints,
  support tickets, the catalog). The list keeps a fixed width.

  `pane` -- on a narrow window (a tablet) the two do not fit side by side:
  `list` shows the list alone, `detail` the open item alone (the screen
  decides which and gives a way back); `both` (default) is side by side.

  Slots: `list`, `detail`.
-->

<template>
  <div class="console-split">
    <div
      v-if="pane !== 'detail'"
      class="console-split__list"
      :class="{ 'console-split__list--alone': pane === 'list' }"
      :style="pane === 'both' ? { flexBasis: `${listWidth}px` } : undefined"
    >
      <slot name="list" />
    </div>
    <div v-if="pane !== 'list'" class="console-split__detail">
      <slot name="detail" />
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Width of the list column, px. */
    listWidth?: number
    /** Which columns show: both side by side, the list alone, the detail alone. */
    pane?: 'both' | 'list' | 'detail'
  }>(),
  { listWidth: 400, pane: 'both' },
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

.console-split__list--alone {
  flex: 1 1 auto;
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
