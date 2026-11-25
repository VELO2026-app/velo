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
      :style="
        pane === 'both'
          ? {
              flexBasis: `calc(${listWidth}px + var(--split-room-side) + var(--split-room-gap))`,
            }
          : undefined
      "
    >
      <slot name="list" />
    </div>
    <div
      v-if="pane !== 'list'"
      class="console-split__detail"
      :class="{ 'console-split__detail--alone': pane === 'detail' }"
    >
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
  /* The room a pane keeps for the card shadow: the outer side, the inner
     side (half the gap), the top and the bottom. */
  --split-room-side: var(--space-5);
  --split-room-gap: var(--space-2);
  --split-room-top: var(--space-3);
  --split-room-bottom: var(--space-8);

  display: flex;
  flex: 1 1 auto;
  align-items: stretch;
  gap: var(--space-4);
  min-height: 0;
}

.console-split__list,
.console-split__detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  box-sizing: border-box;
  overflow-y: auto;
  padding-top: var(--split-room-top);
  padding-bottom: var(--split-room-bottom);
  margin-top: calc(-1 * var(--split-room-top));
  margin-bottom: calc(-1 * var(--split-room-bottom));
}

.console-split__list {
  flex: 0 0 auto;
  padding-right: var(--split-room-gap);
  padding-left: var(--split-room-side);
  margin-right: calc(-1 * var(--split-room-gap));
  margin-left: calc(-1 * var(--split-room-side));
}

.console-split__list--alone {
  flex: 1 1 auto;
  padding-right: var(--split-room-side);
  margin-right: calc(-1 * var(--split-room-side));
}

.console-split__detail {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: var(--split-room-side);
  padding-left: var(--split-room-gap);
  margin-right: calc(-1 * var(--split-room-side));
  margin-left: calc(-1 * var(--split-room-gap));
}

.console-split__detail--alone {
  padding-left: var(--split-room-side);
  margin-left: calc(-1 * var(--split-room-side));
}
</style>
