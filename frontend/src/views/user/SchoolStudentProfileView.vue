<!--
  VELO Frontend -- SchoolStudentProfileView (tz-curator.md §1.11.4, owner
  decision 2026-09-22)

  A school student's profile IN THE SCHOOL CONTEXT, reached from the §1.11
  roster. The roster row is the safe contract (name, avatar) the hero renders
  from; BE-54 has since added the school-scoped profile endpoint
  (GET /masters/me/curator-groups/{id}/students/{user_id}, types already in
  generated.ts) -- wiring it in is FE-86's slice, this screen does not call
  it yet. What the screen adds is the curator's action set, living in the
  header «⋯» menu (VMenu/VMenuItem, the §1.12.3 component rule):

    - «Написать сообщение» (SendMessageModal -- the same master->student DM
      the master zone already uses).
    - «Изменить роль» (FE-87, tz-curator.md §1.12.3): the role-choice popup
      preselected on the member's CURRENT roster role (owner decision
      2026-09-22). INTERIM (stopper BE-59): confirming still sends the
      GT-27 master-offer; it becomes the admin role-request (and the toast
      becomes «Отправлено на согласование администратору») the moment
      BE-59's /role-requests contract and generated types land. Demotion
      has no contract yet (§7.1 №6), so a current master sees no student
      option at all. No optimistic changes either way: the roster moves
      server-side only.
    - «Заблокировать» (lock, owner ruling 2026-09-30): the ONLY way a
      curator ends a school membership now -- «Исключить из школы» is
      REMOVED (an exclusion no longer exists). The confirm popup is built
      (same recipe as the master-zone block dialog; the copy is a DRAFT for
      the owner's review -- BE-79 owns the final wording). INTERIM (stopper
      BE-79): the school-block contract does not exist, so confirm is a
      marked no-op (info toast) -- BE-79 swaps it for the real request.

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
    <VHeader title="Ученик" show-back @back="goBack">
      <template v-if="isCurator && loaded" #action>
        <VMenu aria-label="Действия с учеником">
          <template #default="{ close }">
            <VMenuItem
              :icon="IconMessages"
              ariaLabel="Написать сообщение"
              @click="onMessageClick(close)"
            />
            <VMenuItem :icon="IconPen" ariaLabel="Изменить роль" @click="onRoleClick(close)" />
            <!-- The lock is live: it opens the block confirm (owner ruling
                 2026-09-30 -- blocking replaced the removed exclusion).
                 INTERIM (stopper BE-79): confirm is a marked no-op. -->
            <VMenuItem
              :icon="IconLock"
              ariaLabel="Заблокировать"
              danger
              @click="onBlockClick(close)"
            />
          </template>
        </VMenu>
      </template>
    </VHeader>

    <div class="ssp__content">
      <!-- The school context is gone or not ours (P-08 masking). -->
      <VEmptyState
        v-if="schoolNotFound"
        icon="notfound"
        title="Школа недоступна"
        description="Возможно, она была удалена или вы в ней не состоите."
      >
        <template #action>
          <VButton variant="primary" @click="goBack">К списку учеников</VButton>
        </template>
      </VEmptyState>

      <VEmptyState
        v-else-if="schoolError"
        icon="warning"
        title="Не удалось загрузить школу"
        description="Проверьте соединение и попробуйте ещё раз."
      >
        <template #action>
          <VButton variant="outline" @click="load">Повторить</VButton>
        </template>
      </VEmptyState>

      <div v-else-if="loading" class="ssp__state">
        <VLoader size="lg" />
      </div>

      <template v-else>
        <!-- Hero: the roster row's own safe fields. -->
        <VCard class="ssp__hero" padding="none">
          <VAvatar :name="studentName" :url="studentAvatar" size="xl" />
          <h1 class="ssp__name">{{ studentName }}</h1>
        </VCard>
      </template>
    </div>

    <!-- «Изменить роль» (FE-87, tz-curator.md §1.12.3). The radio preselects
         the member's CURRENT roster role (owner decision 2026-09-22) and
         stays disabled until that lookup lands; confirming without a change
         is a disabled button, never a silent no-op request. -->
    <VModal :open="roleOpen" :show-close="false" @close="onRoleClose">
      <div class="ssp__role">
        <h2 class="ssp__role-title">Изменить роль</h2>
        <TargetUserCard :name="studentName" :avatar-url="studentAvatar || null" />
        <p class="ssp__role-sub">Выберите роль</p>
        <VRadioGroup v-model="roleKind" :options="roleOptions" :disabled="roleBusy" />
        <div class="ssp__role-actions">
          <VButton variant="danger" block :disabled="rolePending" @click="onRoleClose">
            Отмена
          </VButton>
          <VButton
            variant="primary"
            block
            :loading="rolePending"
            :disabled="roleConfirmDisabled"
            @click="onRoleConfirm"
          >
            Изменить
          </VButton>
        </div>
      </div>
    </VModal>

    <SendMessageModal
      :open="msgOpen"
      :student-id="userId"
      :name="studentName"
      @close="msgOpen = false"
    />

    <!-- Block confirm (owner ruling 2026-09-30): the ONLY membership-ending
         action. Same recipe as the master-zone block dialog (TargetUserCard +
         warning panel). Confirming steps into the post-block chain -- the UX
         draft under review (nothing mutates until BE-79). -->
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
      <!-- Owner 2026-09-30: the who-card needs air before the warning panel --
           VConfirmDialog spaces its own elements, slot content is on us. -->
      <div class="ssp__block-card">
        <TargetUserCard :name="studentName" :avatar-url="studentAvatar || null" />
      </div>
    </VConfirmDialog>

    <!-- Post-block report-offer -- mirrors the master-zone dialog verbatim:
         warning panel WITHOUT the icon (the kept difference from the confirm)
         + compact pills. INTERIM (stopper BE-79): nothing mutated -- this
         step is the UX draft under review. -->
    <VConfirmDialog
      :open="blockedDialogOpen"
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
      @cancel="blockedDialogOpen = false"
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
      @close="reportOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  getCuratorGroupMembers,
  getCuratorGroupPage,
  offerCuratorGroupMaster,
} from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { CuratorGroupPageResponse } from '@/api/types'
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

const studentName = computed(() => String(route.query.name ?? 'Ученик'))
const studentAvatar = computed(() => String(route.query.avatar ?? ''))

const inMasterZone = computed(() => String(route.name ?? '').startsWith('master'))

const rosterRoute = computed(() => ({
  name: inMasterZone.value ? 'master-curator-group-members' : 'user-curator-group-members',
  params: { id: groupId.value },
  // Back lands on the roster the row came from (the §1.11 switcher tab).
  query: { kind: 'student' },
}))

function goBack(): void {
  void router.push(rosterRoute.value)
}

const loading = ref(true)
const loaded = ref(false)
const schoolNotFound = ref(false)
const schoolError = ref(false)
const school = ref<CuratorGroupPageResponse | null>(null)

const isCurator = computed(() => school.value?.viewer.relation === 'curator')

async function load(): Promise<void> {
  loading.value = true
  schoolNotFound.value = false
  schoolError.value = false
  try {
    school.value = await getCuratorGroupPage(groupId.value)
    loaded.value = true
  } catch (e) {
    if (e instanceof ApiResponseError && e.status === 404) {
      schoolNotFound.value = true
    } else {
      schoolError.value = true
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})

// Router reuse under the same record: reload for the new student.
watch([groupId, userId], () => {
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
// INTERIM (stopper BE-59): confirming still sends the GT-27 master-offer --
// it becomes the admin role-request the moment BE-59's /role-requests
// contract and generated types land, and only then does the toast become
// «Отправлено на согласование администратору». Either way there are NO
// optimistic changes: the roster moves server-side only.

type MemberKind = 'student' | 'master'

const roleOpen = ref(false)
const rolePending = ref(false)
const kindResolving = ref(false)
const currentKind = ref<MemberKind>('student')
const roleKind = ref<MemberKind>('student')

const roleBusy = computed(() => rolePending.value || kindResolving.value)

// Demotion (master -> student) has no contract yet (tz-curator.md §7.1 №6):
// a current master sees only the master option, which preselects itself and
// keeps «Изменить» disabled -- the popup never fabricates a demotion it
// cannot send.
const roleOptions = computed(() =>
  currentKind.value === 'master'
    ? [{ value: 'master', label: 'Мастер' }]
    : [
        { value: 'student', label: 'Ученик' },
        { value: 'master', label: 'Мастер' },
      ],
)

const roleConfirmDisabled = computed(() => roleBusy.value || roleKind.value === currentKind.value)

async function resolveCurrentKind(): Promise<void> {
  kindResolving.value = true
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
    // A failed lookup must not preselect a lie; the default (student) is the
    // only kind this screen is reached for anyway, and the interim action is
    // idempotent and explains its own 403 master_required.
    currentKind.value = 'student'
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
  if (roleConfirmDisabled.value || rolePending.value) return
  rolePending.value = true
  try {
    await offerCuratorGroupMaster(groupId.value, userId.value)
    toast.success('Предложение отправлено')
    roleOpen.value = false
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отправить предложение'))
  } finally {
    rolePending.value = false
  }
}

// -- «Заблокировать» (BE-79 stopper) --------------------------------------------
//
// Owner ruling 2026-09-30: «Исключить из школы» больше не существует --
// блокировка участника школы (пользователя ИЛИ мастера) заменяет её. The
// popup chain (confirm -> «Пользователь заблокирован» -> report-offer) is
// the UX draft for the owner's review. INTERIM: the school-block contract
// does not exist -- NOTHING mutates server-side; the success step is part
// of the draft under review, not a claim that anything was written.

const blockConfirmOpen = ref(false)
const blockedDialogOpen = ref(false)
const reportOpen = ref(false)

const blockCopy = computed(
  () =>
    `Участник больше не сможет видеть школу «${school.value?.name ?? ''}» и записываться на её практики, а также перестанет получать её уведомления. Вы сможете разблокировать его в любой момент.`,
)

function onBlockClick(close: () => void): void {
  close()
  blockConfirmOpen.value = true
}

function onBlockConfirm(): void {
  // INTERIM (stopper BE-79): no school-block contract to call -- stepping
  // into the success/report-offer chain is the draft under review.
  blockConfirmOpen.value = false
  blockedDialogOpen.value = true
}

function onReportOfferAccept(): void {
  blockedDialogOpen.value = false
  reportOpen.value = true
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
