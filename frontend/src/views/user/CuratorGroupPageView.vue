<!--
  VELO Frontend -- CuratorGroupPageView (schools FE-19/FE-20 / GT P3)

  ONE school page component mounted by BOTH zones (precedent: EditProfileView
  -- a user-zone view the master zone mounts directly). Everything that
  differs between the three viewers keys off the SERVER's viewer.relation,
  never off the zone: a master-zone curator and a user-zone student see the
  same component with a different action set (TZ 6.3).

  Data: GET /curator-groups/{id} (page + relation + transfer) + the school's
  practices; the feed renders at most five of them and is the page's last
  element (owner 2026-09-19 -- no rosters, no journal below it).

  Zone only decides the back target (master-curator-groups vs
  user-curator-groups), read off route.name's prefix.

  «Покинуть школу» for student/master lives in the header. The curator's
  page carries «Редактировать школу» (the edit sheet) and the four §1.6 nav
  rows; Пригласить / Передать школу / Удалить школу have no entry point on
  this page any more (owner 2026-09-19). The one destructive dialog left is
  покинуть, and it carries the ADVISORY line from the leave-preview; a 404
  on a preview means "no advisory" (frozen school -- leave still works,
  I-5), never an error and never a blocked button.
-->

<template>
  <div class="cgp">
    <VHeader :title="pageTitle" show-back @back="goBack">
      <template #action>
        <!-- Student / master: the exit action. A plain button, NOT a dropdown
             -- the owner removed the «⋯» header menu entirely (2026-09-19). -->
        <VButton
          v-if="relation && !isCurator"
          variant="ghost"
          size="sm"
          :disabled="leaving"
          @click="onLeaveClick"
        >
          Покинуть школу
        </VButton>
      </template>
    </VHeader>

    <div class="cgp__content">
      <!-- Loading -->
      <div v-if="loading" class="cgp__state">
        <VLoader size="lg" />
      </div>

      <!-- 404 / transient -->
      <VEmptyState
        v-else-if="notFound"
        icon="notfound"
        title="Школа не найдена"
        description="Возможно, она была удалена или вы в ней не состоите."
      >
        <template #action>
          <VButton variant="primary" @click="goBack">К моим школам</VButton>
          <!-- Review P2 / I-5: for a member of a FROZEN school every
               informative surface 404s by design (P-08) -- the page, /mine,
               the preview -- yet the exit itself is deliberately not gated on
               the school being active. This quiet secondary action is the one
               honest path left; DELETE /membership is idempotent, and for a
               mistyped or deleted id it changes nothing. -->
          <VButton variant="ghost" size="sm" :disabled="leaving" @click="onLeaveClick">
            Я состою в этой школе — покинуть её
          </VButton>
        </template>
      </VEmptyState>
      <VEmptyState
        v-else-if="error"
        icon="warning"
        title="Не удалось загрузить школу"
        description="Проверьте соединение и попробуйте ещё раз."
      >
        <template #action>
          <VButton variant="outline" @click="load">Повторить</VButton>
        </template>
      </VEmptyState>

      <template v-else-if="page">
        <!-- §1.6/§1.10: the hero is ONE composite (banner strip, square logo
             on the seam, centred name + counters, description as the interim
             copy). No avatar stack (§1.8). -->
        <SchoolHeroCard
          :name="page.name"
          :avatar-url="page.avatar_url"
          :students-count="page.students_count"
          :masters-count="page.masters_count"
          :description="page.description"
          :hash="brandingHash"
        />

        <!-- §1.6 (owner 2026-09-22): the school's reusable invite link lives
             INLINE under the hero -- minted on mount (idempotent get-or-get),
             copied to the clipboard, rotated behind a confirm. Curator only:
             the invite is the curator's handle. This reverses the 2026-09-19
             "the invite has no entry point on this page" note -- the orphaned
             CuratorGroupInviteSheet is removed, this field IS the entry. -->
        <SchoolInviteField v-if="isCurator" :group-id="groupId" />

        <!-- FE-21: transfer offer banner (curator sees "sent", addressee
             sees accept/decline). Renders nothing for everyone else. -->
        <CuratorGroupTransferBanner
          v-if="page.transfer"
          :transfer="page.transfer"
          :pending="null"
          :relation="relation"
          :group-id="groupId"
          @cancelled="onTransferCancelled"
          @accepted="onTransferAccepted"
          @declined="onTransferDeclined"
        />

        <!-- §1.6: «Редактировать школу» (curator only) keeps its pencil and
             no chevron; the nav rows that follow carry NO left icons --
             only the label and the enlarged dark chevron (§1.9). «Участники»
             opens the merged roster screen (§1.11, curator only); the
             rosters no longer live on this page, and «Аналитика» stays
             fully hidden behind its flag until §6, never shown disabled. -->
        <div class="cgp__actions">
          <VMenuRow
            v-if="isCurator"
            label="Редактировать школу"
            :show-arrow="false"
            @click="openEdit"
          >
            <template #icon><IconPen :size="20" /></template>
          </VMenuRow>

          <!-- §1.9: these carry NO left icons -- only the label and the
               enlarged dark chevron. «Участники» opens the merged roster
               screen with the Мастера/Ученики switcher (§1.11, owner
               2026-09-22) and is the curator's privilege -- the rosters are
               the curator handle on the server, everyone else reads the
               counters in the hero. «Предстоящие практики» scrolls to the
               feed below; «Аналитика» is the honest stub until §6 ships a
               page. -->
          <VMenuRow v-if="isCurator" class="cgp__nav-row" label="Участники" @click="openRoster" />
          <VMenuRow class="cgp__nav-row" label="Предстоящие практики" @click="scrollToPractices" />
          <VMenuRow
            v-if="isCurator"
            class="cgp__nav-row"
            label="Аналитика"
            @click="onAnalyticsClick"
          />
        </div>

        <!-- §1.6: the page's primary CTA, curator only (the page payload
             carries no per-master creation right, so relation is the one
             honest signal). The hand-off names the school -- the create
             flow scopes its master picker to this school's masters. -->
        <VButton
          v-if="isCurator"
          variant="primary"
          block
          @click="
            router.push({
              name: 'master-practice-new',
              query: { groupId },
            })
          "
        >
          Создать практику
        </VButton>

        <!-- §1.6 item 7 + owner 2026-09-19: «Ближайшие практики» is the
             page's LAST element -- nothing renders below it -- and shows at
             most five upcoming school practices. The existing practice-card
             canon, no school-only variant. -->
        <h2 ref="practicesSection" class="velo-section-title cgp__section">Ближайшие практики</h2>
        <template v-if="upcomingPractices.length">
          <CalendarPracticeCard
            v-for="p in upcomingPractices"
            :key="p.id"
            :practice="p"
            show-date
            @click="router.push({ name: 'practice-detail', params: { id: $event } })"
          />
        </template>
        <VEmptyState v-else variant="note" title="Ближайших практик нет" />
      </template>
    </div>

    <!-- Edit school (curator): name + description + avatar link, the same
         sheet shape MasterGroupDetailView's rename uses. -->
    <VBottomSheet
      :open="editOpen"
      title="Изменить название и описание"
      compact-title
      save-label="Сохранить"
      :save-disabled="!editName.trim()"
      @save="onEditSave"
      @close="editOpen = false"
    >
      <VInput v-model="editName" label="Название" placeholder="Название" />
      <VTextarea
        v-model="editDescription"
        label="Описание"
        placeholder="Описание"
        :rows="3"
        autogrow
      />
      <!-- BE-20: the avatar is a URL, not an upload (no file storage in the
           platform). Left empty on a school that HAS one, it means "remove";
           the server stores the link normalized, and the save surface shows
           «сохранено как …» when it round-trips differently. -->
      <VInput
        v-model="editAvatar"
        label="Ссылка на аватар"
        placeholder="https://example.com/school.png"
        inputmode="url"
      />
      <p class="cgp__edit-hint">
        Ссылка на картинку школы. Оставьте поле пустым, чтобы убрать аватар.
      </p>
    </VBottomSheet>

    <!-- Leave confirm (student/master): advisory from leave-preview. -->
    <VConfirmDialog
      :open="leaveConfirmOpen"
      title="Покинуть школу?"
      :message="leaveMessage"
      confirm-label="Покинуть"
      danger
      :loading="leaving"
      @confirm="onLeaveConfirm"
      @close="leaveConfirmOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  getCuratorGroupLeavePreview,
  getCuratorGroupPage,
  getCuratorGroupPractices,
  leaveCuratorGroup,
  updateCuratorGroup,
} from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { CuratorGroupPageResponse, PracticeResponse } from '@/api/types'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import CalendarPracticeCard from '@/components/shared/CalendarPracticeCard.vue'
import CuratorGroupTransferBanner from '@/components/shared/CuratorGroupTransferBanner.vue'
import SchoolHeroCard from '@/components/shared/SchoolHeroCard.vue'
import SchoolInviteField from '@/components/shared/SchoolInviteField.vue'
import { schoolHashFromName } from '@/utils/schoolBranding'
import { IconPen } from '@/components/icons'
import { VBottomSheet, VButton, VConfirmDialog, VEmptyState, VMenuRow } from '@/components/ui'
import VHeader from '@/components/layout/VHeader.vue'
import { VInput, VLoader, VTextarea } from '@/components/ui'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const groupId = computed(() => String(route.params.id ?? ''))

/** The zone decides only the back target -- the action set comes from the
 *  server's viewer.relation, so both zones mount this same component. */
const inMasterZone = computed(() => String(route.name ?? '').startsWith('master'))
const listRoute = computed(() => ({
  name: inMasterZone.value ? 'master-curator-groups' : 'user-curator-groups',
}))

function goBack(): void {
  void router.push(listRoute.value)
}

// -- Page state --

const loading = ref(true)
const error = ref(false)
const notFound = ref(false)
const page = ref<CuratorGroupPageResponse | null>(null)
const practices = ref<PracticeResponse[]>([])

const relation = computed(() => page.value?.viewer.relation ?? null)
const isCurator = computed(() => relation.value === 'curator')

// §1.6/§1.10: the header reads «Школа «{name}»», per the mockup.
const pageTitle = computed(() => (page.value ? `Школа «${page.value.name}»` : 'Школа'))

// §5.2: the payload carries no branding_hash yet -- variant A, the client
// derives it from the name. When the server field lands, this watch is the
// only place to switch.
const brandingHash = ref<string | null>(null)
watch(
  () => page.value?.name,
  (name) => {
    brandingHash.value = null
    if (name) {
      void schoolHashFromName(name).then((h) => {
        brandingHash.value = h
      })
    }
  },
  { immediate: true },
)

// «Предстоящие практики» scrolls to the feed below the fold. Optional call:
// happy-dom and older engines may lack the API.
const practicesSection = ref<HTMLElement | null>(null)

function scrollToPractices(): void {
  practicesSection.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

// Owner 2026-09-19: at most FIVE upcoming school practices render, and the
// feed is the page's last element. The fetch itself stays whole-list (the
// API contract is untouched); the cap is presentation-only.
const upcomingPractices = computed(() => practices.value.slice(0, 5))

// §6 (school analytics) is blocked on the metrics spec -- there is no page to
// navigate to yet, so the row the owner asked for says so honestly instead of
// pretending (a dead link or a fake page would both be worse).
function onAnalyticsClick(): void {
  toast.info('Аналитика школы появится позже')
}

// §1.11 (owner 2026-09-22): the merged participants screen; the zone picks
// the route family exactly like the back target above.
function openRoster(): void {
  void router.push({
    name: inMasterZone.value ? 'master-curator-group-members' : 'user-curator-group-members',
    params: { id: groupId.value },
  })
}

// Review P2: the school endpoints are paginated (limit 20). A single first
// page hid rows 21+ -- a master beyond the picker for transfer/removal,
// practices beyond the feed. Load ALL pages, with an honest stop: 10 pages
// (200 rows) is beyond any real school and protects against a lying total.
const PAGE = 20
const MAX_PAGES = 10

async function fetchAllPages<T>(
  fetchPage: (offset: number) => Promise<{ items: T[]; total: number }>,
): Promise<T[]> {
  const first = await fetchPage(0)
  const out = [...first.items]
  const pages = Math.ceil(first.total / PAGE)
  for (let p = 1; p < Math.min(pages, MAX_PAGES); p++) {
    const res = await fetchPage(p * PAGE)
    if (!res.items.length) break
    out.push(...res.items)
  }
  return out
}

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  notFound.value = false
  try {
    const [pageRes, practicesItems] = await Promise.all([
      getCuratorGroupPage(groupId.value),
      fetchAllPages((offset) => getCuratorGroupPractices(groupId.value, PAGE, offset)),
    ])
    page.value = pageRes
    practices.value = practicesItems
  } catch (e) {
    if (e instanceof ApiResponseError && e.status === 404) {
      notFound.value = true
    } else {
      error.value = true
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)
// Remount data if the same component instance is reused for another id.
watch(groupId, () => {
  if (groupId.value) void load()
})

// -- Advisory preview (the leave dialog) -------------------------------------

//
// The *-preview endpoints are ADVISORIES, not gates: a 404 means "no advice"
// (a frozen school answers 404 while leave still works, I-5) and any other
// failure means the same -- the number is a bonus line in a dialog, never a
// reason to block the action.

async function advisoryCount(
  fetch: () => Promise<{ upcoming_practices_targeting_group: number }>,
): Promise<number | null> {
  try {
    const res = await fetch()
    return res.upcoming_practices_targeting_group
  } catch {
    return null
  }
}

function advisoryLine(count: number | null): string {
  // 0 -> no line at all (nothing would change -- saying so is noise).
  if (count === null || count === 0) return ''
  const word = count === 1 ? 'практика' : count < 5 ? 'практики' : 'практик'
  return ` ${count} предстоящих ${word} для этой школы станут скрыты.`
}

// -- Leave (student / master) --

const leaveConfirmOpen = ref(false)
const leaveAdvisory = ref<number | null>(null)
const leaving = ref(false)

const leaveMessage = computed(() => {
  // The frozen-school case (review P2): every informative surface 404s for a
  // member of an inactive school by design (P-08) -- I-5 still guarantees the
  // exit itself works, so the not-found screen carries the one honest path.
  if (notFound.value) {
    return 'Если вы состоите в этой школе, вы выйдете из неё. Выход работает, даже если школа сейчас не активна.'
  }
  return `Вы покинете школу «${page.value?.name ?? ''}».${advisoryLine(leaveAdvisory.value)}`
})

function onLeaveClick(): void {
  leaveAdvisory.value = null
  leaveConfirmOpen.value = true
  // Lazy: only fetched when the dialog actually opens.
  void advisoryCount(() => getCuratorGroupLeavePreview(groupId.value)).then((n) => {
    leaveAdvisory.value = n
  })
}

async function onLeaveConfirm(): Promise<void> {
  leaving.value = true
  try {
    await leaveCuratorGroup(groupId.value)
    leaveConfirmOpen.value = false
    toast.success('Вы покинули школу')
    void router.replace(listRoute.value)
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось покинуть школу'))
  } finally {
    leaving.value = false
  }
}

// -- Edit school (curator) --

const editOpen = ref(false)
const editName = ref('')
const editDescription = ref('')
/** BE-20: the avatar LINK. '' in a school that has one means "remove" (an
 *  edit sheet always states every field, so blank is a statement, not an
 *  absence); in a school that has none it means "still none" -- the key is
 *  simply not sent. */
const editAvatar = ref('')
const saving = ref(false)

/** Shared by the «⋯» menu item and the §1.6 «Редактировать школу» row. */
function openEdit(): void {
  editName.value = page.value?.name ?? ''
  editDescription.value = page.value?.description ?? ''
  editAvatar.value = page.value?.avatar_url ?? ''
  editOpen.value = true
}

async function onEditSave(): Promise<void> {
  const name = editName.value.trim()
  if (!name) return
  saving.value = true
  try {
    // Empty description means "clear it": null is the explicit clear, never
    // an absent key (an edit dialog always states both fields).
    const desc = editDescription.value.trim()
    const avatarInput = editAvatar.value.trim()
    const hadAvatar = !!page.value?.avatar_url
    const avatar: string | null | undefined =
      avatarInput !== '' ? avatarInput : hadAvatar ? null : undefined
    const res = await updateCuratorGroup(groupId.value, name, desc === '' ? null : desc, avatar)
    // PATCH answers with the CURATOR's own row (CuratorGroupResponse -- no
    // viewer/curator fields), so merge the renamed fields into the page
    // instead of replacing it; res.transfer carries the pending offer along
    // (an intended widening, see that schema's own docstring).
    if (page.value) {
      page.value = {
        ...page.value,
        name: res.name,
        description: res.description,
        avatar_url: res.avatar_url ?? null,
        transfer: res.transfer ?? null,
      }
    }
    editOpen.value = false
    toast.success('Школа обновлена')
    // §12 trap: the server stores the URL NORMALIZED (lowercase host,
    // trailing slash, punycode) -- what returns is not what was typed, and
    // a silent difference reads as "the link got corrupted". Say it.
    if (typeof avatar === 'string' && (res.avatar_url ?? '') !== avatar && res.avatar_url) {
      toast.info(`Ссылка на аватар сохранена как ${res.avatar_url}`)
    }
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось обновить школу'))
  } finally {
    saving.value = false
  }
}

// -- Invites (curator) --

// -- Transfer (FE-21) --

function onTransferCancelled(): void {
  if (page.value) page.value = { ...page.value, transfer: null }
}

function onTransferAccepted(newPage: CuratorGroupPageResponse): void {
  // The accept response IS the page as the new curator sees it -- replace
  // local state wholesale (relation flips, no reload).
  page.value = newPage
  toast.success('Школа передана вам')
}

function onTransferDeclined(): void {
  if (page.value) page.value = { ...page.value, transfer: null }
}
</script>

<style scoped>
.cgp {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.cgp__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.cgp__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* §1.6/§1.10: the action cluster (edit row + the four nav rows) and the
   nav-row treatment -- no left icons, bold label, one enlarged dark chevron. */
.cgp__actions {
  display: grid;
  gap: var(--space-2);
}

.cgp__nav-row :deep(.v-menu-row__icon) {
  display: none;
}

.cgp__nav-row :deep(.v-menu-row__text) {
  font-weight: 600;
}

.cgp__nav-row :deep(.v-menu-row__arrow) {
  color: var(--velo-text-primary);
  transform: scale(1.35);
  transform-origin: center;
}

.cgp__section {
  margin-top: var(--space-4);
}

/* The avatar-link hint inside the edit sheet (BE-20). */
.cgp__edit-hint {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-2);
}
</style>
