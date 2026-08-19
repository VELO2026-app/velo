<!--
  VELO Frontend -- MasterStudentProfileView (Master DS, 2026-06-11; block +
  report flow P3, PROMPT №592)

  "Профиль ученика" — one student's card: hero, GROUP CHIPS, stats, recent
  check-ins, feedbacks, "Написать сообщение", and (P3) a destructive
  «Заблокировать пользователя» at the bottom. Rendered inside MasterShell.

  LIVE (E5): getStudent(id) → GET /api/v1/masters/me/students/{id} →
  StudentDetailResponse { name, avatar_url, practices_count, hours,
  satisfaction_pct, recent_checkins[], feedbacks[], blocked }. Reuses the real
  MoodAvatar (diary mood faces) for check-ins. The "Написать сообщение" action
  is still a STUB (E4 messaging pending backend).

  P3 additions:
    - Group chips (VTag): GET /masters/me/students/{id}/groups (this
      master's CUSTOM groups the student is in). Empty -> no chips row.
    - «Заблокировать пользователя» (VButton danger) -> block confirm
      (VConfirmDialog, destructive) -> POST .../block (P1) -> toast -> THEN
      the report-offer (VConfirmDialog) -> optionally ReportUserSheet
      (POST /api/v1/reports, the EXISTING backend table -- recon #589).

  T24-9/10/19/20 (PROMPT №638): the per-row "..." menu that used to live on
  every member-list row (MasterGroupDetailView.vue) moved HERE -- a dots
  trigger top-right (horizontal at rest, rotates vertical open, T24-9) opens
  tag / add-to-group / remove-from-group (T24-10), reusing the SAME three
  sheets the row used to open, just targeting THIS profile's own student
  instead of a clicked row. Hidden entirely while blocked (T24-20) -- same
  reasoning the row itself already used for a blocked member ("everything
  else is meaningless for a blocked student"), just relocated. The bottom
  action (T24-20) reads "Разблокировать пользователя" instead of
  "Заблокировать пользователя" when `detail.blocked` is true, and opens the
  unblock confirm instead of the block confirm -- otherwise byte-identical
  (still `variant="danger"`, same position).
-->

<template>
  <div class="profile">
    <VHeader title="Профиль ученика" show-back @back="router.back()">
      <template v-if="detail && !detail.blocked" #action>
        <VMenu ariaLabel="Меню ученика">
          <!-- T24-9: horizontal at rest, rotates to vertical open -- the
               OPPOSITE resting orientation of the diary's own dots override
               (DiaryFeedView.vue: vertical at rest, rotates to horizontal).
               Same mechanic (a #trigger override + a CSS rotate class), not
               the same starting SVG -- reused per the owner's spec, not
               promoted into VMenu itself (the two screens want opposite
               motion, so a shared default would need a direction prop for
               exactly two call sites -- not worth it). -->
          <template #trigger="{ open }">
            <svg
              class="profile__dots"
              :class="{ 'profile__dots--open': open }"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <circle cx="5" cy="12" r="2.5" />
              <circle cx="12" cy="12" r="2.5" />
              <circle cx="19" cy="12" r="2.5" />
            </svg>
          </template>
          <template #default="{ close }">
            <VMenuItem :icon="IconTag" ariaLabel="Добавить тег" @click="onTagClick(close)" />
            <VMenuItem
              :icon="IconPen"
              ariaLabel="Добавить в группу"
              @click="onAddToGroupClick(close)"
            />
            <VMenuItem
              :icon="IconTrash"
              ariaLabel="Удалить из группы"
              danger
              @click="onRemoveFromGroupClick(close)"
            />
          </template>
        </VMenu>
      </template>
    </VHeader>

    <div class="profile__content">
      <!-- Loading -->
      <div v-if="loading" class="profile__state">
        <VLoader size="lg" />
      </div>

      <!-- Error -->
      <VEmptyState
        v-else-if="error"
        icon="warning"
        title="Не удалось загрузить профиль"
        :description="error"
      >
        <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
      </VEmptyState>

      <template v-else>
        <!-- Hero (name comes from the list nav — see script note) -->
        <div class="profile__hero">
          <VAvatar :name="name" :url="avatarUrl" size="xl" class="profile__hero-ava" />
          <div class="profile__hero-name">{{ name }}</div>
        </div>

        <!-- Group chips (P3): this master's custom groups the student is in. -->
        <div v-if="groupChips.length" class="profile__groups">
          <VTag v-for="g in groupChips" :key="g.id">{{ g.name }}</VTag>
        </div>

        <!-- Stats (% card removed — PROMPT №157; two cards widen under the hero) -->
        <div class="profile__stats">
          <VStatCard :value="practicesCount" label="Практик" />
          <VStatCard :value="hours" label="Часов" />
        </div>

        <!-- Recent check-ins (cap 3; rest behind «посмотреть еще» — PROMPT №157) -->
        <h2 class="velo-section-title">Последние check-ins</h2>
        <div v-if="checkinRows.length === 0" class="profile__empty">Пока нет check-ins</div>
        <div v-for="(ci, i) in visibleCheckins" :key="`ci-${i}`" class="profile__ci">
          <MoodAvatar :mood="ci.mood" :size="46" />
          <div class="profile__ci-body">
            <div class="profile__ci-text">{{ ci.comment || moodLabelFromScore(ci.mood) }}</div>
            <div class="profile__ci-date">{{ ci.date }}</div>
          </div>
        </div>
        <VShowMore
          v-if="!ciExpanded && hiddenCheckins > 0"
          label="посмотреть еще"
          @click="ciExpanded = true"
        />

        <!-- Feedbacks (cap 3; rest behind «посмотреть еще» — PROMPT №157) -->
        <h2 class="velo-section-title">Feedbacks</h2>
        <div v-if="feedbackRows.length === 0" class="profile__empty">Пока нет отзывов</div>
        <div v-for="(fb, i) in visibleFeedbacks" :key="`fb-${i}`" class="profile__fb">
          <span class="profile__fb-ic" :style="{ color: fb.color }">
            <component :is="fb.icon" :size="30" />
          </span>
          <div class="profile__fb-body">
            <div class="profile__fb-row">
              <span class="profile__fb-title">{{ fb.label }}</span>
              <span class="profile__fb-date">{{ fb.date }}</span>
            </div>
            <div v-if="fb.comment" class="profile__fb-text">{{ fb.comment }}</div>
          </div>
        </div>
        <VShowMore
          v-if="!fbExpanded && hiddenFeedbacks > 0"
          label="посмотреть еще"
          @click="fbExpanded = true"
        />

        <!-- Action (stub — E4 messaging not delivered) -->
        <VButton variant="primary" block class="profile__cta" @click="msgOpen = true">
          Написать сообщение
        </VButton>

        <!-- P3 (PROMPT №592): destructive, bottom of the screen (design variant 3).
             T24-20: label + target swap when blocked -- otherwise byte-identical
             (still variant="danger", same position). -->
        <VButton variant="danger" block class="profile__block-cta" @click="onBlockActionClick">
          {{ blockActionLabel }}
        </VButton>
      </template>
    </div>

    <SendMessageModal :open="msgOpen" :name="name" @close="msgOpen = false" />

    <!-- Block confirm (destructive). TargetUserCard (owner Q9, PROMPT №610)
         via the default slot + warning-panel for the consequences text
         (same peach recipe as ReportUserSheet's notice, WITH an icon --
         that dialog deliberately has none). -->
    <VConfirmDialog
      :open="blockConfirmOpen"
      title="Заблокировать пользователя?"
      message="Пользователь переместится в группу «Удаленные». Он больше не сможет видеть и бронировать ваши практики и перестанет получать ваши уведомления. Вы сможете разблокировать его в любой момент."
      confirm-label="Заблокировать"
      danger
      warning-panel
      cancel-variant="primary"
      :loading="blocking"
      @confirm="onBlockConfirm"
      @cancel="blockConfirmOpen = false"
    >
      <TargetUserCard :name="name" :avatar-url="avatarUrl" class="profile__dialog-card" />
    </VConfirmDialog>

    <!-- Report-offer (optional step -- dismiss is fine). compact-actions
         (PROMPT №609, G10) + confirm-label shortened to «В поддержку»
         (owner Q1, PROMPT №610) -- «Сообщить в поддержку» was the label
         still overflowing even at compact size; see the delivery report
         for the measured fit with the new label. -->
    <VConfirmDialog
      :open="reportOfferOpen"
      title="Пользователь заблокирован"
      message="Пользователь перемещен в «Удаленные». Если он нарушал правила — например, сорвал практику или вел себя неподобающе, — вы можете сообщить об этом в поддержку."
      confirm-label="В поддержку"
      cancel-label="Не сейчас"
      compact-actions
      warning-panel
      :warning-panel-icon="false"
      danger
      cancel-variant="primary"
      @confirm="onReportOfferAccept"
      @cancel="reportOfferOpen = false"
    >
      <TargetUserCard :name="name" :avatar-url="avatarUrl" class="profile__dialog-card" />
    </VConfirmDialog>

    <ReportUserSheet
      :open="reportFormOpen"
      :student-id="String(route.params.id)"
      :student-name="name"
      :student-avatar-url="avatarUrl"
      @close="reportFormOpen = false"
    />

    <!-- Unblock confirm (T24-20). Same copy/structure the row's own unblock
         dialog used before T24-19 removed it (MasterGroupDetailView.vue,
         P3 PROMPT №592 + T24-28..31 styling, PROMPT №634) -- relocated
         verbatim, not redesigned. -->
    <VConfirmDialog
      :open="unblockConfirmOpen"
      :title="`Разблокировать?`"
      :message="`${name} вернется в группу «Ученики» и снова сможет видеть и бронировать ваши практики.`"
      confirm-label="Разблокировать"
      danger
      warning-panel
      cancel-variant="primary"
      title-strong
      :loading="unblocking"
      @confirm="onUnblockConfirm"
      @cancel="unblockConfirmOpen = false"
    >
      <TargetUserCard :name="name" :avatar-url="avatarUrl" class="profile__dialog-card" />
    </VConfirmDialog>

    <!-- T24-10: the profile's own "..." menu, reusing the SAME three sheets
         the row used to open (MasterGroupDetailView.vue, before T24-19).
         currentGroupId is null for both -- the profile has no single "this
         group" context the way a member row did (AddToGroupSheet already
         supported null; RemoveFromGroupSheet was widened to support it,
         T24-10, PROMPT №638 -- see that component's own comment). -->
    <AddTagSheet
      :open="tagSheetOpen"
      :student-id="String(route.params.id)"
      :student-name="name"
      :current-tag="null"
      @close="tagSheetOpen = false"
    />

    <AddToGroupSheet
      :open="addToGroupSheetOpen"
      :student-id="String(route.params.id)"
      :student-name="name"
      :avatar-url="avatarUrl"
      :custom-groups="customGroups"
      :existing-group-ids="groupChips.map((g) => g.id)"
      :current-group-id="null"
      @close="addToGroupSheetOpen = false"
      @saved="loadGroups"
    />

    <RemoveFromGroupSheet
      :open="removeFromGroupSheetOpen"
      :student-id="String(route.params.id)"
      :student-name="name"
      :avatar-url="avatarUrl"
      :current-group-id="null"
      :custom-groups="customGroups"
      @close="removeFromGroupSheetOpen = false"
      @saved="loadGroups"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import {
  VAvatar,
  VStatCard,
  VButton,
  VLoader,
  VEmptyState,
  VTag,
  VConfirmDialog,
  VMenu,
  VMenuItem,
} from '@/components/ui'
import MoodAvatar from '@/components/shared/MoodAvatar.vue'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import ReportUserSheet from '@/components/shared/ReportUserSheet.vue'
import TargetUserCard from '@/components/shared/TargetUserCard.vue'
import VShowMore from '@/components/shared/VShowMore.vue'
import AddTagSheet from '@/components/shared/AddTagSheet.vue'
import AddToGroupSheet from '@/components/shared/AddToGroupSheet.vue'
import RemoveFromGroupSheet from '@/components/shared/RemoveFromGroupSheet.vue'
import { IconTag, IconPen } from '@/components/icons'
// IconTrash is not re-exported from the icons barrel (same pattern as
// EntryView.vue's delete action / MasterGroupDetailView.vue's header menu).
import IconTrash from '@/components/icons/IconTrash.vue'
import {
  moodLabelFromScore,
  ratingLabelFromScore,
  ratingZoneFromScore,
  RATING_ICON_COLOR,
} from '@/utils/displayHelpers'
import { RATING_ICON } from '@/utils/ratingIcons'
import { formatShortDate } from '@/utils/format'
import { getStudent, type StudentDetailResponseWithBlocked } from '@/api/masters'
import { getStudentGroups, getGroups, blockStudent, unblockStudent } from '@/api/groups'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import type { StudentGroupItem, GroupListItem } from '@/api/groups'

const route = useRoute()
const router = useRouter()

// Identity comes from StudentDetailResponse (name/avatar_url, E5). The list
// still forwards ?name= for an instant pre-fetch render; «Ученик» is only a
// last-resort fallback (e.g. before the fetch resolves on a direct deep-link),
// never the unconditional placeholder.
const name = computed((): string => {
  const q = route.query.name
  return detail.value?.name || (typeof q === 'string' && q) || 'Ученик'
})
const avatarUrl = computed((): string => detail.value?.avatar_url ?? '')

// -- Per-student aggregate (E5: GET /masters/me/students/{id}). --
const detail = ref<StudentDetailResponseWithBlocked | null>(null)
const loading = ref(true)
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    detail.value = await getStudent(String(route.params.id))
  } catch {
    error.value = 'Попробуйте ещё раз'
  } finally {
    loading.value = false
  }
}
onMounted(load)

// -- Group chips (P3): this master's custom groups the student is in. --
// Non-fatal on failure -- the profile still renders without them.
const groupChips = ref<StudentGroupItem[]>([])
async function loadGroups(): Promise<void> {
  try {
    const res = await getStudentGroups(String(route.params.id))
    groupChips.value = res.groups
  } catch {
    groupChips.value = []
  }
}
onMounted(loadGroups)

// T24-10 (PROMPT №638): EVERY custom group of this master's -- feeds
// AddToGroupSheet / RemoveFromGroupSheet's chip palette (distinct from
// groupChips above, which is only the groups THIS student is already in --
// same distinction MasterGroupDetailView.vue's own allGroups/customGroups
// made). Non-fatal on failure, same reasoning as loadGroups above.
const allGroups = ref<GroupListItem[]>([])
const customGroups = computed(() => allGroups.value.filter((g) => g.kind === 'custom'))
async function loadCustomGroups(): Promise<void> {
  try {
    const res = await getGroups()
    allGroups.value = res.items
  } catch {
    allGroups.value = []
  }
}
onMounted(loadCustomGroups)

// -- T24-9/10: the profile's own "..." menu (tag / add-to-group / remove
// from group), always targeting THIS profile's student -- unlike the row's
// old per-member menu, there is only ever one target here, so no "which
// member was clicked" ref is needed. -- --
const tagSheetOpen = ref(false)
const addToGroupSheetOpen = ref(false)
const removeFromGroupSheetOpen = ref(false)
function onTagClick(close: () => void): void {
  tagSheetOpen.value = true
  close()
}
function onAddToGroupClick(close: () => void): void {
  addToGroupSheetOpen.value = true
  close()
}
function onRemoveFromGroupClick(close: () => void): void {
  removeFromGroupSheetOpen.value = true
  close()
}

const practicesCount = computed((): number => detail.value?.practices_count ?? 0)
const hours = computed((): number => detail.value?.hours ?? 0)

const checkinRows = computed(() =>
  (detail.value?.recent_checkins ?? []).map((ci) => ({
    mood: ci.mood,
    comment: ci.comment ?? '',
    date: formatShortDate(ci.created_at),
  })),
)

const feedbackRows = computed(() =>
  (detail.value?.feedbacks ?? []).map((fb) => {
    const zone = ratingZoneFromScore(fb.rating)
    return {
      label: ratingLabelFromScore(fb.rating),
      icon: RATING_ICON[zone],
      color: RATING_ICON_COLOR[zone],
      comment: fb.comment ?? '',
      date: formatShortDate(fb.created_at),
    }
  }),
)

// Show the 3 most recent of each; the rest hide behind a «посмотреть еще» pill
// until tapped (operator, PROMPT №157). Client-side expand of the already-loaded
// (backend-capped) set — no pagination.
const PREVIEW_CAP = 3
const ciExpanded = ref(false)
const fbExpanded = ref(false)
const visibleCheckins = computed(() =>
  ciExpanded.value ? checkinRows.value : checkinRows.value.slice(0, PREVIEW_CAP),
)
const visibleFeedbacks = computed(() =>
  fbExpanded.value ? feedbackRows.value : feedbackRows.value.slice(0, PREVIEW_CAP),
)
const hiddenCheckins = computed((): number => Math.max(0, checkinRows.value.length - PREVIEW_CAP))
const hiddenFeedbacks = computed((): number => Math.max(0, feedbackRows.value.length - PREVIEW_CAP))

// "Написать сообщение" — stub (E4 messaging not delivered).
const msgOpen = ref(false)

// -- Block -> report-offer -> report form (P3, PROMPT №592) --
const toast = useToast()

const blockConfirmOpen = ref(false)
const blocking = ref(false)
async function onBlockConfirm(): Promise<void> {
  blocking.value = true
  try {
    await blockStudent(String(route.params.id))
    toast.success('Пользователь заблокирован')
    blockConfirmOpen.value = false
    // T24-20: refresh detail.blocked so the "..." menu hides and the bottom
    // button relabels itself if the master dismisses the report-offer below
    // and stays on this screen.
    await load()
    reportOfferOpen.value = true
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось заблокировать'))
  } finally {
    blocking.value = false
  }
}

const reportOfferOpen = ref(false)
function onReportOfferAccept(): void {
  reportOfferOpen.value = false
  reportFormOpen.value = true
}

const reportFormOpen = ref(false)

// -- Unblock (T24-20, PROMPT №638) -- relocated from the row's own menu
// (MasterGroupDetailView.vue, removed by T24-19) to this profile's bottom
// action. Same VConfirmDialog copy, targeting this profile's student instead
// of a clicked row.
const blockActionLabel = computed((): string =>
  detail.value?.blocked ? 'Разблокировать пользователя' : 'Заблокировать пользователя',
)
function onBlockActionClick(): void {
  if (detail.value?.blocked) unblockConfirmOpen.value = true
  else blockConfirmOpen.value = true
}

const unblockConfirmOpen = ref(false)
const unblocking = ref(false)
async function onUnblockConfirm(): Promise<void> {
  unblocking.value = true
  try {
    await unblockStudent(String(route.params.id))
    toast.success('Пользователь разблокирован')
    unblockConfirmOpen.value = false
    // Restores detail.blocked=false -- the "..." menu reappears and the
    // bottom button relabels back to "Заблокировать пользователя".
    await load()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось разблокировать'))
  } finally {
    unblocking.value = false
  }
}
</script>

<style scoped>
.profile {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

/* T24-9: horizontal at rest, rotates to vertical open -- same rotate
   mechanic as the diary's own dots override (DiaryFeedView.vue), opposite
   starting orientation (that one is vertical-at-rest / rotates horizontal).
   Same approved 500ms soft ease-out. */
.profile__dots {
  transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}

.profile__dots--open {
  transform: rotate(90deg);
}

.profile__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding). */
  padding: var(--space-4) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.profile__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

.profile__empty {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

/* -- Hero -- */
.profile__hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-5) var(--space-4);
}

.profile__hero-ava {
  width: 100px;
  height: 100px;
  font-size: var(--text-xl);
}

.profile__hero-name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

/* -- Group chips (P3, PROMPT №592) -- */
.profile__groups {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
}

/* -- Stats (VStatCard ×2: practices + hours) -- */
.profile__stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
}

/* -- Section title -- */

/* -- Check-in card -- */
.profile__ci {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
}

.profile__ci-body {
  flex: 1;
  min-width: 0;
}

.profile__ci-text {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
}

.profile__ci-date {
  font-family: var(--font-body);
  font-size: var(--text-12);
  color: var(--velo-text-secondary);
  margin-top: var(--velo-gap-2);
}

/* -- Feedback card -- */
.profile__fb {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--space-4);
}

.profile__fb-ic {
  flex-shrink: 0;
  color: var(--velo-peach-500);
  display: flex;
  align-items: center;
}

.profile__fb-body {
  flex: 1;
  min-width: 0;
}

.profile__fb-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-2);
}

.profile__fb-title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.profile__fb-date {
  font-family: var(--font-body);
  font-size: var(--text-12);
  color: var(--velo-text-secondary);
  flex-shrink: 0;
}

.profile__fb-text {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin-top: var(--velo-gap-3);
}

.profile__cta {
  margin-top: var(--space-2);
}

.profile__block-cta {
  margin-top: var(--space-2);
}

/* TargetUserCard inside the two block-flow dialogs (owner Q9, PROMPT №610). */
.profile__dialog-card {
  margin-bottom: var(--space-4);
}
</style>
