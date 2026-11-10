<!--
  VELO Frontend -- SchoolPageView (schools FE-19/FE-20 / GT P3)

  ONE school page component mounted by BOTH zones (precedent: EditProfileView
  -- a user-zone view the master zone mounts directly). Member-facing blocks
  key off the SERVER's viewer.relation; the CURATOR'S MANAGEMENT blocks (the
  invite field, the edit row, the create-practice CTA, sending a transfer)
  key off relation AND zone (FE-93): relation is role-independent -- the page
  endpoint still answers relation='curator' after the owner switches to user
  -- while every masters-surface call behind those blocks answers 403 there,
  so in user mode a curator reads the page as an ordinary member (TZ 6.3).

  Data: GET /schools/{id} (page + relation + transfer) + the school's
  practices; the feed renders at most five of them and is the page's last
  element (owner 2026-09-19 -- no rosters, no journal below it).

  Zone only decides the back target (master-schools vs
  user-my-schools), read off route.name's prefix.

  The leave control for student/master
  (i18n:user.screens.schoolPage.leaveCta) lives in the header. The curator's
  page carries the edit-school row
  (i18n:user.screens.schoolPage.edit.title, the edit sheet) and the four §1.6
  nav rows; the invite / transfer-school / delete-school actions have no
  entry point on this page any more (owner 2026-09-19). The one destructive
  dialog left is leave, and it carries the ADVISORY line from the
  leave-preview; a 404
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
          {{ t('user.screens.schoolPage.leaveCta') }}
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
        :title="t('user.screens.schoolPage.notFound.title')"
        :description="t('user.screens.schoolPage.notFound.text')"
      >
        <template #action>
          <VButton variant="primary" @click="goBack">{{ t('common.backToSchools') }}</VButton>
          <!-- Review P2 / I-5: for a member of a FROZEN school every
               informative surface 404s by design (P-08) -- the page, /mine,
               the preview -- yet the exit itself is deliberately not gated on
               the school being active. This quiet secondary action is the one
               honest path left; DELETE /membership is idempotent, and for a
               mistyped or deleted id it changes nothing. -->
          <VButton variant="ghost" size="sm" :disabled="leaving" @click="onLeaveClick">
            {{ t('user.screens.schoolPage.leaveNote') }}
          </VButton>
        </template>
      </VEmptyState>
      <VEmptyState
        v-else-if="error"
        icon="warning"
        :title="t('user.screens.schoolPage.loadFailed')"
        :description="t('user.screens.schoolPage.loadFailedHint')"
      >
        <template #action>
          <VButton variant="outline" @click="load">{{ t('common.retry') }}</VButton>
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
             SchoolInviteSheet is removed, this field IS the entry. -->
        <SchoolInviteField v-if="curatorSurface" :school-id="schoolId" />

        <!-- FE-21: transfer offer banner. The ADDRESSEE (relation 'master')
             accepts/declines on the member surface -- any zone. The curator
             who SENT it only manages it from the master zone (FE-93).
             Renders nothing for everyone else. -->
        <SchoolTransferBanner
          v-if="page.transfer && (relation === 'master' || curatorSurface)"
          :transfer="page.transfer"
          :pending="null"
          :relation="relation"
          :school-id="schoolId"
          @cancelled="onTransferCancelled"
          @accepted="onTransferAccepted"
          @declined="onTransferDeclined"
        />

        <!-- §1.6: the edit-school row (i18n:user.screens.schoolPage.edit.title,
             curator, master zone -- FE-93) keeps its pencil and no chevron;
             the nav rows that follow carry NO left icons --
             only the label and the enlarged dark chevron (§1.9). Members
             (i18n:user.screens.schoolMembers.title) opens the merged roster
             screen (§1.11, curator only); the rosters no longer live on this
             page. Analytics (i18n:user.screens.schoolPage.tabs.analytics)
             opens the school's analytics screen (§6 MVP, owner 2026-10-02). -->
        <div class="cgp__actions">
          <VMenuRow
            v-if="curatorSurface"
            :label="t('user.screens.schoolPage.edit.title')"
            :show-arrow="false"
            @click="openEdit"
          >
            <template #icon><IconPen :size="20" /></template>
          </VMenuRow>

          <!-- §1.9: these carry NO left icons -- only the label and the
               enlarged dark chevron. The members row
               (i18n:user.screens.schoolPage.tabs.members) opens the merged
               roster screen with the masters/students switcher (§1.11,
               owner 2026-09-22) and is the curator's privilege -- the
               rosters are
               the curator handle on the server, everyone else reads the
               counters in the hero. The upcoming-practices row
               (i18n:user.screens.schoolPage.tabs.upcoming) opens the school-
               scoped calendar (owner 2026-10-01; was a scroll to the feed
               below); analytics (i18n:user.screens.schoolPage.tabs.analytics)
               is the honest stub until §6 ships a page. -->
          <!-- BE-76: the roster is the curator's and, in the master zone only,
               the school's masters' -- FE-93 removed the user-zone screens, so
               a curator reading the page in user mode is an ordinary member. -->
          <VMenuRow
            v-if="inMasterZone && canOpenRoster"
            class="cgp__nav-row"
            :label="t('user.screens.schoolPage.tabs.members')"
            @click="openRoster"
          />
          <VMenuRow
            class="cgp__nav-row"
            :label="t('user.screens.schoolPage.tabs.upcoming')"
            @click="openPracticesCalendar"
          />
          <VMenuRow
            v-if="inMasterZone && isCurator"
            class="cgp__nav-row"
            :label="t('user.screens.schoolPage.tabs.analytics')"
            @click="openAnalytics"
          />
        </div>

        <!-- §1.6: the page's primary CTA, curator in the master zone (the
             page payload carries no per-master creation right, so relation
             is the one honest signal -- and FE-93 keeps it out of user
             mode, where its master-route target is unreachable anyway).
             The hand-off names the school -- the create flow scopes its
             master picker to this school's masters. -->
        <VButton
          v-if="curatorSurface"
          variant="primary"
          block
          @click="
            router.push({
              name: 'master-practice-new',
              query: { schoolId },
            })
          "
        >
          {{ t('user.screens.schoolPage.createPractice') }}
        </VButton>

        <!-- §1.6 item 7 + owner 2026-09-19: the nearest-practices section
             (i18n:user.screens.schoolPage.tabs.upcoming2) is the
             page's LAST element -- nothing renders below it -- and shows at
             most five upcoming school practices. The existing practice-card
             canon, no school-only variant. -->
        <h2 class="velo-section-title cgp__section">
          {{ t('user.screens.schoolPage.tabs.upcoming2') }}
        </h2>
        <template v-if="upcomingPractices.length">
          <CalendarPracticeCard
            v-for="p in upcomingPractices"
            :key="p.id"
            :practice="p"
            show-date
            @click="router.push({ name: 'practice-detail', params: { id: $event } })"
          />
        </template>
        <!-- No empty claim while the feed is still loading: "no upcoming
             practices" is said only by an answer that has none. A failed
             feed says so (i18n:common.loadError) instead of claiming an
             empty school. -->
        <VEmptyState
          v-else-if="feedState === 'ready'"
          variant="note"
          :title="t('user.screens.schoolPage.noUpcoming')"
        />
        <VEmptyState
          v-else-if="feedState === 'failed'"
          variant="note"
          :title="t('common.loadError')"
        />
      </template>
    </div>

    <!-- Edit school (curator): name + description + avatar link, the same
         sheet shape MasterGroupDetailView's rename uses. -->
    <VBottomSheet
      :open="editOpen"
      :title="t('user.screens.schoolPage.edit.nameAndDescription')"
      compact-title
      :save-label="t('ui.save')"
      :save-disabled="!editName.trim()"
      @save="onEditSave"
      @close="editOpen = false"
    >
      <VInput
        v-model="editName"
        :label="t('user.screens.schoolPage.fields.name')"
        :placeholder="t('user.screens.schoolPage.fields.namePlaceholder')"
      />
      <VTextarea
        v-model="editDescription"
        :label="t('user.screens.schoolPage.edit.description')"
        :placeholder="t('user.screens.schoolPage.edit.descriptionPlaceholder')"
        :rows="3"
        autogrow
      />
      <!-- BE-20: the avatar is a URL, not an upload (no file storage in the
           platform). Left empty on a school that HAS one, it means "remove";
           the server stores the link normalized, and the save surface shows
           the saved-as toast (i18n:user.screens.schoolPage.toast.avatarSaved)
           when it round-trips differently. -->
      <VInput
        v-model="editAvatar"
        :label="t('user.screens.schoolPage.edit.avatarLink')"
        placeholder="https://example.com/school.png"
        inputmode="url"
      />
      <p class="cgp__edit-hint">
        {{ t('user.screens.schoolPage.imageHint') }}
      </p>
    </VBottomSheet>

    <!-- Leave confirm (student/master): advisory from leave-preview. -->
    <VConfirmDialog
      :open="leaveConfirmOpen"
      :title="t('user.screens.schoolPage.leave.confirmTitle')"
      :message="leaveMessage"
      :confirm-label="t('user.screens.schoolPage.leave.confirmCta')"
      danger
      :loading="leaving"
      @confirm="onLeaveConfirm"
      @close="leaveConfirmOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  getSchoolLeavePreview,
  getSchoolPage,
  getSchoolPractices,
  leaveSchool,
  updateSchool,
} from '@/api/schools'
import { ApiResponseError } from '@/api/client'
import type { SchoolPageResponse, PracticeResponse } from '@/api/types'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import CalendarPracticeCard from '@/components/shared/CalendarPracticeCard.vue'
import SchoolTransferBanner from '@/components/shared/SchoolTransferBanner.vue'
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

const schoolId = computed(() => String(route.params.id ?? ''))

/** The zone decides only the back target -- the action set comes from the
 *  server's viewer.relation, so both zones mount this same component. */
const inMasterZone = computed(() => String(route.name ?? '').startsWith('master'))
const listRoute = computed(() => ({
  name: inMasterZone.value ? 'master-schools' : 'user-my-schools',
}))

function goBack(): void {
  void router.push(listRoute.value)
}

// -- Page state --

const loading = ref(true)
const error = ref(false)
const notFound = ref(false)
const page = ref<SchoolPageResponse | null>(null)
const practices = ref<PracticeResponse[]>([])
/** The practices feed loads apart from the header: its own lifecycle. */
const feedState = ref<'loading' | 'ready' | 'failed'>('loading')

const relation = computed(() => page.value?.viewer.relation ?? null)
const isCurator = computed(() => relation.value === 'curator')
/** FE-93: the curator's management blocks are the master zone's privilege.
 *  Relation alone is not the gate -- it survives a switch to user mode, but
 *  every call behind these blocks goes to the masters surface, which answers
 *  403 there; in user mode a curator is an ordinary member. */
const curatorSurface = computed(() => isCurator.value && inMasterZone.value)
/** Who sees the members screen (i18n:user.screens.schoolMembers.title,
 *  BE-76): the curator, and a master of the school in the master zone. The
 *  server enforces the same split on GET .../roster. */
const canOpenRoster = computed(
  () => isCurator.value || (relation.value === 'master' && inMasterZone.value),
)

// Owner 2026-10-05: the header carries ONLY the school's name (was the
// School-prefixed name composite of the §1.6/§1.10 mockup).
// field.schoolFallback is the pre-load fallback.
const pageTitle = computed(
  () => page.value?.name ?? t('user.screens.schoolPage.field.schoolFallback'),
)

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

// Owner 2026-10-01: the upcoming-practices row
// (i18n:user.screens.schoolPage.tabs.upcoming) opens the school-scoped calendar
// (user-calendar-school) -- the school's full upcoming list on the week grid,
// not the five-card preview below. The preview stays: it is the page's last
// element (§1.6 item 7). The route's param is :schoolId -- pushing it as :id
// rejects the navigation with "Missing required param" (silent under `void`).
function openPracticesCalendar(): void {
  void router.push({
    name: 'user-calendar-school',
    params: { schoolId: schoolId.value },
  })
}

// Owner 2026-09-19: at most FIVE upcoming school practices render, and the
// feed is the page's last element. The page asks the API for exactly five
// (the first five of all pages equal the first five of page one); the slice
// below is a defensive cap.
const FEED_LIMIT = 5
const upcomingPractices = computed(() => practices.value.slice(0, FEED_LIMIT))

// §6 MVP (owner 2026-10-02): the school's analytics screen. FE-93: it mounts
// in the master zone only -- the user zone has no route for it anymore.
function openAnalytics(): void {
  void router.push({
    name: 'master-school-analytics',
    params: { id: schoolId.value },
  })
}

// §1.11 (owner 2026-09-22): the merged participants screen; FE-93: master
// zone only, same as the analytics row above.
function openRoster(): void {
  void router.push({
    name: 'master-school-members',
    params: { id: schoolId.value },
  })
}

// FE-78.4: see load() -- bumps on every load attempt; a stale answer is a no-op.
let loadEpoch = 0

async function load(): Promise<void> {
  // FE-78.4: route reuse under the same record -- a slow answer for the
  // PREVIOUS school must never repaint the current one. Every state write
  // below is guarded by the epoch; a superseded load becomes a no-op
  // (same pattern as SchoolStudentProfileView's loadVersion).
  const epoch = ++loadEpoch
  loading.value = true
  error.value = false
  notFound.value = false
  practices.value = []
  feedState.value = 'loading'
  // Both requests leave together; the header paints as soon as the page
  // payload lands and the practices feed fills in when its answer does.
  // The feed is a bonus under the header: its failure marks the feed only
  // instead of replacing the whole page with the error state.
  void getSchoolPractices(schoolId.value, FEED_LIMIT, 0)
    .then((res) => {
      if (epoch !== loadEpoch) return
      practices.value = res.items
      feedState.value = 'ready'
    })
    .catch(() => {
      if (epoch === loadEpoch) feedState.value = 'failed'
    })
  try {
    const pageRes = await getSchoolPage(schoolId.value)
    if (epoch !== loadEpoch) return
    page.value = pageRes
  } catch (e) {
    if (epoch !== loadEpoch) return
    if (e instanceof ApiResponseError && e.status === 404) {
      notFound.value = true
    } else {
      error.value = true
    }
  } finally {
    if (epoch === loadEpoch) loading.value = false
  }
}

onMounted(load)
// Remount data if the same component instance is reused for another id.
watch(schoolId, () => {
  if (schoolId.value) void load()
})

// -- Advisory preview (the leave dialog) -------------------------------------

//
// The *-preview endpoints are ADVISORIES, not gates: a 404 means "no advice"
// (a frozen school answers 404 while leave still works, I-5) and any other
// failure means the same -- the number is a bonus line in a dialog, never a
// reason to block the action.

async function advisoryCount(
  fetch: () => Promise<{ upcoming_practices_targeting_school: number }>,
): Promise<number | null> {
  try {
    const res = await fetch()
    return res.upcoming_practices_targeting_school
  } catch {
    return null
  }
}

function advisoryLine(count: number | null): string {
  // 0 -> no line at all (nothing would change -- saying so is noise).
  if (count === null || count === 0) return ''
  // hiddenCount is a CLDR pipe key: the whole sentence agrees per form
  // (the Russian wording changes with the count), so no noun-fragment
  // threading is needed.
  // The joining space lives here, not in the catalog (no leading-space values).
  return ` ${t('user.screens.schoolPage.hiddenCount', count)}`
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
    return t('user.screens.schoolPage.leave.warning')
  }
  return t('user.screens.schoolPage.leaveText', {
    name: page.value?.name ?? '',
    advisory: advisoryLine(leaveAdvisory.value),
  })
})

function onLeaveClick(): void {
  leaveAdvisory.value = null
  leaveConfirmOpen.value = true
  // Lazy: only fetched when the dialog actually opens.
  void advisoryCount(() => getSchoolLeavePreview(schoolId.value)).then((n) => {
    leaveAdvisory.value = n
  })
}

async function onLeaveConfirm(): Promise<void> {
  leaving.value = true
  try {
    await leaveSchool(schoolId.value)
    leaveConfirmOpen.value = false
    toast.success(t('user.screens.schoolPage.toast.left'))
    void router.replace(listRoute.value)
  } catch (e) {
    toast.error(extractApiError(e, t('user.screens.schoolPage.toast.leaveFailed')))
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

/** Shared by the ⋯ menu item and the §1.6 edit-school row
 *  (i18n:user.screens.schoolPage.edit.title). */
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
    const res = await updateSchool(schoolId.value, name, desc === '' ? null : desc, avatar)
    // PATCH answers with the CURATOR's own row (SchoolResponse -- no
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
    toast.success(t('user.screens.schoolPage.toast.updated'))
    // §12 trap: the server stores the URL NORMALIZED (lowercase host,
    // trailing slash, punycode) -- what returns is not what was typed, and
    // a silent difference reads as "the link got corrupted". Say it.
    if (typeof avatar === 'string' && (res.avatar_url ?? '') !== avatar && res.avatar_url) {
      toast.info(t('user.screens.schoolPage.toast.avatarSaved', { url: res.avatar_url }))
    }
  } catch (e) {
    toast.error(extractApiError(e, t('user.screens.schoolPage.toast.updateFailed')))
  } finally {
    saving.value = false
  }
}

// -- Invites (curator) --

// -- Transfer (FE-21) --

function onTransferCancelled(): void {
  if (page.value) page.value = { ...page.value, transfer: null }
}

function onTransferAccepted(newPage: SchoolPageResponse): void {
  // The accept response IS the page as the new curator sees it -- replace
  // local state wholesale (relation flips, no reload).
  page.value = newPage
  toast.success(t('user.screens.schoolPage.toast.transferredToYou'))
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
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-2);
}
</style>
