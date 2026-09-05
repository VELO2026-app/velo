<!--
  VELO Frontend -- CuratorGroupPageView (schools FE-19/FE-20 / GT P3)

  ONE school page component mounted by BOTH zones (precedent: EditProfileView
  -- a user-zone view the master zone mounts directly). Everything that
  differs between the three viewers keys off the SERVER's viewer.relation,
  never off the zone: a master-zone curator and a user-zone student see the
  same component with a different action set (TZ 6.3).

  Data: GET /curator-groups/{id} (page + relation + transfer) + /masters +
  /practices in parallel; the curator additionally loads the student roster
  (members?kind=student -- the student list is the curator's privilege,
  masters see only the counter).

  Zone only decides the back target (master-curator-groups vs
  user-curator-groups), read off route.name's prefix.

  «Покинуть школу» for student/master and the «⋯» menu for the curator live
  in the header (TZ: действие в шапке). All three destructive dialogs
  (покинуть / удалить участника / удалить школу) carry the ADVISORY line
  from the *-preview endpoints; a 404 on a preview means "no advisory"
  (frozen school -- leave still works, I-5), never an error, and never a
  blocked button.
-->

<template>
  <div class="cgp">
    <VHeader :title="page?.name ?? 'Группа'" show-back @back="goBack">
      <template #action>
        <!-- Curator: the «⋯» management menu. -->
        <VMenu v-if="isCurator && page" ariaLabel="Меню группы">
          <template #default="{ close }">
            <VMenuItem :icon="IconPen" ariaLabel="Редактировать" @click="onEditClick(close)" />
            <VMenuItem
              :icon="IconShare"
              ariaLabel="Пригласить мастера"
              @click="openInvite('master', close)"
            />
            <VMenuItem
              :icon="IconShare"
              ariaLabel="Пригласить ученика"
              @click="openInvite('student', close)"
            />
            <VMenuItem
              v-if="!hasPendingTransfer"
              :icon="IconBroadcast"
              ariaLabel="Передать школу"
              @click="onTransferClick(close)"
            />
            <VMenuItem
              :icon="IconTrash"
              ariaLabel="Удалить школу"
              danger
              @click="onDeleteClick(close)"
            />
          </template>
        </VMenu>
        <!-- Student / master: the exit action lives in the header too. -->
        <VButton
          v-else-if="relation"
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
        title="Группа не найдена"
        description="Возможно, она была удалена или вы в ней не состоите."
      >
        <template #action>
          <VButton variant="primary" @click="goBack">К моим группам</VButton>
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
        title="Не удалось загрузить группу"
        description="Проверьте соединение и попробуйте ещё раз."
      >
        <template #action>
          <VButton variant="outline" @click="load">Повторить</VButton>
        </template>
      </VEmptyState>

      <template v-else-if="page">
        <!-- School avatar (BE-20) + description. The avatar is a LINK, not an
             upload -- the platform has no file storage -- and it may be absent
             (founding takes no picture; a PATCH attaches it afterwards). -->
        <div v-if="page.description || page.avatar_url" class="cgp__intro">
          <VAvatar
            v-if="page.avatar_url"
            class="cgp__school-avatar"
            :name="page.name"
            :url="page.avatar_url"
            size="md"
          />
          <p v-if="page.description" class="cgp__description">
            {{ page.description }}
          </p>
        </div>

        <div class="cgp__meta">
          <VAvatar
            class="cgp__curator-avatar"
            :name="page.curator.display_name || page.name"
            :url="page.curator.avatar_url ?? undefined"
            size="sm"
          />
          <span class="cgp__curator-name">Куратор: {{ page.curator.display_name || '—' }}</span>
        </div>
        <p class="cgp__counts">
          Мастеров: {{ page.masters_count }} · Учеников: {{ page.students_count }}
        </p>

        <!-- FE-21: transfer offer banner (curator sees "sent", addressee
             sees accept/decline). Renders nothing for everyone else. -->
        <CuratorGroupTransferBanner
          v-if="page.transfer || pendingTransfer"
          :transfer="page.transfer"
          :pending="pendingTransfer"
          :relation="relation"
          :group-id="groupId"
          @cancelled="onTransferCancelled"
          @accepted="onTransferAccepted"
          @declined="onTransferDeclined"
        />

        <!-- Мастера школы -->
        <h2 class="velo-section-title cgp__section">Мастера школы</h2>
        <template v-if="masters.length">
          <div v-for="m in masters" :key="m.user_id" class="cgp__master">
            <MasterCard
              class="cgp__master-card"
              :master-name="m.display_name"
              :methods="m.methods ?? null"
              :avatar-url="m.avatar_url"
              :master-id="m.user_id"
            />
            <!-- Only the curator removes masters, and never themselves (the
                 curator's exit is a transfer or a delete, never a leave). -->
            <button
              v-if="isCurator && !m.is_curator"
              type="button"
              class="cgp__remove-btn"
              :aria-label="`Удалить из группы: ${m.display_name || 'мастера'}`"
              @click="onRemoveMemberClick(m.user_id, m.display_name || 'мастера')"
            >
              <IconTrash :size="18" />
            </button>
          </div>
        </template>
        <VEmptyState v-else variant="note" title="Мастеров пока нет" />
        <p v-if="isCurator && !masters.length" class="cgp__hint">
          Поделитесь ссылкой — мастера вступят сами.
        </p>

        <!-- Review P2 / I-4: suspended master-members stay in the curator's
             sight "in the shadow" -- the public roster drops them, the
             curator's /members keeps the rows. Rendered as plain rows (the
             member item carries no showcase fields) with the same remove
             action as any participant. -->
        <template v-if="isCurator && hiddenMasters.length">
          <div v-for="m in hiddenMasters" :key="m.user_id" class="cgp__student">
            <VListRow :title="m.name" subtitle="Мастер не верифицирован — скрыт из школы">
              <template #lead>
                <VAvatar :name="m.name" :url="m.avatar_url ?? undefined" size="sm" />
              </template>
              <template #trailing>
                <VBadge variant="muted">В тени</VBadge>
              </template>
            </VListRow>
            <button
              type="button"
              class="cgp__remove-btn"
              :aria-label="`Удалить из группы: ${m.name}`"
              @click="onRemoveMemberClick(m.user_id, m.name)"
            >
              <IconTrash :size="18" />
            </button>
          </div>
        </template>

        <!-- Практики школы -->
        <h2 class="velo-section-title cgp__section">Практики школы</h2>
        <template v-if="practices.length">
          <CalendarPracticeCard
            v-for="p in practices"
            :key="p.id"
            :practice="p"
            show-date
            @click="router.push({ name: 'practice-detail', params: { id: $event } })"
          />
        </template>
        <VEmptyState v-else variant="note" title="Ближайших практик нет" />

        <!-- Ученики: curator-only list (masters see the counter above). -->
        <template v-if="isCurator">
          <h2 class="velo-section-title cgp__section">Ученики</h2>
          <template v-if="students.length">
            <div v-for="s in students" :key="s.user_id" class="cgp__student">
              <VListRow :title="s.name">
                <template #lead>
                  <VAvatar :name="s.name" :url="s.avatar_url ?? undefined" size="sm" />
                </template>
              </VListRow>
              <button
                type="button"
                class="cgp__remove-btn"
                :aria-label="`Удалить из группы: ${s.name}`"
                @click="onRemoveMemberClick(s.user_id, s.name)"
              >
                <IconTrash :size="18" />
              </button>
            </div>
          </template>
          <VEmptyState v-else variant="note" title="Учеников пока нет" />
        </template>

        <!-- Журнал школы (BE-19): the curator's own event feed. Members never
             see it -- the backend answers 404 to everyone but the owner, and
             the journal names who was removed and who walked out. -->
        <template v-if="isCurator">
          <h2 class="velo-section-title cgp__section">Журнал школы</h2>
          <div v-if="journalLoading && !journal.length" class="cgp__state">
            <VLoader size="lg" />
          </div>
          <template v-else-if="journal.length">
            <div v-for="ev in journal" :key="ev.id" class="cgp__journal-row">
              <!-- The actor's name is a SNAPSHOT frozen at write time -- it is
                   rendered as-is, never looked up (a renamed or deleted person
                   keeps their place in history). -->
              <p class="cgp__journal-text">
                <strong>{{ ev.actor.display_name }}</strong> — {{ journalLine(ev) }}
              </p>
              <p class="cgp__journal-date">
                {{ formatFeedDateTime(ev.created_at, viewerTimezone || 'UTC') }}
              </p>
            </div>
            <VButton
              v-if="journal.length < journalTotal"
              variant="outline"
              block
              :loading="journalLoading"
              @click="loadJournal(false)"
            >
              Показать ещё
            </VButton>
          </template>
          <VEmptyState v-else-if="!journalError" variant="note" title="Событий пока нет" />
          <VEmptyState v-else icon="warning" title="Журнал недоступен">
            <template #action>
              <VButton variant="outline" size="sm" @click="loadJournal(true)"> Повторить </VButton>
            </template>
          </VEmptyState>
        </template>
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

    <!-- Invite links: one sheet per kind, minted on open. Closing either
         sheet also refreshes the journal -- minting on open and revoking
         inside both write journal events the curator should see appear. -->
    <CuratorGroupInviteSheet
      :open="inviteKind === 'master'"
      kind="master"
      :group-id="groupId"
      @close="onInviteSheetClosed"
    />
    <CuratorGroupInviteSheet
      :open="inviteKind === 'student'"
      kind="student"
      :group-id="groupId"
      @close="onInviteSheetClosed"
    />

    <!-- Transfer picker (FE-21): the eligible set is exactly the VISIBLE
         master members -- the same roster rendered above, minus the curator
         (their exit is a transfer, so they cannot transfer to themselves). -->
    <VBottomSheet
      :open="transferPickerOpen"
      title="Передать школу"
      compact-title
      save-label="Передать"
      :save-disabled="!transferTargetId"
      @save="onTransferPick"
      @close="transferPickerOpen = false"
    >
      <p class="cgp__picker-hint">Кому передать школу?</p>
      <div
        v-for="m in transferCandidates"
        :key="m.user_id"
        class="cgp__picker-row"
        role="button"
        tabindex="0"
        :class="{ 'cgp__picker-row--active': transferTargetId === m.user_id }"
        @click="transferTargetId = m.user_id"
        @keydown.enter.space.prevent="transferTargetId = m.user_id"
      >
        <VAvatar :name="m.display_name || 'Мастер'" :url="m.avatar_url ?? undefined" size="sm" />
        <span class="cgp__picker-name">{{ m.display_name || 'Мастер' }}</span>
        <IconCheck v-if="transferTargetId === m.user_id" :size="18" class="cgp__picker-check" />
      </div>
      <VEmptyState
        v-if="!transferCandidates.length"
        variant="note"
        title="Нет мастеров, которым можно передать школу"
      />
    </VBottomSheet>

    <!-- Review P2: the pick is CONFIRMED before the offer is posted. -->
    <VConfirmDialog
      :open="transferConfirmOpen"
      title="Передать школу?"
      :message="`Школа будет предложена мастеру ${transferTargetName}. Пока предложение не принято, его можно отменить.`"
      confirm-label="Передать"
      :loading="offering"
      @confirm="onTransferOffer"
      @close="transferConfirmOpen = false"
    />

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

    <!-- Remove member confirm (curator): advisory from remove-preview. -->
    <VConfirmDialog
      :open="removeConfirmOpen"
      title="Удалить из группы?"
      :message="removeMessage"
      confirm-label="Удалить"
      danger
      :loading="removing"
      @confirm="onRemoveConfirm"
      @close="removeConfirmOpen = false"
    />

    <!-- Delete school confirm (curator): counts from the page + delete-preview. -->
    <VConfirmDialog
      :open="deleteConfirmOpen"
      title="Удалить школу?"
      :message="deleteMessage"
      confirm-label="Удалить"
      danger
      :loading="deleting"
      @confirm="onDeleteConfirm"
      @close="deleteConfirmOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  deleteCuratorGroup,
  getCuratorGroupDeletePreview,
  getCuratorGroupJournal,
  getCuratorGroupLeavePreview,
  getCuratorGroupMasters,
  getCuratorGroupMembers,
  getCuratorGroupPage,
  getCuratorGroupPractices,
  getCuratorGroupRemovePreview,
  leaveCuratorGroup,
  offerCuratorGroupTransfer,
  removeCuratorGroupMember,
  updateCuratorGroup,
} from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type {
  CuratorGroupEventItem,
  CuratorGroupMasterItem,
  CuratorGroupMemberItem,
  CuratorGroupPageResponse,
  CuratorGroupTransferRef,
  PracticeResponse,
} from '@/api/types'
import { extractApiError } from '@/composables/useApiError'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import { useToast } from '@/composables/useToast'
import { formatFeedDateTime } from '@/utils/format'
import CalendarPracticeCard from '@/components/shared/CalendarPracticeCard.vue'
import CuratorGroupInviteSheet from '@/components/shared/CuratorGroupInviteSheet.vue'
import CuratorGroupTransferBanner from '@/components/shared/CuratorGroupTransferBanner.vue'
import MasterCard from '@/components/shared/MasterCard.vue'
import IconBroadcast from '@/components/icons/IconBroadcast.vue'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconPen from '@/components/icons/IconPen.vue'
import IconShare from '@/components/icons/IconShare.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import VAvatar from '@/components/ui/VAvatar.vue'
import VBadge from '@/components/ui/VBadge.vue'
import VBottomSheet from '@/components/ui/VBottomSheet.vue'
import VButton from '@/components/ui/VButton.vue'
import VConfirmDialog from '@/components/ui/VConfirmDialog.vue'
import VEmptyState from '@/components/ui/VEmptyState.vue'
import VHeader from '@/components/layout/VHeader.vue'
import VInput from '@/components/ui/VInput.vue'
import VListRow from '@/components/ui/VListRow.vue'
import VLoader from '@/components/ui/VLoader.vue'
import VMenu from '@/components/ui/VMenu.vue'
import VMenuItem from '@/components/ui/VMenuItem.vue'
import VTextarea from '@/components/ui/VTextarea.vue'

const route = useRoute()
const router = useRouter()
const toast = useToast()
// The journal renders WHEN in the viewer's own time, like every other time
// on the platform (the card feed already goes through this composable).
const viewerTimezone = useViewerTimezone()

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
const masters = ref<CuratorGroupMasterItem[]>([])
const practices = ref<PracticeResponse[]>([])
const students = ref<CuratorGroupMemberItem[]>([])
/** Review P2: suspended master-members, curator's eyes only ("in the
 *  shadow", I-4). The public /masters roster drops them; the curator's own
 *  /members?kind=master keeps the rows -- without this list the curator
 *  could not remove a hidden master until re-verification. */
const hiddenMasters = ref<CuratorGroupMemberItem[]>([])

const relation = computed(() => page.value?.viewer.relation ?? null)
const isCurator = computed(() => relation.value === 'curator')

/** The curator's own just-offered transfer, before any reload confirms it:
 *  lets the banner appear the moment the offer is made. */
const pendingTransfer = ref<CuratorGroupTransferRef | null>(null)

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
  pendingTransfer.value = null
  try {
    const [pageRes, mastersItems, practicesItems] = await Promise.all([
      getCuratorGroupPage(groupId.value),
      fetchAllPages((offset) => getCuratorGroupMasters(groupId.value, PAGE, offset)),
      fetchAllPages((offset) => getCuratorGroupPractices(groupId.value, PAGE, offset)),
    ])
    page.value = pageRes
    masters.value = mastersItems
    practices.value = practicesItems
    if (pageRes.viewer.relation === 'curator') {
      const [studentItems, masterMemberItems] = await Promise.all([
        fetchAllPages((offset) =>
          getCuratorGroupMembers(groupId.value, { kind: 'student', limit: PAGE, offset }),
        ),
        fetchAllPages((offset) =>
          getCuratorGroupMembers(groupId.value, { kind: 'master', limit: PAGE, offset }),
        ),
        // The journal is the curator's privilege -- fetched with the rosters
        // it reports on, one screenful at a time («Показать ещё» appends).
        loadJournal(true),
      ])
      students.value = studentItems
      hiddenMasters.value = masterMemberItems.filter((m) => !m.is_visible)
    } else {
      students.value = []
      hiddenMasters.value = []
      journal.value = []
    }
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

/** Refresh everything that can change after a mutation, keeping the already
 *  rendered page (no full-screen reload flash). */
async function reloadRosters(): Promise<void> {
  const [mastersItems, practicesItems] = await Promise.all([
    fetchAllPages((offset) => getCuratorGroupMasters(groupId.value, PAGE, offset)),
    fetchAllPages((offset) => getCuratorGroupPractices(groupId.value, PAGE, offset)),
  ])
  masters.value = mastersItems
  practices.value = practicesItems
  if (isCurator.value) {
    const [studentItems, masterMemberItems] = await Promise.all([
      fetchAllPages((offset) =>
        getCuratorGroupMembers(groupId.value, { kind: 'student', limit: PAGE, offset }),
      ),
      fetchAllPages((offset) =>
        getCuratorGroupMembers(groupId.value, { kind: 'master', limit: PAGE, offset }),
      ),
    ])
    students.value = studentItems
    hiddenMasters.value = masterMemberItems.filter((m) => !m.is_visible)
    // Every caller of reloadRosters just did something the journal records
    // (a removal, an accepted transfer) -- bring its first page along too.
    void loadJournal(true)
  }
}

onMounted(load)
// Remount data if the same component instance is reused for another id.
watch(groupId, () => {
  if (groupId.value) void load()
})

// -- Журнал школы (BE-19) ------------------------------------------------------

const journal = ref<CuratorGroupEventItem[]>([])
const journalTotal = ref(0)
const journalLoading = ref(false)
const journalError = ref(false)
const JOURNAL_PAGE = 20

/** Reset=true replaces the feed (first page / refresh); false appends the
 *  next one. The response's order is authoritative -- a hidden seq column
 *  sorted it, and created_at CANNOT (two events of one PATCH share it to the
 *  byte) -- so rows are stored exactly as they arrive, never re-sorted. */
async function loadJournal(reset: boolean): Promise<void> {
  if (journalLoading.value) return
  journalLoading.value = true
  if (reset) journalError.value = false
  try {
    const res = await getCuratorGroupJournal(
      groupId.value,
      JOURNAL_PAGE,
      reset ? 0 : journal.value.length,
    )
    journal.value = reset ? res.items : [...journal.value, ...res.items]
    journalTotal.value = res.total
  } catch {
    // 404 to a curator is the frozen-school indistinguishability (P-08) --
    // unreachable here (the page itself already 404ed), so this catch is
    // the plain network branch.
    journalError.value = true
  } finally {
    journalLoading.value = false
  }
}

/** The sentence half after the actor's frozen name. One line per event kind,
 *  RU, gender-neutral «-л(а)». Unknown kinds (the vocabulary grows --
 *  notifications next) render the raw event string rather than crashing. */
function journalLine(ev: CuratorGroupEventItem): string {
  const d = ev.data as {
    kind?: 'master' | 'student'
    old_name?: string
    new_name?: string
    had_avatar_before?: boolean
    target_name?: string
  }
  const flavour = d.kind === 'master' ? 'мастеров' : 'учеников'
  switch (ev.event) {
    case 'group_created':
      return 'создал(а) школу'
    case 'group_renamed':
      return `переименовал(а) школу: «${d.old_name ?? '—'}» → «${d.new_name ?? '—'}»`
    case 'group_description_changed':
      return 'изменил(а) описание'
    case 'group_avatar_changed':
      return d.had_avatar_before ? 'обновил(а) аватар школы' : 'добавил(а) аватар школы'
    case 'member_joined':
      return d.kind === 'master' ? 'вступил(а) мастером' : 'вступил(а) учеником'
    case 'member_promoted':
      return 'повышен(а) до мастера (вступил(а) по ссылке мастеров)'
    case 'member_removed':
      return `удалил(а) участника: ${d.target_name ?? '—'}`
    case 'member_left':
      return d.kind === 'master' ? 'вышел(а) из школы (мастер)' : 'вышел(а) из школы'
    case 'invite_created':
      return `выпустил(а) ссылку для ${flavour}`
    case 'invite_revoked':
      return `отозвал(а) ссылку для ${flavour}`
    case 'transfer_offered':
      return `предложил(а) школу мастеру: ${d.target_name ?? '—'}`
    case 'transfer_accepted':
      return `принял(а) школу — прежний куратор: ${d.target_name ?? '—'}`
    case 'transfer_declined':
      return `отклонил(а) предложение школы от: ${d.target_name ?? '—'}`
    case 'transfer_cancelled':
      return `отменил(а) передачу школы (адресат: ${d.target_name ?? '—'})`
    default:
      return ev.event
  }
}

// -- Advisory previews (FE-24 wiring on this page's three dialogs) ----------
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

// -- Remove member (curator) --

const removeConfirmOpen = ref(false)
const removing = ref(false)
const removeTarget = ref<{ userId: string; name: string } | null>(null)
const removeAdvisory = ref<number | null>(null)

const removeMessage = computed(
  () =>
    `${removeTarget.value?.name ?? 'Участник'} потеряет доступ к школе.${advisoryLine(removeAdvisory.value)}`,
)

function onRemoveMemberClick(userId: string, name: string): void {
  removeTarget.value = { userId, name }
  removeAdvisory.value = null
  removeConfirmOpen.value = true
  void advisoryCount(() => getCuratorGroupRemovePreview(groupId.value, userId)).then((n) => {
    removeAdvisory.value = n
  })
}

async function onRemoveConfirm(): Promise<void> {
  if (!removeTarget.value) return
  removing.value = true
  try {
    await removeCuratorGroupMember(groupId.value, removeTarget.value.userId)
    removeConfirmOpen.value = false
    toast.success('Участник удалён из группы')
    await reloadRosters()
    // The counters on the page header changed too -- refresh just the page.
    page.value = await getCuratorGroupPage(groupId.value)
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось удалить участника'))
  } finally {
    removing.value = false
  }
}

// -- Delete school (curator) --

const deleteConfirmOpen = ref(false)
const deleting = ref(false)
const deletePreview = ref<{ masters: number; students: number; practices: number } | null>(null)

const deleteMessage = computed(() => {
  const name = page.value?.name ?? ''
  if (!deletePreview.value) return `Школа «${name}» будет удалена.`
  const { masters: m, students: s, practices: p } = deletePreview.value
  let msg = `Школа «${name}» будет удалена: ${m} ${m === 1 ? 'мастер' : 'мастеров'} и ${s} ${s === 1 ? 'ученик' : 'учеников'} потеряют доступ.`
  if (p > 0) {
    const word =
      p === 1
        ? 'практика станет скрытой'
        : p < 5
          ? 'практики станут скрыты'
          : 'практик станут скрыты'
    msg += ` ${p} предстоящих ${word}.`
  }
  return msg
})

function onDeleteClick(close: () => void): void {
  close()
  deletePreview.value = null
  deleteConfirmOpen.value = true
  void (async () => {
    try {
      const res = await getCuratorGroupDeletePreview(groupId.value)
      deletePreview.value = {
        masters: res.masters_count,
        students: res.students_count,
        practices: res.upcoming_practices_targeting_group,
      }
    } catch {
      deletePreview.value = null
    }
  })()
}

async function onDeleteConfirm(): Promise<void> {
  deleting.value = true
  try {
    await deleteCuratorGroup(groupId.value)
    deleteConfirmOpen.value = false
    toast.success('Школа удалена')
    // Deletion is never blocked (I-11) and cascades everything; the list is
    // the only place left to go -- it refetches on its own mount.
    void router.replace({ name: 'master-curator-groups' })
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось удалить школу'))
  } finally {
    deleting.value = false
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

function onEditClick(close: () => void): void {
  close()
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
    toast.success('Группа обновлена')
    // §12 trap: the server stores the URL NORMALIZED (lowercase host,
    // trailing slash, punycode) -- what returns is not what was typed, and
    // a silent difference reads as "the link got corrupted". Say it.
    if (typeof avatar === 'string' && (res.avatar_url ?? '') !== avatar && res.avatar_url) {
      toast.info(`Ссылка на аватар сохранена как ${res.avatar_url}`)
    }
    // A rename / re-description / re-avatar is exactly what the journal
    // records -- refresh its first page so the feed does not lie by omission.
    void loadJournal(true)
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось обновить группу'))
  } finally {
    saving.value = false
  }
}

// -- Invites (curator) --

const inviteKind = ref<'master' | 'student' | null>(null)

function openInvite(kind: 'master' | 'student', close: () => void): void {
  close()
  inviteKind.value = kind
}

function onInviteSheetClosed(): void {
  inviteKind.value = null
  // Minting on open and revoking inside both write journal events -- the
  // curator closing the sheet should see the feed catch up, not reload.
  if (isCurator.value) void loadJournal(true)
}

// -- Transfer (FE-21) --

const transferPickerOpen = ref(false)
const transferConfirmOpen = ref(false)
const transferTargetId = ref('')
const transferTargetName = ref('')
const offering = ref(false)

/** Visible master members, curator excluded -- the exact eligible set the
 *  backend checks the offer against (transfer_target_not_member otherwise). */
const transferCandidates = computed(() => masters.value.filter((m) => !m.is_curator))

/** An offer is in flight (server-known or just-made): the menu entry hides
 *  and the banner takes over (review P2 -- TZ says the offer REPLACES the
 *  action, not sits beside it). */
const hasPendingTransfer = computed(() => !!(page.value?.transfer || pendingTransfer.value))

function onTransferClick(close: () => void): void {
  close()
  transferTargetId.value = ''
  transferPickerOpen.value = true
}

/** The sheet's «Передать»: pick is confirmed BEFORE any POST (review P2 --
 *  choosing a name used to fire the offer immediately). */
function onTransferPick(): void {
  const target = transferCandidates.value.find((m) => m.user_id === transferTargetId.value)
  if (!target) return
  transferTargetName.value = target.display_name || 'Мастер'
  transferPickerOpen.value = false
  transferConfirmOpen.value = true
}

async function onTransferOffer(): Promise<void> {
  // The re-entry guard (review P2): a second fast tap must not fire a second
  // POST only to toast a bogus transfer_pending.
  if (offering.value || !transferTargetId.value) return
  offering.value = true
  try {
    pendingTransfer.value = await offerCuratorGroupTransfer(groupId.value, transferTargetId.value)
    transferConfirmOpen.value = false
    toast.success('Предложение отправлено')
  } catch (e) {
    // transfer_pending (409) and transfer_target_not_member (404) both have
    // their phrase in errorMessages.ts -- extractApiError resolves them.
    toast.error(extractApiError(e, 'Не удалось отправить предложение'))
  } finally {
    offering.value = false
  }
}

function onTransferCancelled(): void {
  // The banner optimistically clears itself; drop the local echo too.
  pendingTransfer.value = null
  if (page.value) page.value = { ...page.value, transfer: null }
}

async function onTransferAccepted(newPage: CuratorGroupPageResponse): Promise<void> {
  // The accept response IS the page as the new curator sees it -- replace
  // local state wholesale (relation flips, the «⋯» menu appears, no reload).
  page.value = newPage
  pendingTransfer.value = null
  toast.success('Школа передана вам')
  await reloadRosters()
}

function onTransferDeclined(): void {
  pendingTransfer.value = null
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

/* School intro (BE-20): optional avatar beside the description. */
.cgp__intro {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.cgp__school-avatar {
  flex-shrink: 0;
}

.cgp__description {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.5;
  margin: 0;
}

.cgp__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.cgp__curator-avatar {
  flex-shrink: 0;
}

.cgp__curator-name {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}

.cgp__counts {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: 0;
}

.cgp__section {
  margin-top: var(--space-4);
}

.cgp__hint {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin: 0;
}

/* Журнал школы (BE-19): one quiet line per event, newest first. */
.cgp__journal-row {
  padding: var(--space-2) 0;
  border-bottom: var(--velo-border-width, 1px) solid var(--velo-border-card);
}

.cgp__journal-row:last-of-type {
  border-bottom: none;
}

.cgp__journal-text {
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  line-height: 1.45;
  margin: 0;
}

.cgp__journal-text strong {
  font-weight: 600;
}

.cgp__journal-date {
  font-size: var(--text-xs);
  color: var(--velo-text-muted, var(--velo-text-secondary));
  margin: var(--space-1) 0 0;
}

/* The avatar-link hint inside the edit sheet (BE-20). */
.cgp__edit-hint {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-2);
}

.cgp__master,
.cgp__student {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.cgp__master-card {
  flex: 1;
  min-width: 0;
}

.cgp__student > :first-child {
  flex: 1;
  min-width: 0;
}

/* Row-trailing remove control -- the same destructive affordance the «⋯»
   menus use (IconTrash, danger tone), sized to a row's touch target. */
.cgp__remove-btn {
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-pink-100);
  color: var(--velo-pink-300);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.cgp__remove-btn:active {
  opacity: 0.85;
}

.cgp__picker-hint {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: 0 0 var(--space-2);
}

.cgp__picker-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--velo-border-card);
  background: var(--velo-bg-card-solid);
  cursor: pointer;
}

.cgp__picker-row--active {
  border-color: var(--velo-primary);
}

.cgp__picker-name {
  flex: 1;
  min-width: 0;
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.cgp__picker-check {
  color: var(--velo-primary);
}
</style>
