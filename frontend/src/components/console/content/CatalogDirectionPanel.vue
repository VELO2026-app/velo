<!--
  VELO Frontend -- CatalogDirectionPanel (FE-262, slice 3)

  The open direction of the catalog: its name and order in a form with a Save
  button, a visibility switch (a hidden direction is not offered to masters;
  nothing is deleted) and its styles (CatalogStyles). The screen keys this
  component by the direction id, so a new selection starts with fresh drafts.

  The component writes through the catalog mutations (every write refetches
  the catalog and refreshes the app's method taxonomy: useTaxonomyMutation).
-->

<template>
  <ConsoleCard class="catalog-direction" :title="direction.label">
    <template #header-right>
      <label class="catalog-direction__visible">
        <span>{{ t('console.catalog.detail.visible') }}</span>
        <VSwitch
          :model-value="direction.is_active"
          :disabled="toggling"
          :aria-label="t('console.catalog.detail.visible')"
          @update:model-value="setVisible"
        />
      </label>
      <VButton
        size="sm"
        :loading="saving"
        :disabled="!canSave"
        data-testid="direction-save"
        @click="save"
        >{{ t('console.catalog.detail.save') }}</VButton
      >
    </template>

    <div class="catalog-direction__fields">
      <VInput
        v-model="draftLabel"
        class="catalog-direction__name"
        :label="t('console.catalog.detail.name')"
        maxlength="100"
        @keydown.enter.prevent="save"
      />
      <VInput
        v-model="draftOrder"
        class="catalog-direction__order"
        :label="t('console.catalog.detail.order')"
        type="number"
        step="1"
        @keydown.enter.prevent="save"
      />
    </div>

    <CatalogStyles :direction="direction" />

    <p class="catalog-direction__note">{{ t('console.catalog.note') }}</p>
  </ConsoleCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { VButton, VInput, VSwitch } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import CatalogStyles from '@/components/console/content/CatalogStyles.vue'
import { useTaxonomyMutation } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import {
  updateTaxonomyDirection,
  type TaxonomyDirectionItem,
  type UpdateTaxonomyItemRequest,
} from '@/api/taxonomy'

const props = defineProps<{
  /** The direction to show and edit. */
  direction: TaxonomyDirectionItem
}>()

const toast = useToast()

const updateDirection = useTaxonomyMutation(
  ({ id, body }: { id: string; body: UpdateTaxonomyItemRequest }) =>
    updateTaxonomyDirection(id, body),
)

const draftLabel = ref(props.direction.label)
const draftOrder = ref(String(props.direction.display_order))

const label = computed(() => draftLabel.value.trim())
const order = computed(() => Number(draftOrder.value))
const orderValid = computed(() => draftOrder.value.trim() !== '' && Number.isInteger(order.value))
const dirty = computed(
  () => label.value !== props.direction.label || order.value !== props.direction.display_order,
)

const saving = ref(false)
const canSave = computed(
  () => label.value !== '' && orderValid.value && dirty.value && !saving.value,
)

async function save(): Promise<void> {
  if (!canSave.value) return
  // Only what changed goes to the PATCH.
  const body: UpdateTaxonomyItemRequest = {}
  if (label.value !== props.direction.label) body.label = label.value
  if (order.value !== props.direction.display_order) body.display_order = order.value
  saving.value = true
  try {
    await updateDirection.mutateAsync({ id: props.direction.id, body })
    toast.success(t('ui.saved'))
  } catch (e) {
    toast.error(extractApiError(e, t('console.catalog.saveFailed')))
  } finally {
    saving.value = false
  }
}

const toggling = ref(false)

async function setVisible(active: boolean): Promise<void> {
  if (toggling.value) return
  toggling.value = true
  try {
    await updateDirection.mutateAsync({ id: props.direction.id, body: { is_active: active } })
  } catch (e) {
    toast.error(extractApiError(e, t('console.catalog.statusChangeFailed')))
  } finally {
    toggling.value = false
  }
}
</script>

<style scoped>
/* In a scrolling column (ConsoleSplit) the card keeps its height, the column scrolls. */
.catalog-direction {
  flex: 0 0 auto;
}

.catalog-direction__visible {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

.catalog-direction__fields {
  display: flex;
  gap: var(--space-4);
}

/* The kit's field is a white plate with no border (made for the photo
   background): on a white card it gets a light border and a small label. */
.catalog-direction__fields :deep(.v-input__label) {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.catalog-direction__fields :deep(.v-input__field:not(:focus)) {
  border-color: var(--velo-border-light);
  font-size: var(--velo-fs-16);
}

/* VInput keeps its attrs on the inner <input>: the flex rules go on its root. */
.catalog-direction__name {
  flex: 1;
  min-width: 0;
}

.catalog-direction__order {
  flex: 0 0 200px;
}

.catalog-direction__note {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--velo-radius-10);
  background: var(--velo-bg-subtle);
  font-size: var(--velo-fs-12);
  color: var(--velo-text-primary);
}
</style>
