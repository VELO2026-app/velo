<!--
  VELO Frontend -- AddTagSheet (Master GROUPS P2 ПРОМТ №591, palette wired P3 ПРОМТ №592)

  "Добавить тег" -- a free-text field + the master's existing tags as
  single-select VChips (owner Q1=A: one tag per student, so at most one
  chip is ever active; tapping a chip fills the text field with it).

  Palette (P3): GET /masters/me/tags, fetched by this sheet itself on open
  -- closes the P2 gap (the palette used to be derived client-side from
  whatever page of members the caller happened to have loaded).

  PUT /masters/me/students/{id}/tag on save; null (empty field) clears it.
-->

<template>
  <VBottomSheet
    :open="open"
    title="Добавить тег"
    save-label="Сохранить"
    @save="onSave"
    @close="$emit('close')"
  >
    <p class="add-tag__name">{{ studentName }}</p>

    <VInput v-model="tag" label="Новый тег" placeholder="Введите тег" />

    <template v-if="palette.length">
      <p class="add-tag__label">Существующие теги</p>
      <div class="add-tag__chips">
        <VChip
          v-for="t in palette"
          :key="t"
          size="md"
          clickable
          :active="tag.trim() === t"
          @click="tag = t"
        >
          {{ t }}
        </VChip>
      </div>
    </template>
  </VBottomSheet>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { VBottomSheet, VInput, VChip } from '@/components/ui'
import { setStudentTag, getMyTags } from '@/api/groups'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'

const props = defineProps<{
  open: boolean
  studentId: string
  studentName: string
  currentTag: string | null
}>()

const emit = defineEmits<{ close: []; saved: [] }>()

const toast = useToast()
const tag = ref('')
const palette = ref<string[]>([])

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    tag.value = props.currentTag ?? ''
    try {
      const res = await getMyTags()
      palette.value = res.tags
    } catch {
      // Non-fatal: the free-text field alone still works without a palette.
      palette.value = []
    }
  },
)

async function onSave(): Promise<void> {
  try {
    await setStudentTag(props.studentId, tag.value.trim() || null)
    toast.success('Тег сохранён')
    emit('saved')
    emit('close')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось сохранить тег'))
  }
}
</script>

<style scoped>
.add-tag__name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin: 0 0 var(--space-4);
}

.add-tag__label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: var(--space-4) 0 var(--space-2);
}

.add-tag__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
