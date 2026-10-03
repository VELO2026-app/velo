<!--
  VELO Frontend -- WaitlistConfirmView: «Освободилось место» (Links, 3 October)

  Route: /user/waitlist/:id (waitlist-confirm). Reached from the
  waitlist.spot_available notification -- the bell row and the Telegram
  button (confirm_waitlist__<waitlist_id>). Before this screen nothing on the
  front could confirm a freed spot.

  The entry comes from GET /waitlist/me (found by id) -- the practice and the
  deadline «до». «Подтвердить место» -> POST /waitlist/{id}/confirm -> the
  practice page. Every other state says what it is, with a way to the
  practice:
    notified, deadline ahead -> the confirm button
    notified, deadline passed -> «Срок подтверждения истёк» (the server
                                 expires it lazily, on the next confirm)
    expired   -> «Срок подтверждения истёк»
    converted -> «Место уже подтверждено»
    waiting   -> «Вы в очереди»
    not found -> «Запись не найдена» (no practice to link: back to the app)
  A 400 on confirm does not say which case it was (expired / spot taken /
  not notified) -- the screen re-reads the entry and shows its state; a 404
  is «not found»; anything else is the error toast, the button stays.
-->

<template>
  <div class="waitlist-confirm">
    <VHeader title="Место в практике" show-back @back="goBack" />

    <div v-if="loading" class="waitlist-confirm__state" role="status"><VLoader /></div>

    <VEmptyState
      v-else-if="!entry"
      icon="warning"
      title="Запись не найдена"
      description="Возможно, место уже подтверждено или запись удалена."
    >
      <template #action>
        <VButton size="sm" @click="goHome">На главную</VButton>
      </template>
    </VEmptyState>

    <template v-else>
      <VCard class="waitlist-confirm__card">
        <h2 class="waitlist-confirm__title">{{ entry.practice.title }}</h2>
        <p class="waitlist-confirm__meta">
          {{ formatFeedDateTime(entry.practice.scheduled_at, entry.practice.timezone) }}
          <template v-if="entry.practice.master_name"> · {{ entry.practice.master_name }}</template>
        </p>
      </VCard>

      <div v-if="state === 'open'" class="waitlist-confirm__body">
        <p class="waitlist-confirm__lead">
          Освободилось место. Подтвердите участие до
          <b>{{ formatFeedDateTime(entry.expires_at!, entry.practice.timezone) }}</b
          >.
        </p>
        <VButton block :loading="confirming" @click="onConfirm">Подтвердить место</VButton>
      </div>

      <div v-else class="waitlist-confirm__body">
        <p class="waitlist-confirm__lead" data-state>{{ STATE_TEXT[state] }}</p>
        <VButton block variant="secondary" @click="openPractice">Открыть практику</VButton>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { confirmWaitlist, getMyWaitlist } from '@/api/waitlist'
import { ApiResponseError } from '@/api/client'
import type { WaitlistWithPracticeResponse } from '@/api/types'
import { VButton, VCard, VEmptyState, VLoader } from '@/components/ui'
import { VHeader } from '@/components/layout'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { formatFeedDateTime } from '@/utils/format'

type State = 'open' | 'expired' | 'converted' | 'waiting' | 'gone'

const STATE_TEXT: Record<Exclude<State, 'open'>, string> = {
  expired: 'Срок подтверждения истёк — место предложено следующему в очереди.',
  converted: 'Место уже подтверждено — вы записаны на практику.',
  waiting: 'Вы в очереди — место пока не освободилось или его уже заняли.',
  gone: 'Запись больше недоступна.',
}

const route = useRoute()
const router = useRouter()
const toast = useToast()
const waitlistId = computed(() => String(route.params.id))

const entry = ref<WaitlistWithPracticeResponse | null>(null)
const loading = ref(true)
const confirming = ref(false)

const state = computed((): State => {
  const e = entry.value
  if (!e) return 'gone'
  switch (e.status) {
    case 'notified':
      return e.expires_at && new Date(e.expires_at).getTime() > Date.now() ? 'open' : 'expired'
    case 'expired':
      return 'expired'
    case 'converted':
      return 'converted'
    case 'waiting':
      return 'waiting'
    default:
      return 'gone'
  }
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const page = await getMyWaitlist({ limit: 100 })
    entry.value = page.items.find((item) => item.id === waitlistId.value) ?? null
  } catch (e) {
    entry.value = null
    toast.error(extractApiError(e, 'Не удалось загрузить запись'))
  } finally {
    loading.value = false
  }
}

async function onConfirm(): Promise<void> {
  if (confirming.value || !entry.value) return
  confirming.value = true
  try {
    await confirmWaitlist(waitlistId.value)
    toast.success('Место подтверждено')
    openPractice()
  } catch (e) {
    if (e instanceof ApiResponseError && e.status === 400) {
      await load() // expired / spot taken / not notified -- the entry tells
      return
    }
    if (e instanceof ApiResponseError && e.status === 404) {
      entry.value = null
      return
    }
    toast.error(extractApiError(e, 'Не удалось подтвердить место'))
  } finally {
    confirming.value = false
  }
}

function openPractice(): void {
  if (!entry.value) return
  void router.push({ name: 'practice-detail', params: { id: entry.value.practice_id } })
}

function goHome(): void {
  void router.push({ name: 'user-dashboard' })
}

function goBack(): void {
  router.back()
}

onMounted(load)
</script>

<style scoped>
.waitlist-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
}
.waitlist-confirm__state {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}
.waitlist-confirm__title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-lg);
}
.waitlist-confirm__meta {
  margin: 0;
  color: var(--velo-text-secondary);
}
.waitlist-confirm__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.waitlist-confirm__lead {
  margin: 0;
}
</style>
