<!--
  VELO Frontend -- MasterGroupCreateView (Master GROUPS P2, ПРОМТ №591)

  "Новая группа" -- a single «Название» field, POST /masters/me/groups,
  back to the list on success. 409 (duplicate name for this master) surfaces
  as an inline VInput error + a toast (mirrors MasterNewPromocodeView's
  create-form pattern: extractApiError + toast.error).
-->

<template>
  <div class="new-group">
    <VHeader title="Новая группа" show-back @back="router.back()" />

    <div class="new-group__content">
      <VInput
        v-model="name"
        label="Название"
        placeholder="Название группы"
        :error="fieldError"
        @focus="onFieldFocus"
      />

      <VButton
        variant="primary"
        block
        class="new-group__submit"
        :loading="creating"
        @click="onCreate"
      >
        Создать группу
      </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VInput, VButton } from '@/components/ui'
import { createGroup } from '@/api/groups'
import { useToast } from '@/composables/useToast'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()
const toast = useToast()
const { onFieldFocus } = useKeyboardFieldScroll()

const name = ref('')
const creating = ref(false)
const fieldError = ref('')

async function onCreate(): Promise<void> {
  if (creating.value) return
  if (!name.value.trim()) {
    toast.error('Введите название группы')
    return
  }
  creating.value = true
  fieldError.value = ''
  try {
    await createGroup(name.value.trim())
    toast.success('Группа создана')
    router.push({ name: 'master-groups' })
  } catch (e) {
    const message = extractApiError(e, 'Не удалось создать группу')
    fieldError.value = message
    toast.error(message)
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.new-group {
  display: flex;
  flex-direction: column;
}

.new-group__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4) 0 var(--space-8);
}

.new-group__submit {
  margin-top: var(--space-4);
}
</style>
