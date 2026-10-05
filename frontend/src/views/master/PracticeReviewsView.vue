<!--
  VELO Frontend -- PracticeReviewsView: «Аналитика по практике» (BE-78)

  Route: /master/analytics/practice/:id (nested under analytics so the
  Аналитика tab stays active). Reached by tapping a practice card in
  AnalyticsView -> «Прошедшие практики».

  One screen for every entitled reader, on the server's data
  (GET /practices/{id}/analytics + /analytics/pairs + /analytics/reviews):
  the leading master; for a school's practice also its curator and its
  verified masters. Anyone else gets 404 (not 403), an entitled reader of a
  practice that is not completed gets 400 -- both shown as the load error.
  A tap on a person (pairs and reviews) follows the reader's role from the
  server (BE-78 (2), personTarget): leader -> student dossier, curator ->
  school student profile (members only), school master -> a direct message.
  «Назад» is router.back(): the screen returns to wherever it was entered
  from (master analytics or the school's analytics).
  The demo mode (ANALYTICS_SIMULATION) and the previous insights/reviews
  screen of this route are gone (owner, BE-78). This view owns the requests
  and the paging; PracticeAnalytics renders.
-->

<template>
  <PracticeAnalytics
    :summary="summary"
    :pairs="pairs"
    :reviews="reviews"
    :loading="loading"
    :error="error"
    :loading-more-pairs="loadingMorePairs"
    :loading-more-reviews="loadingMoreReviews"
    @back="router.back()"
    @retry="load"
    @more-pairs="loadMorePairs"
    @more-reviews="loadMoreReviews"
    @person="openPerson"
  />
  <SendMessageModal :open="msgOpen" :student-id="msgId" :name="msgName" @close="msgOpen = false" />
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  getPracticeAnalytics,
  getPracticeAnalyticsPairs,
  getPracticeAnalyticsReviews,
} from '@/api/practices'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import PracticeAnalytics from '@/components/shared/practice-analytics/PracticeAnalytics.vue'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import {
  personTarget,
  type AnalyticsPerson,
} from '@/components/shared/practice-analytics/analytics'
import type {
  PracticeAnalyticsPair,
  PracticeAnalyticsResponse,
  PracticeAnalyticsReview,
} from '@/api/types'

const PAGE = 20

const route = useRoute()
const router = useRouter()
const toast = useToast()
const practiceId = computed(() => route.params.id as string)

const summary = ref<PracticeAnalyticsResponse | null>(null)
const pairs = ref<PracticeAnalyticsPair[]>([])
const reviews = ref<PracticeAnalyticsReview[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const loadingMorePairs = ref(false)
const loadingMoreReviews = ref(false)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const id = practiceId.value
    const [s, p, r] = await Promise.all([
      getPracticeAnalytics(id),
      getPracticeAnalyticsPairs(id, PAGE, 0),
      getPracticeAnalyticsReviews(id, PAGE, 0),
    ])
    summary.value = s
    pairs.value = p.items
    reviews.value = r.items
  } catch (e) {
    summary.value = null
    error.value = extractApiError(e, 'Попробуйте ещё раз')
  } finally {
    loading.value = false
  }
}

async function loadMorePairs(): Promise<void> {
  if (loadingMorePairs.value) return
  loadingMorePairs.value = true
  try {
    const page = await getPracticeAnalyticsPairs(practiceId.value, PAGE, pairs.value.length)
    pairs.value = [...pairs.value, ...page.items]
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось загрузить ещё'))
  } finally {
    loadingMorePairs.value = false
  }
}

async function loadMoreReviews(): Promise<void> {
  if (loadingMoreReviews.value) return
  loadingMoreReviews.value = true
  try {
    const page = await getPracticeAnalyticsReviews(practiceId.value, PAGE, reviews.value.length)
    reviews.value = [...reviews.value, ...page.items]
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось загрузить ещё'))
  } finally {
    loadingMoreReviews.value = false
  }
}

// BE-78 (2): a tap on a person -- the owner's table lives in personTarget.
const msgOpen = ref(false)
const msgId = ref('')
const msgName = ref('')

function openPerson(person: AnalyticsPerson): void {
  if (!summary.value) return
  const target = personTarget(summary.value, person)
  if (target?.kind === 'route') {
    void router.push(target.to)
  } else if (target?.kind === 'chat') {
    msgId.value = target.studentId
    msgName.value = target.name
    msgOpen.value = true
  }
}

onMounted(load)
</script>
