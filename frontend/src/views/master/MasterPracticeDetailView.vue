<!--
  VELO Frontend -- MasterPracticeDetailView (Phase-3 Master DS)

  Master's practice detail at /master/practices/:id/detail (masterStatusGuard;
  rendered inside MasterShell, no tab bar). Reached by tapping a practice card in
  MasterPracticesView (both tabs). Р1=А: ONE route, status-branched.

    - PAST branch (completed / cancelled): read-only review — hero + attendance
      stats + participant reviews + finance + Check-ins / Посещаемость CTAs.
    - UPCOMING branch (draft / scheduled / live) = WI-B hub: PracticeHeroCard +
      Записалось/Мест/Цена stat cards + «Записались» roster (read-only rows) +
      description/contraindications accordions + Check-ins,
      with a «…» menu (Изменить / отменить|удалить). Replaces the former redirect
      to the edit screen. EditPracticeView is untouched (reached via «…» → Изменить).
      NB: there is deliberately NO «Начать практику» button. Going live is
      AUTOMATIC (backend lifecycle worker flips scheduled -> live at scheduled_at,
      and -> completed at scheduled_at + duration). PATCH status='live' is rejected
      by the backend (422), so never wire such a button here.

  Decisions (operator, WI-B, all Г=А):
    FORK1 — REMOVED (ПРОМТ post-№280): the per-participant «отменить запись» X was a
            stub (no master-removes-participant endpoint — cancelBooking is self-only)
            so the operator asked to drop it entirely until the backend exists. The
            roster rows are now read-only. Re-add the X when the remove-participant
            endpoint ships (E11, master-ds-zod-roadmap). FORK2 — the recurrence-days
            hero line is HIDDEN (no recurrence model). FORK3 — NO «Опубликовать» on the hub
            (draft→scheduled stays in EditPracticeView). FORK4 — the hub hero
            reuses the shared PracticeHeroCard.

  Data reality:
    REAL: header (getPractice) · Записалось/Мест/Цена + roster (getAttendance) ·
          отменить (cancelPractice) · удалить draft (deletePractice). PAST rating
          badges + stats as before (getAttendance + anonymous insights).
          Status transitions scheduled -> live -> completed are NOT driven from
          here -- the backend lifecycle worker does them by the clock, so the PAST
          branch starts rendering on its own once the practice's duration elapses.
    STUB → Zod: remove-one-participant (no endpoint) → the X was REMOVED (not faked);
          «Доход» (no income/ledger API) → «—»; «Отзывы участников» (insights anonymous).
-->

<template>
  <div class="practice-detail">
    <VHeader :title="headerTitle" show-back @back="router.back()">
      <template v-if="isUpcoming" #action>
        <VMenu aria-label="Меню">
          <template #default="{ close }">
            <!-- Карандаш → редактирование, корзина → удаление/отмена (Q1=А,
                 openDestructive контекстный: черновик удаляет, запланированную
                 отменяет, с подтверждением). -->
            <VMenuItem
              :icon="IconEdit"
              ariaLabel="Редактировать"
              @click="
                () => {
                  goEdit()
                  close()
                }
              "
            />
            <VMenuItem
              :icon="IconTrash"
              danger
              :ariaLabel="destructiveLabel"
              @click="
                () => {
                  openDestructive()
                  close()
                }
              "
            />
          </template>
        </VMenu>
      </template>
    </VHeader>

    <!-- Loading -->
    <div v-if="loading" class="practice-detail__loader">
      <VLoader size="lg" />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="practice-detail__content">
      <VEmptyState icon="warning" title="Не удалось загрузить практику" :description="error">
        <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
      </VEmptyState>
    </div>

    <template v-else-if="practice">
      <!-- ===================== UPCOMING hub (WI-B) ===================== -->
      <div v-if="isUpcoming" class="practice-detail__content">
        <!-- Hero (shared PracticeHeroCard — FORK4). Recurrence-days line is
             intentionally NOT shown (FORK2: no recurrence model). -->
        <PracticeHeroCard
          :title="practice.title"
          :date="whenLabel"
          :duration="durationLabel"
          :recurrence="recurrenceLabel"
          :direction="practice.direction"
          :difficulty-dots="difficultyDots"
          :difficulty-label="difficultyLabel"
        />

        <!-- Записалось / Мест (карточка «Цена» убрана — operator 2026-06-18) -->
        <div class="practice-detail__stats">
          <VStatCard :value="enrolledStat" label="Записалось" />
          <VStatCard :value="capacityStat" label="Мест" />
        </div>

        <!-- Записались (roster; первые 5 + раскрытие — operator 2026-06-18) -->
        <section v-if="rosterItems.length > 0" class="practice-detail__section">
          <h2 class="velo-section-title">Записались</h2>
          <div v-for="item in visibleRoster" :key="item.booking_id" class="pd-prow">
            <span class="pd-prow__ava">
              <img
                v-if="item.user_avatar_url && !brokenAvatars.has(item.booking_id)"
                :src="item.user_avatar_url"
                alt=""
                class="pd-prow__ava-img"
                @error="brokenAvatars.add(item.booking_id)"
              />
              <template v-else>{{ initials(item) }}</template>
            </span>
            <span class="pd-prow__name">{{ displayName(item) }}</span>
          </div>
          <VShowMore
            v-if="!rosterExpanded && hiddenRosterCount > 0"
            :count="hiddenRosterCount"
            noun="участников"
            @click="rosterExpanded = true"
          />
        </section>

        <!-- Описание / Противопоказания / Что подготовить — отдельные карточки
             (separate cards, bold headers, big chevron — ПРОМТ №158). -->
        <section
          v-if="practice.description || practice.contraindications || practice.what_to_prepare"
          class="practice-detail__section"
        >
          <div v-if="practice.description" class="pd-acc" :class="{ 'pd-acc--open': descOpen }">
            <button
              class="pd-acc__hd"
              :aria-expanded="descOpen"
              :aria-label="descOpen ? 'Свернуть' : 'Развернуть'"
              @click="descOpen = !descOpen"
            >
              <span class="pd-acc__title">Описание</span>
              <svg
                class="pd-acc__chev"
                viewBox="0 0 24 24"
                width="22"
                height="22"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div v-if="descOpen" class="pd-acc__body">{{ practice.description }}</div>
          </div>

          <div
            v-if="practice.contraindications"
            class="pd-acc"
            :class="{ 'pd-acc--open': contraOpen }"
          >
            <button
              class="pd-acc__hd"
              :aria-expanded="contraOpen"
              :aria-label="contraOpen ? 'Свернуть' : 'Развернуть'"
              @click="contraOpen = !contraOpen"
            >
              <span class="pd-acc__title">Противопоказания</span>
              <svg
                class="pd-acc__chev"
                viewBox="0 0 24 24"
                width="22"
                height="22"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div v-if="contraOpen" class="pd-acc__body">{{ practice.contraindications }}</div>
          </div>

          <div v-if="practice.what_to_prepare" class="pd-acc" :class="{ 'pd-acc--open': prepOpen }">
            <button
              class="pd-acc__hd"
              :aria-expanded="prepOpen"
              :aria-label="prepOpen ? 'Свернуть' : 'Развернуть'"
              @click="prepOpen = !prepOpen"
            >
              <span class="pd-acc__title">Что подготовить</span>
              <svg
                class="pd-acc__chev"
                viewBox="0 0 24 24"
                width="22"
                height="22"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div v-if="prepOpen" class="pd-acc__body">{{ practice.what_to_prepare }}</div>
          </div>
        </section>

        <!-- Нижние кнопки убраны (operator 2026-06-18): запуск — авто по
             расписанию (Зод), check-in живёт на дашборде ≤24ч. -->
      </div>

      <!-- ===================== PAST detail (read-only) ===================== -->
      <div v-else class="practice-detail__content practice-detail__content--past">
        <!-- Hero (shared PracticeHeroCard; titleSize base canon, icon-46;
             rating-distribution badges via the additive #extra slot) -->
        <PracticeHeroCard
          :title="practice.title"
          title-size="base"
          :date="whenLabel"
          :duration="durationLabel"
          :direction="practice.direction"
        >
          <template v-if="hasRating" #extra>
            <VRatingBadges
              size="lg"
              :fire="ratingPct('fire')"
              :good="ratingPct('good')"
              :confused="ratingPct('confused')"
            />
          </template>
        </PracticeHeroCard>

        <!-- Stats -->
        <div class="practice-detail__stats">
          <VStatCard :value="attendedValue" label="Присутствовало" value-tone="teal" />
          <VStatCard :value="noShowValue" label="Не пришли" value-tone="rose" />
        </div>

        <!-- Отзывы участников (E1 named reviews — getPracticeReviews) -->
        <section class="practice-detail__section">
          <h2 class="velo-section-title">Отзывы участников</h2>
          <div v-if="reviewsLoading && reviews.length === 0" class="practice-detail__rloader">
            <VLoader />
          </div>
          <template v-else-if="reviews.length > 0">
            <div v-for="(r, i) in visibleReviews" :key="i" class="practice-detail__review">
              <div class="practice-detail__review-top">
                <span
                  class="practice-detail__review-ic"
                  :style="{ color: RATING_ICON_COLOR[r.rating] }"
                >
                  <component :is="RATING_ICON[r.rating]" :size="28" />
                </span>
                <span class="practice-detail__review-name">{{ r.reviewer_name }}</span>
              </div>
              <div v-if="r.comment" class="practice-detail__review-quote">«{{ r.comment }}»</div>
            </div>
            <!-- Первые 10 + раскрытие «посмотреть еще» (operator ПРОМТ №160). -->
            <VShowMore
              v-if="!reviewsExpanded && hiddenReviewsCount > 0"
              label="посмотреть еще"
              @click="expandReviews"
            />
            <div v-else-if="reviewsExpanded && hasMoreReviews" class="practice-detail__more">
              <VButton variant="ghost" @click="loadMoreReviews">Показать ещё</VButton>
            </div>
          </template>
          <VEmptyState v-else variant="note" title="Отзывов пока нет" />
        </section>

        <!-- CTAs -->
        <div class="practice-detail__actions">
          <VButton variant="primary" block @click="goCheckins">Check-ins</VButton>
          <VButton variant="outline" block @click="goRoster">Посещаемость</VButton>
        </div>
      </div>
    </template>

    <!-- Cancel the whole practice (scheduled/live) — reuses CancelPracticeDialog. -->
    <CancelPracticeDialog
      :open="showCancel"
      :practice="practice"
      :loading="cancelling"
      @confirm="doCancel"
      @cancel="showCancel = false"
    />

    <!-- Delete a draft practice. -->
    <VConfirmDialog
      :open="showDelete"
      message="Удалить черновик практики? Это действие необратимо."
      confirm-label="Удалить"
      :loading="deleting"
      @confirm="doDelete"
      @cancel="showDelete = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDiaryStore } from '@/stores/diary'
import { useMasterStore } from '@/stores/master'
import {
  getPractice,
  getAttendance,
  deletePractice,
  cancelPractice,
  getPracticeReviews,
} from '@/api/practices'
import { extractApiError } from '@/composables/useApiError'
import {
  VStatCard,
  VButton,
  VLoader,
  VEmptyState,
  VConfirmDialog,
  VMenu,
  VMenuItem,
  VRatingBadges,
} from '@/components/ui'
import { VHeader } from '@/components/layout'
import PracticeHeroCard from '@/components/shared/PracticeHeroCard.vue'
import VShowMore from '@/components/shared/VShowMore.vue'
import CancelPracticeDialog from '@/components/shared/CancelPracticeDialog.vue'
import { IconEdit } from '@/components/icons'
import { RATING_ICON } from '@/utils/ratingIcons'
// IconTrash is not re-exported from the icons barrel; import the component
// directly (same as EntryView).
import IconTrash from '@/components/icons/IconTrash.vue'
import {
  RATING_ICON_COLOR,
  DIFFICULTY_DOTS,
  DIFFICULTY_LABEL,
  recurrenceDaysLabel,
} from '@/utils/displayHelpers'
import { formatDateShort, formatTime } from '@/utils/format'
import { useToast } from '@/composables/useToast'
import type {
  PracticeResponse,
  AttendanceResponse,
  AttendanceItemResponse,
  PracticeDifficulty,
  ReviewItem,
} from '@/api/types'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const diaryStore = useDiaryStore()
const masterStore = useMasterStore()

const practiceId = route.params.id as string

// -- Data --
const practice = ref<PracticeResponse | null>(null)
const attendance = ref<AttendanceResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

// -- Status branch --
const isPast = computed(
  (): boolean => practice.value?.status === 'completed' || practice.value?.status === 'cancelled',
)
const isUpcoming = computed((): boolean => practice.value != null && !isPast.value)
const isDraft = computed((): boolean => practice.value?.status === 'draft')
const headerTitle = computed((): string => (isPast.value ? 'Прошедшая практика' : 'Практика'))
const destructiveLabel = computed((): string => (isDraft.value ? 'Удалить' : 'Отменить практику'))

// Reactive insights cache (shared with Analytics / Practices — often warm).
const insightsCache = diaryStore.insightsCache
const insights = computed(() => insightsCache.get(practiceId) ?? null)

// -- Hero meta (shared) --
const whenLabel = computed((): string => {
  if (!practice.value) return ''
  const day = formatDateShort(practice.value.scheduled_at, practice.value.timezone)
  const time = formatTime(practice.value.scheduled_at, practice.value.timezone)
  return `${day}, ${time}`
})

const durationLabel = computed((): string =>
  practice.value ? `${practice.value.duration_minutes} мин` : '',
)

// -- Upcoming hero extras --
// Recurrence chip (Q2=Б): mirrors MasterPracticesView — «Пн, Ср, Пт» / «Ежедневно»
// for a series, «Регулярная» when the day list is empty; null hides the chip.
const recurrenceLabel = computed((): string | null => {
  if (practice.value?.practice_type !== 'series') return null
  return recurrenceDaysLabel(practice.value.recurrence_days) ?? 'Регулярная'
})

// Accordion open state (local per-screen cards, was VAccordion — ПРОМТ №158).
// All three open by default (operator PD-C1: Противопоказания also expanded).
const descOpen = ref(true)
const contraOpen = ref(true)
const prepOpen = ref(true)

const difficultyDots = computed((): number => {
  const d = practice.value?.difficulty
  return d ? DIFFICULTY_DOTS[d as PracticeDifficulty] : 0
})
const difficultyLabel = computed((): string => {
  const d = practice.value?.difficulty
  return d ? DIFFICULTY_LABEL[d as PracticeDifficulty] : ''
})

// -- Upcoming stat cards --
const enrolledStat = computed((): string | number =>
  attendance.value ? attendance.value.total : '—',
)
const capacityStat = computed((): string | number => {
  const cap = practice.value?.max_participants
  return cap != null ? cap : '∞'
})

// -- Roster (Записались): первые 5, остальные — по «+ ещё N участников» --
const ROSTER_PREVIEW = 5
const rosterItems = computed((): AttendanceItemResponse[] => attendance.value?.items ?? [])
const rosterExpanded = ref(false)
const visibleRoster = computed((): AttendanceItemResponse[] =>
  rosterExpanded.value ? rosterItems.value : rosterItems.value.slice(0, ROSTER_PREVIEW),
)
const hiddenRosterCount = computed((): number =>
  Math.max(0, rosterItems.value.length - ROSTER_PREVIEW),
)

function displayName(item: AttendanceItemResponse): string {
  return item.user_display_name || `#${item.user_id.slice(0, 8)}`
}
function initials(item: AttendanceItemResponse): string {
  const name = (item.user_display_name || item.user_id).trim()
  return (name.charAt(0) || '?').toUpperCase()
}

// 2026-07-14: this roster paints <img> directly instead of going through
// VAvatar, so it needs its own broken-image guard. A dead avatar host (t.me was
// pulled at the registry level, taking every Telegram userpic with it) would
// otherwise render a broken glyph while initials() sits right there, unused.
// Keyed by booking_id -- one bad avatar must not blank out the whole roster.
const brokenAvatars = ref(new Set<string>())

// -- Past: rating distribution badges (REAL, anonymous insights) --
const totalFeedbacks = computed((): number => {
  const f = insights.value?.feedbacks
  return f ? f.fire + f.good + f.confused : 0
})
const hasRating = computed((): boolean => insights.value != null && totalFeedbacks.value > 0)
function ratingPct(key: 'fire' | 'good' | 'confused'): number {
  const f = insights.value?.feedbacks
  if (!f) return 0
  const total = totalFeedbacks.value
  return total > 0 ? Math.round((f[key] / total) * 100) : 0
}

// -- Past: stats (REAL via getAttendance; "—" until loaded) --
const attendedValue = computed((): string | number =>
  attendance.value ? attendance.value.attended : '—',
)
const noShowValue = computed((): string | number =>
  attendance.value ? attendance.value.no_show : '—',
)

// -- Past: Отзывы участников (E1 named reviews — getPracticeReviews, paginated) --
const REVIEWS_PAGE = 20
const REVIEWS_PREVIEW = 10
const reviews = ref<ReviewItem[]>([])
const reviewsTotal = ref(0)
const reviewsLoading = ref(false)
const hasMoreReviews = computed((): boolean => reviews.value.length < reviewsTotal.value)

// Первые 10 + раскрытие «посмотреть еще» (operator ПРОМТ №160).
const reviewsExpanded = ref(false)
const visibleReviews = computed((): ReviewItem[] =>
  reviewsExpanded.value ? reviews.value : reviews.value.slice(0, REVIEWS_PREVIEW),
)
const hiddenReviewsCount = computed((): number => Math.max(0, reviewsTotal.value - REVIEWS_PREVIEW))
function expandReviews(): void {
  reviewsExpanded.value = true
  if (hasMoreReviews.value) loadMoreReviews()
}

async function loadReviews(): Promise<void> {
  reviewsLoading.value = true
  try {
    const res = await getPracticeReviews(practiceId, REVIEWS_PAGE, 0)
    reviews.value = res.items
    reviewsTotal.value = res.total
  } catch {
    // Non-fatal: the rest of the detail view stays usable; the section shows empty.
  } finally {
    reviewsLoading.value = false
  }
}

async function loadMoreReviews(): Promise<void> {
  if (reviewsLoading.value || !hasMoreReviews.value) return
  reviewsLoading.value = true
  try {
    const res = await getPracticeReviews(practiceId, REVIEWS_PAGE, reviews.value.length)
    reviews.value = [...reviews.value, ...res.items]
    reviewsTotal.value = res.total
  } catch {
    // Keep the loaded page; the «Показать ещё» button stays for a retry.
  } finally {
    reviewsLoading.value = false
  }
}

// -- Navigation --
function goCheckins(): void {
  router.push({ name: 'master-attendance', params: { id: practiceId } })
}
function goRoster(): void {
  router.push({ name: 'master-attendance-roster', params: { id: practiceId } })
}
function goEdit(): void {
  router.push({ name: 'master-practice-edit', params: { id: practiceId } })
}

// -- «…» destructive: cancel (scheduled/live) or delete (draft) --
const showCancel = ref(false)
const showDelete = ref(false)
const cancelling = ref(false)
const deleting = ref(false)

function openDestructive(): void {
  if (isDraft.value) showDelete.value = true
  else showCancel.value = true
}

async function doCancel(scope: 'this' | 'this_and_future'): Promise<void> {
  if (cancelling.value) return
  cancelling.value = true
  try {
    await cancelPractice(practiceId, scope)
    toast.success('Практика отменена')
    await masterStore.refreshMyPractices()
    router.back()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отменить практику'))
  } finally {
    cancelling.value = false
    showCancel.value = false
  }
}

async function doDelete(): Promise<void> {
  if (deleting.value) return
  deleting.value = true
  try {
    await deletePractice(practiceId)
    toast.success('Черновик удалён')
    await masterStore.refreshMyPractices()
    router.back()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось удалить практику'))
  } finally {
    deleting.value = false
    showDelete.value = false
  }
}

// -- Load --
async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const cached = masterStore.practices.find((p) => p.id === practiceId)
    practice.value = cached ?? (await getPractice(practiceId))

    // Both branches need attendance (roster / stats). Insights (anonymous rating
    // distribution) only feed the PAST hero badges — load them lazily there.
    const [attendanceData] = await Promise.all([
      getAttendance(practiceId),
      isPast.value ? diaryStore.loadInsights(practiceId) : Promise.resolve(),
    ])
    attendance.value = attendanceData

    // Named reviews only exist for finished practices; non-fatal alongside the load.
    if (isPast.value) void loadReviews()
  } catch (e) {
    error.value = extractApiError(e, 'Ошибка загрузки')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.practice-detail {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.practice-detail__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}

.practice-detail__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding). */
  padding: var(--space-4) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Past detail: drop the content's top padding so the hero card sits closer to the
   floating header (operator PP-D1; the fog top-gap keeps the breathing room).
   Upcoming keeps the default spacing. */
.practice-detail__content--past {
  padding-top: 0;
}

/* ===== Stats ===== */
.practice-detail__stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
}

/* ===== Section ===== */
.practice-detail__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* Описание / Противопоказания / Что подготовить — отдельные карточки
   (bold header + big chevron, screen-local; ПРОМТ №158). */
.pd-acc {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: 0 var(--space-4);
}

.pd-acc__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: var(--space-3);
  padding: var(--space-4) 0;
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--velo-text-primary);
  text-align: left;
}

.pd-acc__chev {
  flex-shrink: 0;
  stroke: var(--velo-primary);
  stroke-width: 2;
  fill: none;
  transition: transform var(--transition-fast);
}

.pd-acc--open .pd-acc__chev {
  transform: rotate(180deg);
}

.pd-acc__body {
  padding: var(--space-3) 0 var(--space-4);
  border-top: 1px solid var(--velo-border-light);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.5;
}

/* ===== Записались rows (upcoming roster) ===== */
.pd-prow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: 10px var(--space-4);
}

.pd-prow__ava {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--velo-glass-blue-60);
  color: var(--velo-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  font-family: var(--font-body);
  font-size: var(--text-sm);
}

.pd-prow__ava-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pd-prow__name {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
}

/* ===== Review card (PAST) ===== */
.practice-detail__review {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--velo-card-padding-x);
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-6);
}

.practice-detail__review-top {
  display: flex;
  align-items: center;
  gap: var(--velo-card-meta-row-gap);
}

/* Identifier icon (the rating the student chose) — replaces the avatar, left. */
.practice-detail__review-ic {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}

.practice-detail__review-name {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.practice-detail__review-quote {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.45;
}

.practice-detail__rloader {
  display: flex;
  justify-content: center;
  padding: var(--space-4) 0;
}

.practice-detail__more {
  display: flex;
  justify-content: center;
  padding-top: var(--space-2);
}

/* ===== CTAs ===== */
.practice-detail__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-1);
}
</style>
