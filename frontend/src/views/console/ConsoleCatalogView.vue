<!--
  VELO Frontend -- ConsoleCatalogView (FE-262, slice 3)

  The catalog module of the web console: the method taxonomy as a master-
  detail. Directions in a list on the left (with the count of their styles,
  hidden ones marked), the open direction on the right: name, order, a
  visibility switch and its styles (create, rename, reorder, hide). Below
  1200 px (the menu is folded, the content is a tablet's) the list becomes a
  row of pills above the open direction instead of a column beside it.

  Data: `GET /admin/taxonomy` (inactive items included), one Colada entry
  (composables/queries/admin.ts). Every write goes through the catalog
  mutations, which refetch it and refresh the taxonomy the rest of the app
  reads (the practice forms, the method pickers). Nothing is deleted: the API
  has no delete, a direction or a style is hidden instead. The API has no
  icon, description or per-style usage counts: the screen shows what the
  answer carries.
-->

<template>
  <ConsolePage
    :title="t('console.catalog.title')"
    :crumbs="t('console.groups.content')"
    :fill="!narrow"
    testid="console-catalog"
  >
    <ConsoleLoading v-if="loading" data-testid="catalog-loading" />
    <VEmptyState
      v-else-if="failed"
      icon="warning"
      :title="t('console.catalog.loadFailed')"
      :description="t('common.checkConnection')"
    >
      <VButton size="sm" variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
    </VEmptyState>

    <div v-else-if="narrow" class="console-catalog__stack" data-testid="catalog-stacked">
      <CatalogDirectionList
        compact
        :directions="directions"
        :selected-id="selected?.id"
        @select="selectedId = $event"
      />
      <CatalogDirectionPanel v-if="selected" :key="selected.id" :direction="selected" />
    </div>

    <ConsoleSplit v-else :list-width="medium ? 300 : 400">
      <template #list>
        <CatalogDirectionList
          :directions="directions"
          :selected-id="selected?.id"
          @select="selectedId = $event"
        />
      </template>
      <template #detail>
        <CatalogDirectionPanel v-if="selected" :key="selected.id" :direction="selected" />
      </template>
    </ConsoleSplit>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useQuery } from '@pinia/colada'
import { VButton, VEmptyState } from '@/components/ui'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleSplit from '@/components/console/ConsoleSplit.vue'
import CatalogDirectionList from '@/components/console/content/CatalogDirectionList.vue'
import CatalogDirectionPanel from '@/components/console/content/CatalogDirectionPanel.vue'
import ConsoleLoading from '@/components/console/ConsoleLoading.vue'
import { useConsoleWidth } from '@/composables/useConsoleWidth'
import { adminTaxonomyQuery, onFailedRequest } from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const { narrow, medium } = useConsoleWidth()

const catalog = useQuery(adminTaxonomyQuery)
const directions = computed(() => catalog.data.value ?? [])
const { loading, failed } = screenQueryState(catalog)

// A failed refetch over a catalog shown (after a write, a return to the app)
// is told: the tree may lack what was just written.
onFailedRequest(catalog, () => {
  if (catalog.data.value !== undefined) toast.error(t('console.catalog.loadFailed'))
})

function retry(): void {
  void catalog.refetch()
}

// The open direction: the one picked, else the first (also after the picked
// one is gone from the answer).
const selectedId = ref<string | null>(null)
const selected = computed(
  () => directions.value.find((d) => d.id === selectedId.value) ?? directions.value[0],
)
</script>

<style scoped>
.console-catalog__stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
