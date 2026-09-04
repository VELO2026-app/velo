<!--
  VELO Frontend -- CuratorGroupTransferBanner (schools FE-21 / GT P3)

  The one banner with two faces, keyed off the viewer's relation:
    - CURATOR: «Предложение отправлено <имя>» + «Отменить». The name comes
      from the transfer ref's to_display_name (the users/helpers display_name
      rule -- always yields something, never the master-profile null).
    - ADDRESSEE (a master with a non-null transfer): «Вам предлагают стать
      куратором» + «Принять» / «Отклонить». Accept returns the page AS THE
      NEW CURATOR -- emitted up so the page can replace its state wholesale.
    - Everyone else (students, masters without an offer): renders nothing.
      The backend fills `transfer` for exactly two people, and this banner
      respects that boundary rather than guessing.

  Notifications do not exist in v1 -- this banner IS how the addressee
  learns about the offer (owner-ruled).
-->

<template>
  <div v-if="visible" class="cgt" :class="{ 'cgt--received': isAddressee }">
    <p class="cgt__text">{{ text }}</p>
    <div class="cgt__actions">
      <template v-if="isAddressee">
        <VButton variant="primary" size="sm" :loading="busy" @click="onAccept">Принять</VButton>
        <VButton variant="outline" size="sm" :disabled="busy" @click="onDecline">Отклонить</VButton>
      </template>
      <template v-else>
        <VButton variant="outline" size="sm" :loading="busy" @click="onCancel">Отменить</VButton>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  acceptCuratorGroupTransfer,
  cancelCuratorGroupTransfer,
  declineCuratorGroupTransfer,
} from '@/api/curatorGroups'
import type { CuratorGroupPageResponse, CuratorGroupTransferRef } from '@/api/types'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import VButton from '@/components/ui/VButton.vue'

const props = defineProps<{
  /** The server-filled offer (curator's own view or the addressee's). */
  transfer: CuratorGroupTransferRef | null | undefined
  /** The curator's local echo right after offering, ahead of any reload. */
  pending: CuratorGroupTransferRef | null
  relation: 'curator' | 'master' | 'student' | null
  groupId: string
}>()

const emit = defineEmits<{
  cancelled: []
  accepted: [page: CuratorGroupPageResponse]
  declined: []
}>()

const toast = useToast()
const busy = ref(false)

/** The curator's just-made offer wins over the reloaded one (fresher). */
const effective = computed(() => props.pending ?? props.transfer ?? null)

const isCurator = computed(() => props.relation === 'curator')
const isAddressee = computed(() => props.relation === 'master' && !!props.transfer)

const visible = computed(() => (isCurator.value && !!effective.value) || isAddressee.value)

const text = computed(() => {
  if (isCurator.value && effective.value) {
    return `Предложение передать школу отправлено: ${effective.value.to_display_name}. Пока оно не принято, его можно отменить.`
  }
  if (isAddressee.value) {
    return 'Вам предлагают стать куратором этой школы. Приняв предложение, вы станете её владельцем.'
  }
  return ''
})

async function onCancel(): Promise<void> {
  busy.value = true
  try {
    await cancelCuratorGroupTransfer(props.groupId)
    toast.success('Предложение отменено')
    emit('cancelled')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отменить предложение'))
  } finally {
    busy.value = false
  }
}

async function onAccept(): Promise<void> {
  busy.value = true
  try {
    // The response IS the page as the new curator sees it -- hand it up so
    // the page flips into curator mode without a reload.
    const page = await acceptCuratorGroupTransfer(props.groupId)
    emit('accepted', page)
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось принять школу'))
  } finally {
    busy.value = false
  }
}

async function onDecline(): Promise<void> {
  busy.value = true
  try {
    await declineCuratorGroupTransfer(props.groupId)
    toast.success('Предложение отклонено')
    emit('declined')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отклонить предложение'))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.cgt {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-glass-blue-15);
}

/* The received offer asks for a decision -- peach attention tone, the same
   pair of tokens the transfer chip on the list rows uses. */
.cgt--received {
  background: var(--velo-glass-peach-40);
}

.cgt__text {
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  line-height: 1.5;
  margin: 0;
}

.cgt__actions {
  display: flex;
  gap: var(--space-2);
}
</style>
