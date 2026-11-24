<!--
  VELO Frontend -- CatalogStyles (FE-262, slice 3)

  The styles of one catalog direction as a table: name, order, a visibility
  switch and an edit button; an "Add style" button over it opens a one-line
  form. A style is never deleted, only hidden (the API has no delete: masters
  keep the methods they already chose).

  The component writes through the catalog mutations (every write refetches
  the catalog and refreshes the app's method taxonomy: useTaxonomyMutation).
-->

<template>
  <section class="catalog-styles">
    <header class="catalog-styles__head">
      <h3 class="catalog-styles__title">{{ t('console.catalog.styles.title') }}</h3>
      <VButton v-if="!adding" variant="outline" size="sm" @click="startAdd">{{
        t('console.catalog.styles.add')
      }}</VButton>
    </header>

    <ConsoleAddRow
      v-if="adding"
      v-model="newLabel"
      :placeholder="t('console.catalog.styles.newPlaceholder')"
      :loading="creating"
      testid="style-add"
      @submit="addStyle"
      @cancel="cancelAdd"
    />

    <ConsoleTable :columns="columns" :rows="rows" :label="t('console.catalog.styles.label')">
      <template #cell-label="{ row }">
        <VInput
          v-if="editingId === row.id"
          v-model="draftLabel"
          :label="t('console.catalog.styles.name')"
          hide-label
          maxlength="100"
          @keydown.enter.prevent="saveEdit(row)"
          @keydown.esc="cancelEdit"
        />
        <span v-else :class="{ 'catalog-styles__off': !row.is_active }">{{ row.label }}</span>
      </template>
      <template #cell-display_order="{ row }">
        <VInput
          v-if="editingId === row.id"
          v-model="draftOrder"
          :label="t('console.catalog.styles.order')"
          hide-label
          type="number"
          step="1"
          @keydown.enter.prevent="saveEdit(row)"
          @keydown.esc="cancelEdit"
        />
        <template v-else>{{ row.display_order }}</template>
      </template>
      <template #cell-is_active="{ row }">
        <VSwitch
          :model-value="row.is_active"
          :disabled="busyId === row.id"
          :aria-label="`${t('console.catalog.styles.visible')}: ${row.label}`"
          @update:model-value="setVisible(row, $event)"
        />
      </template>
      <template #cell-actions="{ row }">
        <template v-if="editingId === row.id">
          <button
            type="button"
            class="catalog-styles__icon"
            :aria-label="t('ui.save')"
            :disabled="!editValid || busyId === row.id"
            @click="saveEdit(row)"
          >
            <IconCheck :size="18" />
          </button>
          <button
            type="button"
            class="catalog-styles__icon"
            :aria-label="t('ui.cancel')"
            @click="cancelEdit"
          >
            <IconClose :size="18" />
          </button>
        </template>
        <button
          v-else
          type="button"
          class="catalog-styles__icon"
          :aria-label="t('console.catalog.styles.edit', { name: row.label })"
          @click="startEdit(row)"
        >
          <IconPen :size="18" />
        </button>
      </template>
      <template #empty>{{ t('console.catalog.styles.empty') }}</template>
    </ConsoleTable>
  </section>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { VButton, VInput, VSwitch } from '@/components/ui'
import { IconCheck, IconClose, IconPen } from '@/components/icons'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import ConsoleAddRow from '@/components/console/content/ConsoleAddRow.vue'
import { isWholeNumber, nextDisplayOrder } from '@/utils/console/displayOrder'
import { newTaxonomySlug } from '@/utils/console/taxonomySlug'
import { useTaxonomyMutation } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import {
  createTaxonomyStyle,
  updateTaxonomyStyle,
  type CreateStyleRequest,
  type TaxonomyDirectionItem,
  type UpdateTaxonomyItemRequest,
} from '@/api/taxonomy'

const props = defineProps<{
  /** The direction whose styles are shown. */
  direction: TaxonomyDirectionItem
}>()

const toast = useToast()

const createStyle = useTaxonomyMutation(
  ({ directionId, body }: { directionId: string; body: CreateStyleRequest }) =>
    createTaxonomyStyle(directionId, body),
)
const updateStyle = useTaxonomyMutation(
  ({ id, body }: { id: string; body: UpdateTaxonomyItemRequest }) => updateTaxonomyStyle(id, body),
)

// Spread: ConsoleTable rows are plain records, the API items are interfaces.
const rows = computed(() => (props.direction.styles ?? []).map((style) => ({ ...style })))
type StyleRow = (typeof rows.value)[number]

const columns = computed<ConsoleTableColumn[]>(() => [
  { key: 'label', label: t('console.catalog.styles.name') },
  { key: 'display_order', label: t('console.catalog.styles.order'), width: 110, align: 'end' },
  { key: 'is_active', label: t('console.catalog.styles.visible'), width: 90 },
  { key: 'actions', label: t('console.catalog.styles.actions'), width: 90, align: 'end' },
])

// -- Add -------------------------------------------------------------------
const adding = ref(false)
const newLabel = ref('')
const creating = ref(false)

function startAdd(): void {
  newLabel.value = ''
  adding.value = true
}
function cancelAdd(): void {
  adding.value = false
}

async function addStyle(): Promise<void> {
  const label = newLabel.value.trim()
  if (label === '' || creating.value) return
  creating.value = true
  try {
    await createStyle.mutateAsync({
      directionId: props.direction.id,
      // A new style goes last (the API's default order, 0, would put it first).
      body: {
        value: newTaxonomySlug(),
        label,
        display_order: nextDisplayOrder(rows.value.map((r) => r.display_order)),
      },
    })
    adding.value = false
    toast.success(t('console.catalog.styles.added'))
  } catch (e) {
    toast.error(extractApiError(e, t('console.catalog.styles.addFailed')))
  } finally {
    creating.value = false
  }
}

// -- Edit (name and order) -------------------------------------------------
const editingId = ref<string | null>(null)
const draftLabel = ref('')
const draftOrder = ref('')
// One write at a time per style: a switch and an edit of a row never overlap.
const busyId = ref<string | null>(null)

const editValid = computed(() => draftLabel.value.trim() !== '' && isWholeNumber(draftOrder.value))

function startEdit(row: StyleRow): void {
  editingId.value = row.id
  draftLabel.value = row.label
  draftOrder.value = String(row.display_order)
}
function cancelEdit(): void {
  editingId.value = null
}

async function saveEdit(row: StyleRow): Promise<void> {
  if (!editValid.value || busyId.value !== null) return
  const label = draftLabel.value.trim()
  const order = Number(draftOrder.value)
  // Only what changed goes to the PATCH; nothing changed -- nothing is sent.
  const body: UpdateTaxonomyItemRequest = {}
  if (label !== row.label) body.label = label
  if (order !== row.display_order) body.display_order = order
  if (Object.keys(body).length === 0) {
    editingId.value = null
    return
  }
  busyId.value = row.id
  try {
    await updateStyle.mutateAsync({ id: row.id, body })
    editingId.value = null
    toast.success(t('ui.saved'))
  } catch (e) {
    toast.error(extractApiError(e, t('console.catalog.saveFailed')))
  } finally {
    busyId.value = null
  }
}

// -- Visibility ------------------------------------------------------------
async function setVisible(row: StyleRow, active: boolean): Promise<void> {
  if (busyId.value !== null) return
  busyId.value = row.id
  try {
    await updateStyle.mutateAsync({ id: row.id, body: { is_active: active } })
  } catch (e) {
    toast.error(extractApiError(e, t('console.catalog.statusChangeFailed')))
  } finally {
    busyId.value = null
  }
}
</script>

<style scoped>
.catalog-styles {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.catalog-styles__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.catalog-styles__title {
  margin: 0;
  font-size: var(--velo-fs-18);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.catalog-styles :deep(.console-table__cell > .v-input) {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
}

.catalog-styles__off {
  color: var(--velo-text-secondary);
}

.catalog-styles__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-36);
  height: var(--velo-size-36);
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--velo-primary);
  cursor: pointer;
}

.catalog-styles__icon:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.catalog-styles__icon:disabled {
  opacity: 0.4;
  cursor: default;
}

.catalog-styles__icon:hover:not(:disabled) {
  background: var(--velo-bg-subtle);
}
</style>
