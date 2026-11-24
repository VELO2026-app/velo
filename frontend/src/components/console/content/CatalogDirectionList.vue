<!--
  VELO Frontend -- CatalogDirectionList (FE-262, slice 3)

  The directions of the catalog: a card with a list (name, count of styles,
  a mark on a hidden one), an "Add" button and its one-line form. Picking a
  direction is an event; the screen owns which one is open. A new direction
  is opened right after it is created. `compact` lays the list out as a
  wrapping row of pills, for the narrow screen where the open direction sits
  under this card instead of next to it.

  The component writes through the catalog mutations (every write refetches
  the catalog and refreshes the app's method taxonomy: useTaxonomyMutation).
-->

<template>
  <ConsoleCard
    class="catalog-list"
    :title="t('console.catalog.directions')"
    :note="String(directions.length)"
  >
    <template #header-right>
      <VButton
        v-if="!adding"
        variant="outline"
        size="sm"
        data-testid="direction-add"
        @click="startAdd"
        >{{ t('console.catalog.addDirection') }}</VButton
      >
    </template>

    <ConsoleAddRow
      v-if="adding"
      v-model="newLabel"
      :placeholder="t('console.catalog.newDirectionPlaceholder')"
      :loading="creating"
      testid="direction-add"
      @submit="addDirection"
      @cancel="cancelAdd"
    />

    <ul
      class="catalog-list__list"
      :class="{ 'catalog-list__list--compact': compact }"
      :aria-label="t('console.catalog.directionsLabel')"
    >
      <li v-for="dir in directions" :key="dir.id">
        <button
          type="button"
          class="catalog-list__item"
          :class="{
            'catalog-list__item--active': dir.id === selectedId,
            'catalog-list__item--off': !dir.is_active,
          }"
          :aria-current="dir.id === selectedId ? 'true' : undefined"
          data-testid="direction-item"
          @click="emit('select', dir.id)"
        >
          <span class="catalog-list__name">{{ dir.label }}</span>
          <span v-if="!dir.is_active" class="catalog-list__meta">{{
            t('console.catalog.hidden')
          }}</span>
          <span class="catalog-list__meta">{{
            t('console.catalog.stylesCount', dir.styles?.length ?? 0)
          }}</span>
        </button>
      </li>
    </ul>
    <p v-if="directions.length === 0" class="catalog-list__empty">
      {{ t('console.catalog.empty') }}
    </p>
  </ConsoleCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref } from 'vue'
import { VButton } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsoleAddRow from '@/components/console/content/ConsoleAddRow.vue'
import { nextDisplayOrder } from '@/utils/console/displayOrder'
import { newTaxonomySlug } from '@/utils/console/taxonomySlug'
import { useTaxonomyMutation } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import {
  createTaxonomyDirection,
  type CreateDirectionRequest,
  type TaxonomyDirectionItem,
} from '@/api/taxonomy'

const props = withDefaults(
  defineProps<{
    /** Every direction of the catalog, hidden ones included. */
    directions: readonly TaxonomyDirectionItem[]
    /** The id of the open direction. */
    selectedId?: string | undefined
    /** Pills in a wrapping row instead of a column (the narrow screen). */
    compact?: boolean
  }>(),
  { selectedId: undefined, compact: false },
)

const emit = defineEmits<{
  /** A direction was picked, or created. */
  select: [directionId: string]
}>()

const toast = useToast()

const createDirection = useTaxonomyMutation((body: CreateDirectionRequest) =>
  createTaxonomyDirection(body),
)
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

async function addDirection(): Promise<void> {
  const label = newLabel.value.trim()
  if (label === '' || creating.value) return
  creating.value = true
  try {
    // A new direction goes last (the API's default order, 0, would put it first).
    const created = await createDirection.mutateAsync({
      value: newTaxonomySlug(),
      label,
      display_order: nextDisplayOrder(props.directions.map((d) => d.display_order)),
    })
    emit('select', created.id)
    adding.value = false
    toast.success(t('console.catalog.directionAdded'))
  } catch (e) {
    toast.error(extractApiError(e, t('console.catalog.addDirectionFailed')))
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
/* In a scrolling column (ConsoleSplit) the card keeps its height, the column scrolls. */
.catalog-list {
  flex: 0 0 auto;
}

.catalog-list__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.catalog-list__list--compact {
  flex-flow: row wrap;
  gap: var(--space-2);
}

.catalog-list__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--velo-size-44);
  box-sizing: border-box;
  padding: 0 var(--space-4);
  border: 0;
  border-radius: var(--velo-radius-10);
  background: transparent;
  font-family: inherit;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  text-align: left;
  cursor: pointer;
}

.catalog-list__list--compact .catalog-list__item {
  width: auto;
  border: 1px solid var(--velo-border-light);
  border-radius: var(--radius-full);
  background: var(--velo-bg-card-solid);
}

.catalog-list__item:hover {
  background: var(--velo-bg-subtle);
}

.catalog-list__item:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: -2px;
}

.catalog-list__item--active,
.catalog-list__item--active:hover,
.catalog-list__list--compact .catalog-list__item--active {
  border-color: var(--velo-primary);
  background: var(--velo-primary);
  color: var(--velo-on-accent);
}

.catalog-list__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.catalog-list__meta {
  flex: 0 0 auto;
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

/* A hidden direction: its name is the quieter colour; opacity would mix the
   text with the card and take its contrast. */
.catalog-list__item--off .catalog-list__name {
  color: var(--velo-text-secondary);
}

.catalog-list__item--active .catalog-list__meta,
.catalog-list__item--active .catalog-list__name {
  color: var(--velo-on-accent);
}

.catalog-list__empty {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}
</style>
