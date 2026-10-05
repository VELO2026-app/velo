<!--
  VELO Frontend -- MasterPublicView (Calendar iteration, S-4)

  Public master profile shown to users who tap "Подробнее" on a practice's
  master card (frame 4). Figma node 541:2065:
    - Hero card: avatar, name, "N лет опыта" pill, bio (the verified check
      badge is hidden product-wide, owner 2026-10-03)
    - Two stat cards: practices_count "Практик" / reviews_count "Отзывов"
    - "Методы" accordion (method chips)
    - «Предстоящие практики» nav row (owner 2026-09-30) -> the stacked
      user-calendar-master route (the master's practice calendar)
    - «Аналитика» accordion, curator-of-the-school only (?groupId=):
      PLACEHOLDER until the curator-analytics contract exists
    - «Ближайшие практики»: plain heading + up to 5 upcoming-practice cards
      (owner 2026-09-30 -- the collapsed accordion is retired; reuses
      getPractices with master_id -- no new endpoint, no dedicated store).
      Owner 2026-10-03: in the curator's school context (?groupId=) only the
      master's practices in THAT school are listed -- a larger page is fetched
      and filtered client-side by the practices' curator_group_id (the public
      feed has no school param); «Предстоящие практики» hands ?groupId to the
      master calendar for the same filter.
    - «⋯» меню: «Написать сообщение» -> ask-master flow (T2); в школьном
      контексте куратора — ещё «Изменить роль» и «Заблокировать» (владелец,
      2026-09-30; «Изменить роль» — BE-59, «Заблокировать» — BE-79 (2))

  Backend: GET /api/v1/masters/:id (MasterPublicResponse). Only verified
  masters resolve; 404 otherwise -> "Мастер не найден" (no retry, nothing to
  retry). A 5xx/network failure is a DIFFERENT empty state -- "Не удалось
  загрузить" with a "Повторить" retry -- since the master may well exist
  (B11 item 2, PROMPT №587; before this both collapsed into "не найден").

  Route: /user/masters/:id  (name: user-master-public)
-->

<template>
  <div class="master-public">
    <VHeader title="Мастер" show-back @back="router.back()">
      <!-- The ⋯ menu: «Написать сообщение» for EVERY visitor (owner
           2026-09-30 -- replaced the «Задать вопрос» button). In the
           curator's school context (the roster's master rows navigate here
           with ?groupId=) it also carries the curator's actions: «Изменить
           роль» (BE-59 demote) and «Заблокировать» (BE-79 (2) block). -->
      <template #action>
        <VMenu aria-label="Действия с мастером">
          <template #default="{ close }">
            <VMenuItem
              :icon="IconMessages"
              ariaLabel="Написать сообщение"
              @click="onMessageClick(close)"
            />
            <VMenuItem
              v-if="schoolContext"
              :icon="IconPen"
              ariaLabel="Изменить роль"
              @click="onRoleClick(close)"
            />
            <VMenuItem
              v-if="schoolContext"
              :icon="IconLock"
              ariaLabel="Заблокировать"
              danger
              @click="onBlockClick(close)"
            />
          </template>
        </VMenu>
      </template>
    </VHeader>

    <!-- Loading -->
    <div v-if="loading" class="master-public__loader">
      <VLoader size="lg" />
    </div>

    <!-- Not found (404): the master genuinely doesn't exist / isn't verified. -->
    <VEmptyState
      v-else-if="notFound"
      icon="warning"
      title="Мастер не найден"
      :description="error ?? undefined"
    >
      <VButton size="sm" @click="router.back()">Назад</VButton>
    </VEmptyState>

    <!-- Server/network error (B11 item 2): distinct from "not found" -- this
         master may well exist, the load just failed and is worth retrying. -->
    <VEmptyState
      v-else-if="error || !profile"
      icon="warning"
      title="Не удалось загрузить"
      :description="error ?? undefined"
    >
      <VButton size="sm" @click="loadMaster(masterId)">Повторить</VButton>
    </VEmptyState>

    <!-- Content -->
    <div
      v-else
      class="master-public__content"
      :class="{ 'master-public__content--with-cta': schoolContext }"
    >
      <!-- Hero -->
      <VCard class="master-public__hero" padding="none">
        <!-- No verification checkmark on the avatar: hidden product-wide
             (owner 2026-10-03). -->
        <VAvatar :url="profile.avatar_url ?? ''" :name="displayName" size="xl" />

        <h1 class="master-public__name">{{ displayName }}</h1>

        <div v-if="profile.experience_years != null" class="master-public__pills">
          <span class="master-public__pill">
            {{ profile.experience_years }} {{ pluralYears(profile.experience_years) }} опыта
          </span>
        </div>

        <p v-if="profile.bio" class="master-public__bio">{{ profile.bio }}</p>
      </VCard>

      <!-- Stats -->
      <div class="master-public__stats">
        <VStatCard
          layout="row"
          :value="profile.practices_count"
          :label="pluralPractices(profile.practices_count)"
        />
        <VStatCard
          layout="row"
          :value="profile.reviews_count"
          :label="pluralReviews(profile.reviews_count)"
        />
      </div>

      <!-- Methods accordion (owner 2026-09-30: ALWAYS renders -- like
           «Ближайшие», the section never disappears; default-open, an empty
           profile gets the honest note, the header stays as the entry
           point). -->
      <VAccordion title="Методы" default-open>
        <div v-if="profile.methods?.length" class="master-public__chips">
          <VTag
            v-for="(chip, i) in methodChips"
            :key="`${i}:${chip.label}`"
            :variant="TAG_VARIANTS[i % TAG_VARIANTS.length]"
          >
            <component :is="chip.icon" :size="12" aria-hidden="true" />
            {{ chip.label }}
          </VTag>
        </div>
        <p v-else class="master-public__note">Методы пока не указаны.</p>
      </VAccordion>

      <!-- «Предстоящие практики» (owner 2026-09-30): nav row to the stacked
           master-practice calendar. A row, not an accordion -- it only
           navigates. -->
      <button type="button" class="master-public__nav" @click="goToCalendar">
        <span class="master-public__nav-label">Предстоящие практики</span>
        <IconChevronRight :size="16" />
      </button>

      <!-- Аналитика: curator-of-THIS-school only (the ?groupId= marker).
           PLACEHOLDER until the curator-analytics contract exists (same
           pattern as the Блок tab) -- no endpoint serves a member master's
           figures to the school curator yet. -->
      <VAccordion v-if="schoolContext" title="Аналитика">
        <p class="master-public__note">
          Аналитика мастера появится здесь после подключения данных.
        </p>
      </VAccordion>

      <!-- Ближайшие практики (owner 2026-09-30): the title ALWAYS shows --
           with cards when the master has scheduled practices, with the honest
           «пока не запланировано» note when not (≤5 cards; the collapsed
           accordion from operator 2026-06-05 is retired; the ⋯ menu keeps
           floating above). show-date: практики идут в разные дни. -->
      <section class="master-public__upcoming">
        <h3 class="master-public__section-title">Ближайшие практики</h3>
        <div v-if="upcoming.length" class="master-public__practices">
          <CalendarPracticeCard
            v-for="p in upcoming"
            :key="p.id"
            :practice="p"
            show-date
            @click="goToPractice"
          />
        </div>
        <p v-else class="master-public__note">Пока практик не запланировано.</p>
      </section>

      <!-- «Написать сообщение» (the ⋯ menu) replaced the «Задать вопрос»
           button: opens/joins the eternal DM with this master (POST
           /api/v1/chats is create-or-get, so tapping twice lands in the same
           thread) and navigates in. -->
    </div>

    <!-- «Создать практику» (owner 2026-09-30): hangs above the tab bar,
         curator-of-THIS-school only (?groupId=). Same §1.6 hand-off as the
         school page: master AND school go to the create flow (FE-92). -->
    <div v-if="schoolContext" class="master-public__cta">
      <VButton variant="primary" block size="lg" @click="goCreatePractice">
        Создать практику
      </VButton>
    </div>

    <!-- «Написать сообщение» (owner 2026-09-30 -- replaced the «Задать
           вопрос» button): the composer opens the eternal DM with this
           master and posts the text; success toasts and closes. -->
    <SendMessageModal
      :open="composerOpen"
      :master-id="masterId"
      :name="displayName"
      @close="composerOpen = false"
    />

    <!-- «Изменить роль» for a SCHOOL MASTER (owner ruling 2026-09-30). The
         radio preselects the member's current role (master); choosing
         «Ученик» is a DEMOTE request -- its contract does not exist yet
         (§7.1 №6 + BE-59's extensible field), so confirm is a marked no-op
         (info toast) and the copy stays a draft. -->
    <VModal :open="roleOpen" :show-close="false" @close="onRoleClose">
      <div class="master-public__role">
        <h2 class="master-public__role-title">Изменить роль</h2>
        <TargetUserCard :name="displayName" :avatar-url="profile?.avatar_url ?? null" />
        <p class="master-public__role-sub">Выберите роль</p>
        <VRadioGroup v-model="roleKind" :options="roleOptions" />
        <div class="master-public__role-actions">
          <VButton variant="danger" block @click="onRoleClose">Отмена</VButton>
          <VButton
            variant="primary"
            block
            :loading="demoting"
            :disabled="roleConfirmDisabled"
            @click="onRoleConfirm"
          >
            Изменить
          </VButton>
        </div>
      </div>
    </VModal>

    <!-- Block confirm (owner ruling 2026-09-30: blocking covers masters too).
         Confirm sends POST …/members/{id}/block (BE-79 (2)); the copy is a
         DRAFT for the owner's review. -->
    <VConfirmDialog
      :open="blockConfirmOpen"
      title="Заблокировать участника школы?"
      :message="blockCopy"
      confirm-label="Заблокировать"
      danger
      warning-panel
      cancel-variant="primary"
      @confirm="onBlockConfirm"
      @cancel="blockConfirmOpen = false"
    >
      <TargetUserCard :name="displayName" :avatar-url="profile?.avatar_url ?? null" />
    </VConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  VLoader,
  VEmptyState,
  VButton,
  VAccordion,
  VTag,
  VAvatar,
  VStatCard,
  VCard,
  VConfirmDialog,
  VMenu,
  VMenuItem,
  VModal,
  VRadioGroup,
} from '@/components/ui'
import { VHeader } from '@/components/layout'
import { IconChevronRight, IconLock, IconMessages, IconPen } from '@/components/icons'
import CalendarPracticeCard from '@/components/shared/CalendarPracticeCard.vue'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import TargetUserCard from '@/components/shared/TargetUserCard.vue'
import { getPublicMaster } from '@/api/masters'
import { getPractices } from '@/api/practices'
import { blockCuratorGroupMember, demoteCuratorGroupMaster } from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { plural } from '@/utils/plural'
import { methodChipFor } from '@/utils/methodChips'
import type { MasterPublicResponse, PracticeResponse } from '@/api/types'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const profile = ref<MasterPublicResponse | null>(null)
const upcoming = ref<PracticeResponse[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
/** B11 item 2: 404 (master genuinely doesn't exist) is a DIFFERENT state
 *  from a 5xx/network failure (server down, worth retrying) -- collapsing
 *  them both into "Мастер не найден" told the user to give up on a master
 *  who might well exist. Derived from the caught error's own status, no
 *  backend field added. */
const notFound = ref(false)

const masterId = computed(() => String(route.params.id))

const displayName = computed(() => profile.value?.display_name ?? 'Мастер')

// Method tags cycle through three tints (same as MasterCard).
const TAG_VARIANTS = ['blue', 'pink', 'sand'] as const

// -- Curator's school-context actions (owner ruling 2026-09-30) ---------------
//
// The roster's master rows navigate here with ?groupId= -- that marker turns
// on the action menu for the curator of THAT school. The plain public profile
// (any other entry) renders no menu. «Изменить роль» is the BE-59 demote
// (wired); «Заблокировать» sends the BE-79 block (wired, BE-79 (2)).

const groupId = computed(() => String(route.query.groupId ?? ''))
const schoolContext = computed(() => groupId.value !== '')

const roleOpen = ref(false)
type MemberKind = 'student' | 'master'
const roleKind = ref<MemberKind>('master')
const roleOptions: { value: MemberKind; label: string }[] = [
  { value: 'student', label: 'Ученик' },
  { value: 'master', label: 'Мастер' },
]
const roleConfirmDisabled = computed(() => roleKind.value === 'master')

function onRoleClick(close: () => void): void {
  close()
  roleKind.value = 'master'
  roleOpen.value = true
}

function onRoleClose(): void {
  roleOpen.value = false
}

// The demote (BE-59 B1): a school master becomes a student of THIS school.
// No consent asked (owner ruling) -- the backend notifies the person. The
// confirm is demote-only (roleConfirmDisabled guards the master pick), the
// API is idempotent 204, so a double tap is harmless.
const demoting = ref(false)

async function onRoleConfirm(): Promise<void> {
  if (demoting.value) return
  demoting.value = true
  try {
    await demoteCuratorGroupMaster(groupId.value, masterId.value)
    roleOpen.value = false
    toast.success('Роль изменена: участник теперь ученик школы')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось изменить роль'))
  } finally {
    demoting.value = false
  }
}

const composerOpen = ref(false)
const blockConfirmOpen = ref(false)

const blockCopy =
  'Участник утратит доступ к школе и её практикам. Вы сможете разблокировать его в любой момент.'

function onBlockClick(close: () => void): void {
  close()
  blockConfirmOpen.value = true
}

// BE-79 (2): 204 -> say so and go back where the curator came from (the
// school roster: its master rows open this screen). 404 -> not a member any
// more -> the same way back. Anything else (409, 403 in user mode -- the
// server decides by the CURRENT role, network) -> the error toast, stay.
const blocking = ref(false)

async function onBlockConfirm(): Promise<void> {
  if (blocking.value) return
  blocking.value = true
  try {
    await blockCuratorGroupMember(groupId.value, masterId.value)
    blockConfirmOpen.value = false
    toast.success('Участник заблокирован')
    router.back()
  } catch (e) {
    blockConfirmOpen.value = false
    if (e instanceof ApiResponseError && e.status === 404) {
      toast.error('Участник уже не в школе')
      router.back()
      return
    }
    toast.error(extractApiError(e, 'Не удалось заблокировать участника'))
  } finally {
    blocking.value = false
  }
}

function onMessageClick(close: () => void): void {
  close()
  composerOpen.value = true
}

// FE-61/62: one chip = direction icon + SHORT skill label. The direction word
// embedded in a style label («Медитация молчания») is stripped so a pill
// never says the word twice (FE-64) — see utils/methodChips.ts.
const methodChips = computed(() => (profile.value?.methods ?? []).map(methodChipFor))

// -- Russian pluralization helpers (SW14: canonical impl in utils/plural.ts) --
function pluralYears(n: number): string {
  return plural(n, 'год', 'года', 'лет')
}
function pluralPractices(n: number): string {
  return plural(n, 'Практика', 'Практики', 'Практик')
}
function pluralReviews(n: number): string {
  return plural(n, 'Отзыв', 'Отзыва', 'Отзывов')
}

function goToPractice(id: string): void {
  void router.push({ name: 'practice-detail', params: { id } })
}

// The «Предстоящие практики» row: the stacked MASTER-practice calendar. The
// curator's school context travels along (?groupId) -- the calendar then shows
// only this master's practices in THAT school (owner 2026-10-03).
function goToCalendar(): void {
  void router.push({
    name: 'user-calendar-master',
    params: { masterId: masterId.value },
    query: schoolContext.value ? { groupId: groupId.value } : undefined,
  })
}

// The hanging «Создать практику» CTA: §1.6 hand-off naming the master --
// the create flow preselects (and locks) this master from the query. FE-92:
// the school travels too -- the backend creates for another master only IN
// a school (BE-102), and the CTA exists only in the school context.
function goCreatePractice(): void {
  void router.push({
    name: 'master-practice-new',
    query: { masterId: masterId.value, groupId: groupId.value },
  })
}

async function loadMaster(id: string): Promise<void> {
  loading.value = true
  error.value = null
  notFound.value = false
  try {
    profile.value = await getPublicMaster(id)
    // Upcoming practices by this master: reuse the public feed with a
    // master_id filter + scheduled status. Owner 2026-10-03: in the curator's
    // school context (?groupId=) only the master's practices in THAT school
    // are listed -- the public feed has no school param, so the page is
    // fetched larger and filtered client-side by the practices' own
    // curator_group_id (null on personal practices, a foreign school's id
    // otherwise). Outside the school context the plain feed stands.
    try {
      const res = await getPractices(
        {
          master_id: id,
          status: 'scheduled',
          sort_by: 'scheduled_at',
          sort_order: 'asc',
        },
        schoolContext.value ? 50 : 5,
        0,
      )
      // The ≤5 cap is also enforced locally: the owner's 2026-09-30 spec is
      // "up to 5 cards", independent of any server limit regression.
      const items = schoolContext.value
        ? res.items.filter((p) => p.curator_group_id === groupId.value)
        : res.items
      upcoming.value = items.slice(0, 5)
    } catch {
      // Non-fatal: the profile still renders without the upcoming list.
      upcoming.value = []
    }
  } catch (e) {
    const is404 = e instanceof ApiResponseError && e.status === 404
    notFound.value = is404
    error.value = extractApiError(e, is404 ? 'Профиль недоступен' : 'Попробуйте позже')
    profile.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadMaster(masterId.value)
})

// B11 item 2: Vue Router reuses this component instance when a navigation
// only changes route params under the same matched record (master A's
// public page -> master B's), so onMounted alone never re-fires.
watch(masterId, (id) => {
  void loadMaster(id)
})
</script>

<style scoped>
.master-public {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.master-public__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.master-public__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* Горизонтальный отступ раздаёт шелл (--velo-rail-pad-x=24), как на всех
   * экранах; локально только vertical — иначе был двойной padding и контент
   * у́же других экранов (operator 2026-06-04). */
  padding: var(--space-4) 0;
}

/* Hero */
.master-public__hero {
  padding: var(--space-5) var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-2);
}

.master-public__name {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0;
}

.master-public__pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}

.master-public__pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  /* Owner 2026-09-30: #E2F0FD fill, #619CD2 text (--velo-blue-100/400). */
  background: var(--velo-blue-100);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-blue-400);
}

.master-public__bio {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.6;
  margin: var(--space-1) 0 0;
}

/* Stats — two compact baseline-row VStatCards (layout="row"), each flexes equally. */
.master-public__stats {
  display: flex;
  gap: var(--space-3);
}

.master-public__stats > * {
  flex: 1;
}

/* Sections */
.master-public__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

/* «Изменить роль» popup (owner ruling 2026-09-30): title / who / role picker
   / pills -- the same skeleton the school student profile uses. */
.master-public__role {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.master-public__role-title {
  margin: 0;
  text-align: center;
  font-family: var(--font-body);
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
}

.master-public__role-sub {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}

.master-public__role-actions {
  display: flex;
  gap: var(--space-2);
}

/* «Ближайшие практики» — свёрнутый аккордеон. Контейнер прозрачный (чтобы тело
 * не было белой плашкой), заголовок = белая плашка как «Методы», тело прозрачное
 * -> карточки лежат на фоне отдельными прямоугольниками (без «слитности»). */
/* «Предстоящие практики»: a nav row (owner 2026-09-30) -- card plate, label
   + chevron, tap-only. */
.master-public__nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  /* Same vertical rhythm + font size as the page's :deep(.v-accordion__header)
     (text-base) -- the three panel headers must read identically. */
  padding: var(--space-3) var(--space-4);
  /* Header parity: the accordion header's text-base line makes it ~58px --
     match it so the label reads at the same optical size. */
  min-height: 58px;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  color: var(--velo-text-primary);
  font-family: var(--font-body);
  font-size: var(--text-base);
  cursor: pointer;
}

.master-public__nav :deep(svg) {
  color: var(--velo-text-muted);
}

.master-public__note {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.6;
  margin: 0;
}

/* The hanging curator CTA (owner 2026-09-30): the dock is HIDDEN in this
   mode (UserShell's isMasterCuratorRoute), so the button takes the dock's
   own place -- same floor (--space-8) + safe area, on the content rail. The
   content reserves matching tail room via --with-cta. */
.master-public__cta {
  position: fixed;
  left: var(--velo-rail-pad-x);
  right: var(--velo-rail-pad-x);
  bottom: calc(var(--space-8) + env(safe-area-inset-bottom, 0px));
  z-index: var(--z-sticky);
}

.master-public__content--with-cta {
  padding-bottom: 140px;
}

/* Ближайшие практики: plain heading, --text-base like the other panel
   headers (owner 2026-09-30), cards always open -- no accordion. */
.master-public__section-title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0 0 var(--space-3);
}

.master-public__practices {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.master-public__actions {
  margin-top: var(--space-2);
}

/* Аккордеон «Методы»: белая card-плашка (тот же приём, что аккордеоны на
   экране практики; локально, без правки общего VAccordion). */
:deep(.v-accordion) {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  border-bottom: none;
  overflow: hidden;
}

:deep(.v-accordion__header) {
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

:deep(.v-accordion__body) {
  padding: 0 var(--space-4) var(--space-3);
}

:deep(.v-accordion__arrow) {
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
}
</style>
