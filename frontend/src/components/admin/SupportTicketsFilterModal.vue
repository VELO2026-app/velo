<!--
  VELO Frontend -- SupportTicketsFilterModal (FE-100, delivery B)

  Filter sheet of the «Обращения» list in «Модерация». Same shape as
  ModerationFilterModal (VModal + funnel header + «Выбрать дату» ->
  DatePickerSheet + chip groups; closing the sheet IS applying -- the design
  has no «Применить»), but its own: ModerationFilterModal belongs to «Жалобы»
  and stays as it is (owner ruling 24.10: two channels).

  Every group is SINGLE-select with «Все» -- the backend takes one status and
  one category set per request (supportTicketsFilter.ts). The status group is
  hidden in the «Спам» tab, where the status is fixed.
-->

<template>
  <VModal :open="open" @close="applyAndClose">
    <div class="sfilter">
      <div class="sfilter__header">
        <span class="sfilter__header-icon"><IconFilter :size="20" /></span>
        <h2 class="sfilter__heading">{{ t('filters.title') }}</h2>
      </div>

      <button type="button" class="sfilter__date" @click="showDate = true">
        <span class="sfilter__date-text">{{ dateLabel }}</span>
        <svg class="sfilter__date-chev" viewBox="0 0 9 14" fill="none">
          <path d="M2 2L7 7L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>

      <section class="sfilter__group">
        <h3 class="sfilter__label">{{ t('moderation.category') }}</h3>
        <div class="sfilter__chips">
          <VChip size="md" clickable :active="draft.group === null" @click="draft.group = null">
            {{ t('common.all') }}
          </VChip>
          <VChip
            v-for="g in SUPPORT_CATEGORY_GROUPS"
            :key="g.key"
            size="md"
            clickable
            :active="draft.group === g.key"
            @click="draft.group = g.key"
          >
            {{ supportCategoryGroupLabel(g.key) }}
          </VChip>
        </div>
      </section>

      <section v-if="showStatus" class="sfilter__group">
        <h3 class="sfilter__label">{{ t('moderation.status') }}</h3>
        <div class="sfilter__chips">
          <VChip size="md" clickable :active="draft.status === null" @click="draft.status = null">
            {{ t('common.all') }}
          </VChip>
          <VChip
            v-for="s in SUPPORT_FILTER_STATUSES"
            :key="s"
            size="md"
            clickable
            :active="draft.status === s"
            @click="draft.status = s"
          >
            {{ supportStatusLabel(s) }}
          </VChip>
        </div>
      </section>

      <VButton variant="ghost" block :disabled="!hasActiveFilters" @click="resetFilters">
        {{ t('common.reset') }}
      </VButton>
    </div>
  </VModal>

  <DatePickerSheet
    :open="showDate"
    :model-value="draft.date"
    :title="t('adminScreens.adminSupport.appealDate')"
    @update:model-value="draft.date = $event"
    @close="showDate = false"
  />
</template>

<script setup lang="ts">
import { t, getLocale } from '@/locales'
import { computed, reactive, ref, watch } from 'vue'
import { VModal, VChip, VButton } from '@/components/ui'
import { IconFilter } from '@/components/icons'
import DatePickerSheet from '@/components/shared/DatePickerSheet.vue'
import {
  SUPPORT_CATEGORY_GROUPS,
  supportCategoryGroupLabel,
  supportStatusLabel,
} from '@/utils/supportTopics'
import {
  EMPTY_SUPPORT_FILTER,
  SUPPORT_FILTER_STATUSES,
  type SupportTicketsFilter,
} from './supportTicketsFilter'

const props = defineProps<{
  open: boolean
  value: SupportTicketsFilter
  /** False in the «Спам» tab: the status is fixed there. */
  showStatus: boolean
}>()

const emit = defineEmits<{
  apply: [value: SupportTicketsFilter]
  close: []
}>()

const draft = reactive<SupportTicketsFilter>({ ...EMPTY_SUPPORT_FILTER })
const showDate = ref(false)

// Re-seed the draft from the applied value each time the sheet opens.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) Object.assign(draft, props.value)
  },
  { immediate: true },
)

const dateLabel = computed<string>(() =>
  draft.date
    ? new Date(`${draft.date}T12:00:00`).toLocaleDateString(getLocale(), {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : t('composer.pickDate'),
)

const hasActiveFilters = computed<boolean>(
  () => draft.group !== null || draft.status !== null || draft.date !== '',
)

// «Сбросить»: clear every group and STAY open -- closing applies.
function resetFilters(): void {
  Object.assign(draft, EMPTY_SUPPORT_FILTER)
}

function applyAndClose(): void {
  emit('apply', { ...draft })
  emit('close')
}
</script>

<style scoped>
.sfilter {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.sfilter__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.sfilter__header-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
}

.sfilter__heading {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0;
}

.sfilter__date {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: var(--space-2) var(--space-4);
  min-height: var(--velo-size-36);
  border: none;
  background: var(--velo-primary);
  border-radius: var(--radius-full);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-white);
  letter-spacing: 0.02em;
  cursor: pointer;
}

.sfilter__date-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sfilter__date-chev {
  width: 9px;
  height: 14px;
  flex-shrink: 0;
}

.sfilter__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.sfilter__label {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.sfilter__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
