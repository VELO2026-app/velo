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
  <ConsoleCard :title="t('console.catalog.directions')" :note="String(directions.length)">
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

    <div v-if="adding" class="catalog-list__add" data-testid="direction-add-row">
      <VInput
        v-model="newLabel"
        :label="t('console.catalog.newDirectionPlaceholder')"
        hide-label
        :placeholder="t('console.catalog.newDirectionPlaceholder')"
        maxlength="100"
        @keydown.enter.prevent="addDirection"
        @keydown.esc="cancelAdd"
      />
      <VButton
        size="sm"
        :loading="creating"
        :disabled="newLabel.trim() === ''"
        data-testid="direction-add-confirm"
        @click="addDirection"
        >{{ t('ui.add') }}</VButton
      >
      <VButton variant="ghost" size="sm" @click="cancelAdd">{{ t('ui.cancel') }}</VButton>
    </div>

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
import { VButton, VInput } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import { newTaxonomySlug } from '@/components/console/content/taxonomySlug'
import { useTaxonomyMutation } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import {
  createTaxonomyDirection,
  type CreateDirectionRequest,
  type TaxonomyDirectionItem,
} from '@/api/taxonomy'

withDefaults(
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
    const created = await createDirection.mutateAsync({ value: newTaxonomySlug(), label })
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
.catalog-list__add {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* VInput keeps its attrs on the inner <input>: the flex rules go on its root. */
.catalog-list__add > .v-input {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
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
  border-radius: var(--radius-full);
  background: var(--velo-bg-subtle);
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
  background: var(--velo-primary);
  color: var(--velo-on-accent);
}

.catalog-list__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.catalog-list__item--off .catalog-list__name {
  opacity: 0.6;
}

.catalog-list__meta {
  flex: 0 0 auto;
  font-size: var(--velo-fs-12);
  opacity: 0.7;
}

.catalog-list__empty {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-muted);
}
</style>
