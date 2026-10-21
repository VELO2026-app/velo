<!--
  VELO Frontend -- SchoolStudentProfileView (tz-curator.md §1.11.4, owner
  decision 2026-09-22)

  A school student's profile IN THE SCHOOL CONTEXT, reached from the §1.11
  roster. BE-54's school-scoped endpoint
  (GET /masters/me/curator-groups/{id}/students/{user_id}) feeds the screen:
  display name, avatar and the attended/hours aggregates (§1.13 -- the
  recent_* arrays ride the contract but the screen does not render them
  yet). A successful load IS the curator proof (the endpoint 404s everyone
  else, P-08); what the screen adds is the action set in the header «⋯»
  menu (VMenu/VMenuItem, the §1.12.3 component rule):

    - «Написать сообщение» (SendMessageModal -- the same master->student DM
      the master zone already uses).
    - «Изменить роль» (FE-87, tz-curator.md §1.12.3): the role-choice popup
      preselected on the member's CURRENT roster role (owner decision
      2026-09-22). «Мастер» sends the school's master offer
      (offerCuratorGroupMaster, BE-59): a verified master answers yes / no,
      an unverified one is invited to get verified first; the toast is
      «Предложение отправлено». There is no admin role-request (owner
      ruling). Demotion lives on the master's public profile (MasterPublicView,
      demoteCuratorGroupMaster), not here, so a current master sees no student
      option. No optimistic changes: the roster moves server-side only.
    - «Заблокировать» (lock, owner ruling 2026-09-30): the ONLY way a
      curator ends a school membership now -- «Исключить из школы» is
      REMOVED (an exclusion no longer exists). The confirm popup is built
      (same recipe as the master-zone block dialog; the copy is a DRAFT for
      the owner's review -- BE-79 owns the final wording). Confirm sends
      POST …/members/{user_id}/block (BE-79 (2)); only the server's 204 opens
      «Пользователь заблокирован», and leaving that dialog returns to the
      roster -- the blocked person is no longer in it.

  All three are curator-of-THIS-school only (viewer.relation, §1.12.1's
  access rule). Masters of the school do NOT land here -- their rows open
  the existing public master profile.

  Domain boundary (owner 2026-09-30): a school has NO groups -- custom
  groups exist only in the master zone (the master's own CRM). None of this
  screen's actions touch the groups API, and nothing here removes a member:
  the only membership-ending action is the block above.
-->

<template>
  <div class="ssp">
    <VHeader :title="t('user.screens.schoolStudentProfile.title')" show-back @back="goBack">
      <template v-if="loaded && isCurator" #action>
        <VMenu :aria-label="t('user.screens.schoolStudentProfile.actionsAria')">
          <template #default="{ close }">
            <VMenuItem
              :icon="IconMessages"
              :ariaLabel="t('common.writeMessage')"
              @click="onMessageClick(close)"
            />
            <VMenuItem
              v-if="!masterOffer"
              :icon="IconPen"
              :ariaLabel="t('user.screens.schoolStudentProfile.role.switchCta')"
              @click="onRoleClick(close)"
            />
            <!-- The lock opens the block confirm (owner ruling 2026-09-30 --
                 blocking replaced the removed exclusion); BE-79 (2) wired it. -->
            <VMenuItem
              :icon="IconLock"
              :ariaLabel="t('common.block')"
              danger
              @click="onBlockClick(close)"
            />
          </template>
        </VMenu>
      </template>
    </VHeader>

    <div class="ssp__content">
      <!-- The masked 404 (P-08): not-curator, not-a-student, dead school --
           one answer, §1.13.5's «Ученик недоступен». -->
      <VEmptyState
        v-if="profileNotFound"
        icon="notfound"
        :title="t('user.screens.schoolStudentProfile.unavailable')"
        :description="t('user.screens.schoolStudentProfile.unavailableHint')"
      >
        <template #action>
          <VButton variant="primary" @click="goBack">{{
            t('user.screens.schoolStudentProfile.backToStudents')
          }}</VButton>
        </template>
      </VEmptyState>

      <VEmptyState
        v-else-if="profileError"
        icon="warning"
        :title="t('user.screens.schoolStudentProfile.loadFailed')"
        :description="t('user.screens.schoolStudentProfile.loadFailedHint')"
      >
        <template #action>
          <VButton variant="outline" @click="load">{{ t('common.retry') }}</VButton>
        </template>
      </VEmptyState>

      <div v-else-if="loading" class="ssp__state">
        <VLoader size="lg" />
      </div>

      <template v-else>
        <!-- Hero: the school-scoped profile's own fields (BE-54). -->
        <VCard class="ssp__hero" padding="none">
          <VAvatar :name="studentName" :url="studentAvatar" size="xl" />
          <h1 class="ssp__name">{{ studentName }}</h1>
        </VCard>

        <!-- §1.13.2: two equal cards in one row -- «Практик» / «Часов». -->
        <div class="ssp__stats">
          <VStatCard
            layout="row"
            :value="practicesLabel"
            :label="t('user.screens.schoolStudentProfile.practicesStat')"
          />
          <VStatCard
            layout="row"
            :value="hoursLabel"
            :label="t('user.screens.schoolStudentProfile.hoursStat')"
          />
        </div>
        <VCard v-if="isCurator && masterOffer" class="ssp__offer">
          <h2 class="ssp__offer-title">{{ masterOfferLabel(masterOffer) }}</h2>
          <p class="ssp__offer-text">
            {{
              masterOffer === 'awaiting_verification'
                ? t('user.screens.schoolStudentProfile.masterOffer.awaitingVerification')
                : t('user.screens.schoolStudentProfile.masterOffer.verified')
            }}
          </p>
          <p class="ssp__offer-text">
            {{ t('user.screens.schoolStudentProfile.masterOffer.awaitingNote') }}
          </p>
          <VButton variant="outline" block @click="cancelOfferOpen = true">
            {{ t('user.screens.schoolStudentProfile.masterOffer.cancel') }}
          </VButton>
        </VCard>
      </template>
    </div>

    <!-- «Изменить роль» (FE-87, tz-curator.md §1.12.3). The radio preselects
         the member's CURRENT roster role (owner decision 2026-09-22) and
         stays disabled until that lookup lands; confirming without a change
         is a disabled button, never a silent no-op request. -->
    <VModal :open="roleOpen" :show-close="false" @close="onRoleClose">
      <div class="ssp__role">
        <h2 class="ssp__role-title">{{ t('user.screens.schoolStudentProfile.role.switchCta') }}</h2>
        <TargetUserCard :name="studentName" :avatar-url="studentAvatar || null" />
        <p class="ssp__role-sub">{{ t('user.screens.schoolStudentProfile.role.chooseTitle') }}</p>
        <VRadioGroup v-model="roleKind" :options="roleOptions" :disabled="roleBusy" />
        <template v-if="kindError">
          <p class="ssp__offer-text" role="alert">
            {{ t('user.screens.schoolStudentProfile.role.checkFailed') }}
          </p>
          <VButton variant="outline" @click="resolveCurrentKind">{{ t('common.retry') }}</VButton>
        </template>
        <p v-else-if="roleKind === 'master' && currentKind === 'student'" class="ssp__offer-text">
          {{ t('user.screens.schoolStudentProfile.masterOffer.assignNote') }}
        </p>
        <div class="ssp__role-actions">
          <VButton variant="danger" block :disabled="rolePending" @click="onRoleClose">
            {{ t('ui.cancel') }}
          </VButton>
          <VButton
            variant="primary"
            block
            :loading="rolePending"
            :disabled="roleConfirmDisabled"
            @click="onRoleConfirm"
          >
            {{ t('user.screens.schoolStudentProfile.change') }}
          </VButton>
        </div>
      </div>
    </VModal>

    <VConfirmDialog
      :open="cancelOfferOpen"
      :title="t('user.screens.schoolStudentProfile.offer.cancelTitle')"
      :message="t('user.screens.schoolStudentProfile.offer.cancelText')"
      :confirm-label="t('user.screens.schoolStudentProfile.offer.cancelCta')"
      :loading="cancellingOffer"
      @confirm="onCancelOffer"
      @cancel="cancelOfferOpen = false"
    />

    <SendMessageModal
      :open="msgOpen"
      :student-id="userId"
      :name="studentName"
      @close="msgOpen = false"
    />

    <!-- Block confirm (owner ruling 2026-09-30): the ONLY membership-ending
         action. Same recipe as the master-zone block dialog (TargetUserCard +
         warning panel). Confirming sends the block; the post-block chain
         opens only on the server's 204. -->
    <VConfirmDialog
      :open="blockConfirmOpen"
      :title="t('user.screens.schoolStudentProfile.block.confirmTitle')"
      :message="blockCopy"
      :confirm-label="t('common.block')"
      danger
      warning-panel
      cancel-variant="primary"
      @confirm="onBlockConfirm"
      @cancel="blockConfirmOpen = false"
    >
      <!-- Owner 2026-09-30: the who-card needs air before the warning panel --
           VConfirmDialog spaces its own elements, slot content is on us. -->
      <div class="ssp__block-card">
        <TargetUserCard :name="studentName" :avatar-url="studentAvatar || null" />
      </div>
    </VConfirmDialog>

    <!-- Post-block report-offer -- mirrors the master-zone dialog verbatim:
         warning panel WITHOUT the icon (the kept difference from the confirm)
         + compact pills. Shown after the server's 204 (BE-79 (2)). -->
    <VConfirmDialog
      :open="blockedDialogOpen"
      :title="t('user.screens.schoolStudentProfile.toast.blocked')"
      :message="t('user.screens.schoolStudentProfile.toast.blockedHint')"
      :confirm-label="t('user.screens.schoolStudentProfile.report.cta')"
      :cancel-label="t('user.screens.schoolStudentProfile.report.dismiss')"
      compact-actions
      warning-panel
      :warning-panel-icon="false"
      danger
      cancel-variant="primary"
      @confirm="onReportOfferAccept"
      @cancel="leaveAfterBlock"
    >
      <div class="ssp__block-card">
        <TargetUserCard :name="studentName" :avatar-url="studentAvatar || null" />
      </div>
    </VConfirmDialog>

    <ReportUserSheet
      :open="reportOpen"
      :student-id="userId"
      :student-name="studentName"
      :student-avatar-url="studentAvatar || null"
      @close="onReportClose"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  getCuratorGroupMembers,
  getCuratorGroupPage,
  getCuratorGroupStudentProfile,
  offerCuratorGroupMaster,
  blockCuratorGroupMember,
  cancelCuratorGroupMasterOffer,
} from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { SchoolStudentProfileResponse } from '@/api/types'
import { masterOfferLabel } from '@/utils/masterOffers'
import { IconLock, IconMessages, IconPen } from '@/components/icons'
import {
  VAvatar,
  VButton,
  VCard,
  VConfirmDialog,
  VEmptyState,
  VLoader,
  VMenu,
  VMenuItem,
  VModal,
  VRadioGroup,
  VStatCard,
} from '@/components/ui'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import ReportUserSheet from '@/components/shared/ReportUserSheet.vue'
import TargetUserCard from '@/components/shared/TargetUserCard.vue'
import VHeader from '@/components/layout/VHeader.vue'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const groupId = computed(() => String(route.params.groupId ?? ''))
const userId = computed(() => String(route.params.userId ?? ''))

// Server truth once loaded; the roster query is only the instant-paint hint.
const studentName = computed(
  () =>
    profile.value?.display_name ??
    String(route.query.name ?? t('user.screens.schoolStudentProfile.role.student')),
)
const studentAvatar = computed(() => profile.value?.avatar_url ?? String(route.query.avatar ?? ''))

// §1.13.3: hours is server-rounded to one decimal -- format only, never
// recompute; an integral count prints without a fractional part (9 -> «9»,
// 9.5 -> «9,5»).
function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : String(hours).replace('.', ',')
}

const practicesLabel = computed(() => String(profile.value?.practices_count ?? ''))
const hoursLabel = computed(() => (profile.value ? formatHours(profile.value.hours) : ''))

const rosterRoute = computed(() => ({
  // FE-93: this screen mounts in the master zone only.
  name: 'master-curator-group-members',
  params: { id: groupId.value },
  // Back lands on the roster the row came from (the §1.11 switcher tab).
  query: { kind: 'student' },
}))

function goBack(): void {
  void router.push(rosterRoute.value)
}

const loading = ref(true)
const loaded = ref(false)
const isCurator = ref(false)
const profileNotFound = ref(false)
const profileError = ref(false)
const profile = ref<SchoolStudentProfileResponse | null>(null)
const masterOffer = computed(() => profile.value?.master_offer ?? null)
let loadVersion = 0

async function load(): Promise<void> {
  const version = ++loadVersion
  loading.value = true
  loaded.value = false
  isCurator.value = false
  profileNotFound.value = false
  profileError.value = false
  try {
    const [student, school] = await Promise.all([
      getCuratorGroupStudentProfile(groupId.value, userId.value),
      getCuratorGroupPage(groupId.value),
    ])
    if (version !== loadVersion) return
    profile.value = student
    isCurator.value = school.viewer.relation === 'curator'
    loaded.value = true
  } catch (e) {
    if (version !== loadVersion) return
    // The 404 is MASKED by design (P-08): not-curator, not-a-student and a
    // dead school are one answer -- §1.13.1's «Ученик недоступен».
    if (e instanceof ApiResponseError && e.status === 404) {
      profileNotFound.value = true
    } else {
      profileError.value = true
    }
  } finally {
    if (version === loadVersion) loading.value = false
  }
}

onMounted(() => {
  void load()
})

// Router reuse under the same record: reload for the new student.
watch([groupId, userId], () => {
  roleOpen.value = false
  cancelOfferOpen.value = false
  if (groupId.value && userId.value) void load()
})

// -- «Написать сообщение» ------------------------------------------------------

const msgOpen = ref(false)

function onMessageClick(close: () => void): void {
  close()
  msgOpen.value = true
}

// -- «Изменить роль» (FE-87, tz-curator.md §1.12.3) ----------------------------
//
// Confirming «Мастер» sends the school's master offer (offerCuratorGroupMaster,
// BE-59): a verified master answers yes / no, an unverified one is invited to
// get verified first; toast «Предложение отправлено». No admin role-request
// exists or is planned (owner ruling). NO optimistic changes: the roster
// moves server-side only.

type MemberKind = 'student' | 'master'

const roleOpen = ref(false)
const rolePending = ref(false)
const kindResolving = ref(false)
const kindError = ref(false)
const currentKind = ref<MemberKind>('student')
const roleKind = ref<MemberKind>('student')

const roleBusy = computed(() => rolePending.value || kindResolving.value)

// Demotion (master -> student) lives on the master's public profile
// (MasterPublicView, demoteCuratorGroupMaster), not on this screen: a current
// master sees only the master option, which preselects itself and keeps
// «Изменить» disabled -- the popup never offers a demotion it does not send.
const roleOptions = computed(() =>
  currentKind.value === 'master'
    ? [{ value: 'master', label: t('user.screens.schoolStudentProfile.role.master') }]
    : [
        { value: 'student', label: t('user.screens.schoolStudentProfile.role.student') },
        { value: 'master', label: t('user.screens.schoolStudentProfile.role.master') },
      ],
)

const roleConfirmDisabled = computed(
  () =>
    roleBusy.value ||
    kindError.value ||
    !!masterOffer.value ||
    roleKind.value === currentKind.value,
)

async function resolveCurrentKind(): Promise<void> {
  if (kindResolving.value) return
  kindResolving.value = true
  kindError.value = false
  try {
    // The page response carries no members; the roster is the role's source
    // of truth. The masters page is bounded (visible verified masters only),
    // but the loop still walks its pagination rather than assuming a page.
    let offset = 0
    const limit = 100
    for (;;) {
      const page = await getCuratorGroupMembers(groupId.value, {
        kind: 'master',
        limit,
        offset,
      })
      if (page.items.some((m) => m.user_id === userId.value)) {
        currentKind.value = 'master'
        return
      }
      offset += limit
      if (offset >= page.total) {
        currentKind.value = 'student'
        return
      }
    }
  } catch {
    kindError.value = true
  } finally {
    roleKind.value = currentKind.value
    kindResolving.value = false
  }
}

function onRoleClick(close: () => void): void {
  close()
  roleOpen.value = true
  void resolveCurrentKind()
}

function onRoleClose(): void {
  if (rolePending.value) return
  roleOpen.value = false
}

async function onRoleConfirm(): Promise<void> {
  if (!isCurator.value || roleConfirmDisabled.value || rolePending.value) return
  rolePending.value = true
  try {
    await offerCuratorGroupMaster(groupId.value, userId.value)
    toast.success(t('user.screens.schoolStudentProfile.toast.offerSent'))
    roleOpen.value = false
    await load()
  } catch (e) {
    toast.error(extractApiError(e, t('user.screens.schoolStudentProfile.toast.offerFailed')))
  } finally {
    rolePending.value = false
  }
}

const cancelOfferOpen = ref(false)
const cancellingOffer = ref(false)

async function onCancelOffer(): Promise<void> {
  if (!isCurator.value || !masterOffer.value || cancellingOffer.value) return
  cancellingOffer.value = true
  try {
    await cancelCuratorGroupMasterOffer(groupId.value, userId.value)
    toast.success(t('user.screens.schoolStudentProfile.toast.offerCancelled'))
    cancelOfferOpen.value = false
    await load()
  } catch (e) {
    toast.error(extractApiError(e, t('user.screens.schoolStudentProfile.toast.offerCancelFailed')))
  } finally {
    cancellingOffer.value = false
  }
}

// -- «Заблокировать» (BE-79 (2)) -------------------------------------------------
//
// Owner ruling 2026-09-30: «Исключить из школы» больше не существует --
// блокировка участника школы (пользователя ИЛИ мастера) заменяет её. The
// chain: confirm -> POST …/block -> on 204 «Пользователь заблокирован»
// (report-offer) -> back to the roster, which no longer lists the person.
// 404 (not a member any more) -> say so, back to the roster. Anything else
// (409, 403 in user mode -- the server decides by the CURRENT role, network)
// -> the error toast, stay. Shown in both zones by `isCurator`.

const blockConfirmOpen = ref(false)
const blockedDialogOpen = ref(false)
const reportOpen = ref(false)

const blockCopy = computed(() => t('user.screens.schoolStudentProfile.blockText'))

function onBlockClick(close: () => void): void {
  close()
  blockConfirmOpen.value = true
}

const blocking = ref(false)

async function onBlockConfirm(): Promise<void> {
  if (blocking.value) return
  blocking.value = true
  try {
    await blockCuratorGroupMember(groupId.value, userId.value)
    blockConfirmOpen.value = false
    blockedDialogOpen.value = true
  } catch (e) {
    blockConfirmOpen.value = false
    if (e instanceof ApiResponseError && e.status === 404) {
      toast.error(t('user.screens.schoolStudentProfile.toast.alreadyLeftSchool'))
      void router.push(rosterRoute.value)
      return
    }
    toast.error(extractApiError(e, t('user.screens.schoolStudentProfile.toast.blockFailed')))
  } finally {
    blocking.value = false
  }
}

function leaveAfterBlock(): void {
  blockedDialogOpen.value = false
  void router.push(rosterRoute.value)
}

function onReportOfferAccept(): void {
  blockedDialogOpen.value = false
  reportOpen.value = true
}

// The report sheet is reached only after a block: closing it leaves too.
function onReportClose(): void {
  reportOpen.value = false
  void router.push(rosterRoute.value)
}
</script>

<style scoped>
.ssp {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.ssp__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ssp__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* Hero: the MasterPublicView card recipe, roster-fed. */
.ssp__hero {
  padding: var(--space-5) var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-2);
}

.ssp__name {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0;
}

.ssp__stats {
  display: flex;
  gap: var(--space-3);
}

.ssp__stats > * {
  flex: 1;
}

.ssp__offer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ssp__offer-title {
  margin: 0;
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.ssp__offer-text {
  margin: 0;
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--velo-text-secondary);
}

/* «Изменить роль» popup (FE-87, §1.12.3): title / who / role picker / pills. */
.ssp__role {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ssp__role-title {
  margin: 0;
  text-align: center;
  font-family: var(--font-body);
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
}

.ssp__role-sub {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}

.ssp__role-actions {
  display: flex;
  gap: var(--space-2);
}

/* Block confirm: air between the who-card (slot content) and the warning
   panel -- VConfirmDialog spaces only its own elements. */
.ssp__block-card {
  margin-bottom: var(--space-3);
}
</style>
