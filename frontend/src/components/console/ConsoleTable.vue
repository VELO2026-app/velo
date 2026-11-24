<!--
  VELO Frontend -- ConsoleTable (FE-262)

  The data table of the web console: a header row, then one row per item.
  A column is a key, a header label, an optional fixed width and alignment,
  and may be `secondary`: below 1200 px (where the menu folds to icons) a
  secondary column is hidden, header and cells, so a tablet keeps the columns
  that identify a row; a cell shows `row[key]` as text unless the screen fills it through the
  `cell-<key>` slot. With `clickable` a row is a focusable control that
  emits `row-click` (mouse, or Enter / Space on the focused row); `selected`
  marks the row whose detail is open next to the table.

  Slots: `cell-<key>` ({ row }), `empty` (no rows).
-->

<template>
  <div class="console-table" role="table" :aria-label="label">
    <div class="console-table__row console-table__row--head" role="row">
      <div
        v-for="col in columns"
        :key="col.key"
        class="console-table__cell"
        :class="cellClass(col)"
        :style="cellStyle(col)"
        role="columnheader"
      >
        {{ col.label }}
      </div>
    </div>
    <div
      v-for="row in rows"
      :key="String(row[key])"
      class="console-table__row"
      :class="{
        'console-table__row--clickable': clickable,
        'console-table__row--selected': selected !== undefined && row[key] === selected,
      }"
      role="row"
      :tabindex="clickable ? 0 : undefined"
      data-testid="console-table-row"
      @click="clickable && emit('row-click', row)"
      @keydown.enter.space.prevent="clickable && emit('row-click', row)"
    >
      <div
        v-for="col in columns"
        :key="col.key"
        class="console-table__cell"
        :class="cellClass(col)"
        :style="cellStyle(col)"
        role="cell"
      >
        <slot :name="`cell-${col.key}`" :row="row">{{ row[col.key] ?? '' }}</slot>
      </div>
    </div>
    <div v-if="rows.length === 0" class="console-table__empty">
      <slot name="empty" />
    </div>
  </div>
</template>

<script setup lang="ts" generic="Row extends Record<string, unknown>">
import { computed } from 'vue'

/** One table column. */
export interface ConsoleTableColumn {
  /** The row field the column shows (and the `cell-<key>` slot name). */
  key: string
  /** Header label. */
  label: string
  /** Fixed width in px; none -- the column takes the free space. */
  width?: number
  /** Cell alignment (numbers and money: end). */
  align?: 'start' | 'end'
  /** Hidden below 1200 px: a column a row can be told apart without. */
  secondary?: boolean
}

const props = defineProps<{
  /** Columns, left to right. */
  columns: readonly ConsoleTableColumn[]
  /** Items, one per row. */
  rows: readonly Row[]
  /** The field that identifies a row (default `id`). */
  rowKey?: string | undefined
  /** The rowKey value of the selected row. */
  selected?: unknown
  /** Accessible name of the table. */
  label?: string | undefined
  /** Rows are controls that emit row-click. */
  clickable?: boolean
}>()

const key = computed(() => props.rowKey ?? 'id')

const emit = defineEmits<{
  'row-click': [row: Row]
}>()

function cellClass(col: ConsoleTableColumn): string[] {
  return [
    `console-table__cell--${col.align ?? 'start'}`,
    ...(col.secondary ? ['console-table__cell--secondary'] : []),
  ]
}

function cellStyle(col: ConsoleTableColumn): Record<string, string> | undefined {
  return col.width === undefined ? undefined : { flex: `0 0 ${col.width}px` }
}
</script>

<style scoped>
.console-table {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.console-table__row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-height: 56px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--velo-border-light);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
}

.console-table__row:last-of-type {
  border-bottom: 0;
}

.console-table__row--head {
  min-height: 36px;
  border-bottom: 0;
  border-radius: var(--velo-radius-10);
  background: var(--velo-bg-subtle);
  font-size: var(--velo-fs-12);
  color: var(--velo-text-primary);
}

.console-table__row--clickable {
  cursor: pointer;
}

.console-table__row--clickable:hover,
.console-table__row--selected {
  border-radius: var(--velo-radius-10);
  background: var(--velo-bg-subtle);
}

.console-table__row--clickable:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: -2px;
}

.console-table__cell {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.console-table__cell--end {
  justify-content: flex-end;
  text-align: right;
}

/* The breakpoint where the menu folds to icons (ConsoleSidebar.vue). */
@media (max-width: 1199px) {
  .console-table__cell--secondary {
    display: none;
  }
}

.console-table__empty {
  padding: var(--space-5) var(--space-4);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-muted);
}
</style>
