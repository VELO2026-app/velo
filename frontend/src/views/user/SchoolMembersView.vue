<!--
  VELO Frontend -- SchoolMembersView (tz-curator.md §1.11)

  The school's participants on ONE screen (§1.11, owner 2026-09-22): the
  Мастера/Ученики glass switcher (VSegmentTrack variant="tabs") sits above
  the search, and the active roster rides ?kind= so a refresh or a deep link
  reopens the same list. Curator-only surface: the server answers everyone
  else with the same masked 404 as before (P-08), and the 404 state hides
  the switcher -- an unavailable school has no rosters to switch between.

  Data: GET /masters/me/curator-groups/{id}/members?kind&search&limit&offset
  (the curator handle). The server order is kept verbatim -- recently joined
  first; the client never re-sorts. Search re-queries the same endpoint after
  a 300ms debounce with the input trimmed; refresh()'s requestId bump is the
  stale-response guard, so a superseded fetch discards its result instead of
  painting over the newer list. SWITCHING tabs resets the search and
  reloads -- a new roster is a fresh screen, not a filtered version of the
  previous one, and every load still carries the kind filter: the
  no-unfiltered-load invariant of §1.11.3 survives, only its home moved from
  a static route prop to the query.

  Tapping a row opens the member's profile: a master -> the EXISTING public
  master profile (user-master-public -- one page for both zones, no new
  screen); a student -> the school-context student profile (there is no
  public student page, and the CRM one 404s for school-only students), where
  the curator's actions (offer the master role / remove) live -- the T24-19
  rule from MasterGroupDetailView: a row navigates, it does not act.

  States are the list canon: loader -> 404 («Школа недоступна», the same
  P-08 masking every school surface gives) -> first-page error + retry ->
  rows / two different empties (no members vs no search hits), «Показать
  ещё» for the next page; a later-page failure keeps the list and reports
  through a toast (the admin-lists pattern usePagination documents).
-->

<template>
  <div class="school-members">
    <VHeader title="Участники" show-back @back="goBack" />

    <div class="school-members__content">
      <!-- The glass switcher (§1.11): the merged screen's tab strip. Hidden
           on the 404 rung -- an unavailable school has no rosters to switch
           between. -->
      <VSegmentTrack
        v-if="!notFound"
        :model-value="kind"
        :options="kindOptions"
        variant="tabs"
        aria-label="Вкладки списка участников"
        @update:model-value="switchKind"
      />

      <!-- The search rides the roster tabs; the Блок placeholder has nothing
           to search, so the field sits out. -->
      <div v-if="kind !== 'blocked'" class="school-members__search">
        <div class="school-members__search-field">
          <VInput
            v-model="search"
            :placeholder="searchPlaceholder"
            :aria-label="searchPlaceholder"
          />
        </div>
      </div>

      <!-- Loading (first page) -->
      <div v-if="loading" class="school-members__state">
        <VLoader size="lg" />
      </div>

      <!-- 404: the school is not available to this viewer (deleted, or the
           membership/curatorship is gone) -- masked like every school surface. -->
      <VEmptyState
        v-else-if="notFound"
        icon="notfound"
        title="Школа недоступна"
        description="Возможно, она была удалена или вы в ней не состоите."
      >
        <template #action>
          <VButton variant="primary" @click="goBack">К школе</VButton>
        </template>
      </VEmptyState>

      <!-- First-page failure: this school may well be fine, retry is worth it. -->
      <VEmptyState
        v-else-if="error"
        icon="warning"
        :title="errorTitle"
        :description="error ?? undefined"
      >
        <template #action>
          <VButton variant="outline" @click="retry">Повторить</VButton>
        </template>
      </VEmptyState>

      <template v-else>
        <template v-if="kind === 'blocked'">
          <div v-for="person in blockedItems" :key="person.user_id" class="school-members__blocked">
            <VAvatar :name="person.name" :url="person.avatar_url ?? undefined" size="sm" />
            <div class="school-members__blocked-text">
              <span class="school-members__blocked-name">{{ person.name }}</span>
              <span class="school-members__blocked-meta">
                {{ person.kind === 'master' ? 'Мастер' : 'Ученик' }} · заблокирован
                {{ formatShortDate(person.blocked_at) }}
              </span>
            </div>
            <VButton
              size="sm"
              variant="secondary"
              :loading="unblocking === person.user_id"
              @click="onUnblock(person)"
            >
              Разблокировать
            </VButton>
          </div>
        </template>
        <template v-else>
          <SchoolMemberRow
            v-for="member in rosterItems"
            :key="member.user_id"
            :member="member"
            @open="openMember"
          />
        </template>

        <!-- §1.11.3: two different empties -- no members at all vs no search
             hits. Different problems, different sentences. -->
        <VEmptyState
          v-if="items.length === 0"
          icon="group"
          :title="trimmedSearch ? 'Никого не найдено' : emptyTitle"
          :description="trimmedSearch ? 'Попробуйте изменить запрос' : emptyDescription"
        >
          <template v-if="kind === 'blocked'" #icon>
            <IconLock :size="48" />
          </template>
        </VEmptyState>

        <VLoader v-if="loading && items.length > 0" size="sm" />
        <VShowMore v-if="hasMore && !loading" label="Показать ещё" @click="loadMore" />
      </template>
    </div>

    <!-- BE-76: a school master's tap on a student opens a DM right away (the
         existing composer, POST /chats/students). The curator's tap opens the
         school-context profile instead and never reaches this sheet. -->
    <SendMessageModal
      :open="messageTo !== null"
      :student-id="messageTo?.user_id ?? ''"
      :name="messageTo?.name ?? ''"
      @close="messageTo = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  getCuratorGroupBlocks,
  getCuratorGroupMembers,
  getCuratorGroupPage,
  getCuratorGroupRoster,
  unblockCuratorGroupMember,
  type CuratorGroupMemberKind,
} from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type {
  CuratorGroupBlockedItem,
  CuratorGroupRosterItem,
  CuratorGroupViewer,
} from '@/api/types'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import { IconLock } from '@/components/icons'
import SchoolMemberRow from '@/components/shared/SchoolMemberRow.vue'
import VShowMore from '@/components/shared/VShowMore.vue'
import { VAvatar, VButton, VEmptyState, VInput, VLoader, VSegmentTrack } from '@/components/ui'
import VHeader from '@/components/layout/VHeader.vue'
import { usePagination } from '@/composables/usePagination'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import { formatShortDate } from '@/utils/format'

// §1.11 (owner 2026-09-22): the active roster rides ?kind= -- server truth
// in the URL, so a refresh or a deep link reopens the same list. The third
// tab «Блок» (owner 2026-09-30, BE-79 (2)) lists GET …/blocks for the
// curator, paged like the roster; it has no search (the endpoint takes
// limit/offset only). «Разблокировать» sends DELETE …/blocks/{user_id} and
// re-reads the first page -- the person leaves the list and is back in the
// roster with their role (the other tabs re-read on switch). It is a
// view-local MemberTab, NOT CuratorGroupMemberKind: «blocked» is no kind of
// membership in the API.
type MemberTab = CuratorGroupMemberKind | 'blocked'

const KIND_OPTIONS: ReadonlyArray<{ value: MemberTab; label: string; icon?: Component }> = [
  { value: 'master', label: 'Мастера' },
  { value: 'student', label: 'Ученики' },
  { value: 'blocked', label: 'Блок', icon: IconLock },
]

const route = useRoute()
const router = useRouter()
const toast = useToast()

const groupId = computed(() => String(route.params.id ?? ''))

/** The zone decides only navigation targets -- the data and the row set come
 *  from the server, exactly like on CuratorGroupPageView. */
const inMasterZone = computed(() => String(route.name ?? '').startsWith('master'))

// -- Who is looking (BE-76) -----------------------------------------------------
//
// The viewer's tie to the school is the SERVER's answer (GET /curator-groups/
// {id} -> viewer.relation), never a URL marker: it picks the endpoint and
// what a tap does. The curator reads /members (with his working fields) and
// opens the school-context profiles; a school MASTER, in the master zone only
// (owner decision; the user zone is FE-93's), reads /roster and messages a
// student directly. Fetched once per school, before the first roster page --
// the roster fetcher awaits it, so a 404 here is the same masked rung.
const relation = ref<CuratorGroupViewer['relation'] | null>(null)
let relationFor: { id: string; promise: Promise<CuratorGroupViewer['relation']> } | null = null

function loadRelation(): Promise<CuratorGroupViewer['relation']> {
  if (relationFor?.id !== groupId.value) {
    const id = groupId.value
    relationFor = {
      id,
      promise: getCuratorGroupPage(id).then((page) => {
        if (id === groupId.value) relation.value = page.viewer.relation
        return page.viewer.relation
      }),
    }
    // A failed lookup must be retried on the next fetch, not cached.
    relationFor.promise.catch(() => {
      if (relationFor?.id === id) relationFor = null
    })
  }
  return relationFor.promise
}

const isCurator = computed(() => relation.value === 'curator')
/** A school master reading the roster in the master zone. */
const asSchoolMaster = computed(() => relation.value === 'master' && inMasterZone.value)

/** «Блок» is the curator's tab only (BE-79). */
const kindOptions = computed(() =>
  isCurator.value ? KIND_OPTIONS : KIND_OPTIONS.filter((option) => option.value !== 'blocked'),
)

function kindFromQuery(): MemberTab {
  if (route.query.kind === 'student') return 'student'
  if (route.query.kind === 'blocked') return 'blocked'
  return 'master'
}

const kind = ref<MemberTab>(kindFromQuery())

const searchPlaceholder = computed(() =>
  kind.value === 'master' ? 'Искать мастера...' : 'Искать ученика...',
)
const emptyTitle = computed(() => {
  if (kind.value === 'blocked') return 'Пока нет заблокированных'
  return kind.value === 'master' ? 'В школе пока нет мастеров' : 'В школе пока нет учеников'
})
const emptyDescription = computed(() => {
  if (kind.value === 'blocked') {
    return 'Участник появится здесь, когда вы заблокируете его через меню на странице профиля.'
  }
  return kind.value === 'master'
    ? 'Мастером школы участник становится после принятия предложения куратора.'
    : 'Ученики появляются в школе после вступления по ссылке-приглашению.'
})
const errorTitle = computed(() => {
  if (kind.value === 'blocked') return 'Не удалось загрузить заблокированных'
  return kind.value === 'master' ? 'Не удалось загрузить мастеров' : 'Не удалось загрузить учеников'
})

const pageRoute = computed(() => ({
  name: inMasterZone.value ? 'master-curator-group' : 'user-curator-group',
  params: { id: groupId.value },
}))

function goBack(): void {
  void router.push(pageRoute.value)
}

// -- Roster data -------------------------------------------------------------

const search = ref('')
const trimmedSearch = computed(() => search.value.trim())

// A 404 here means THIS SCHOOL is not available to the viewer (P-08 masking),
// not "the list is empty" -- a different rung entirely. usePagination keeps
// only the message string, so the raw error is inspected as it passes by.
const notFound = ref(false)

const { items, loading, error, loadMoreError, hasMore, loadMore, refresh } = usePagination<
  CuratorGroupRosterItem | CuratorGroupBlockedItem
>(async (limit, offset) => {
  try {
    const viewer = await loadRelation()
    // «Блок» is the curator's alone; anyone else who lands on ?kind=blocked
    // is moved to the masters tab.
    if (kind.value === 'blocked') {
      if (viewer === 'curator') return await getCuratorGroupBlocks(groupId.value, { limit, offset })
      kind.value = 'master'
      void router.replace({ ...route, query: { ...route.query, kind: 'master' } })
    }
    const query = {
      kind: kind.value,
      search: trimmedSearch.value || undefined,
      limit,
      offset,
    }
    return viewer === 'master' && inMasterZone.value
      ? await getCuratorGroupRoster(groupId.value, query)
      : await getCuratorGroupMembers(groupId.value, query)
  } catch (e: unknown) {
    if (e instanceof ApiResponseError && e.status === 404) notFound.value = true
    throw e
  }
}, 20)

/** Set only when a switch or a query-sync programmatically clears the input;
 *  the watcher only fires on real value changes, so the flag cannot leak. */
let suppressSearchWatch = false

// §1.11.3: search re-queries the same endpoint -- debounce 300ms, trim, offset
// back to 0. refresh() resets the list and bumps usePagination's requestId, so
// any in-flight older fetch discards its result: the stale-response guard.
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, () => {
  if (suppressSearchWatch) {
    suppressSearchWatch = false
    return
  }
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    notFound.value = false
    void refresh()
  }, 300)
})

// -- The roster switcher (§1.11) -----------------------------------------------

/** A tab flip writes the tab into the URL with replace (switching rosters is
 *  not navigation history), resets the search, and reloads: every request
 *  still carries the kind filter, so the §1.11.3 invariant survives. A new
 *  roster is a fresh screen, not a filtered version of the previous one. */
async function switchKind(next: MemberTab): Promise<void> {
  if (next === kind.value) return
  kind.value = next
  notFound.value = false
  if (search.value !== '') {
    suppressSearchWatch = true
    search.value = ''
  }
  void router.replace({
    name: inMasterZone.value ? 'master-curator-group-members' : 'user-curator-group-members',
    params: { id: groupId.value },
    query: { kind: next },
  })
  await refresh()
}

// History navigation between ?kind= tabs is rare (switches use replace) but
// must not desync the tab. switchKind sets kind BEFORE its own replace, so
// that write lands here as a no-op.
watch(
  () => route.query.kind,
  (next) => {
    const fromUrl: MemberTab =
      next === 'student' ? 'student' : next === 'blocked' ? 'blocked' : 'master'
    if (fromUrl === kind.value) return
    kind.value = fromUrl
    notFound.value = false
    if (search.value !== '') {
      suppressSearchWatch = true
      search.value = ''
    }
    void refresh()
  },
)

// The one list holds either rows of the roster or rows of «Блок» -- the
// tab decides which; these name it for the template.
const rosterItems = computed(() =>
  kind.value === 'blocked' ? [] : (items.value as CuratorGroupRosterItem[]),
)
const blockedItems = computed(() =>
  kind.value === 'blocked' ? (items.value as CuratorGroupBlockedItem[]) : [],
)

// BE-79 (2): «Разблокировать». 204 -> the first page is re-read, so the row
// leaves; 404 (already unblocked elsewhere) -> the same re-read, the list
// was simply stale; anything else -> the error toast, the row stays.
const unblocking = ref<string | null>(null)

async function onUnblock(person: CuratorGroupBlockedItem): Promise<void> {
  if (unblocking.value) return
  unblocking.value = person.user_id
  try {
    await unblockCuratorGroupMember(groupId.value, person.user_id)
    toast.success('Участник разблокирован')
    await refresh()
  } catch (e) {
    if (e instanceof ApiResponseError && e.status === 404) {
      await refresh()
      return
    }
    toast.error(extractApiError(e, 'Не удалось разблокировать участника'))
  } finally {
    unblocking.value = null
  }
}

// A later-page failure keeps the list on screen and reports non-destructively.
watch(loadMoreError, (message) => {
  if (message) toast.error(message)
})

async function retry(): Promise<void> {
  notFound.value = false
  await refresh()
}

onMounted(() => {
  void refresh()
})

// Router reuse: navigating between this school's rosters reuses the mounted
// instance, so re-read for the new id instead of waiting for a remount.
watch(groupId, () => {
  if (groupId.value) {
    notFound.value = false
    void refresh()
  }
})

// -- Navigation: rows open the member's profile -------------------------------

/** The student a school master is writing to; null when the sheet is shut. */
const messageTo = ref<CuratorGroupRosterItem | null>(null)

function openMember(member: CuratorGroupRosterItem): void {
  // A master opens the EXISTING public profile (any zone can render it --
  // no guard on /user/masters/:id). A student has no public page, so their
  // school-context profile carries the curator actions instead.
  if (kind.value === 'master') {
    // Owner ruling 2026-09-30: the master's page carries the curator's action
    // menu when opened from the school context -- the roster passes the
    // ?groupId= marker that turns the menu on (no new route, no new screen).
    // That marker is the CURATOR's: a school master opens the same public
    // page WITHOUT it, so no curator action shows up for him (BE-76).
    void router.push({
      name: 'user-master-public',
      params: { id: member.user_id },
      query: asSchoolMaster.value
        ? { name: member.name, avatar: member.avatar_url ?? '' }
        : { groupId: groupId.value, name: member.name, avatar: member.avatar_url ?? '' },
    })
    return
  }
  // BE-76: a school master writes to the student straight away; the
  // school-context student profile stays the curator's (owner decision 3).
  if (asSchoolMaster.value) {
    messageTo.value = member
    return
  }
  const zone = inMasterZone.value ? 'master' : 'user'
  void router.push({
    name: `${zone}-curator-group-student`,
    params: { groupId: groupId.value, userId: member.user_id },
    // The profile renders instantly from the roster row's own data while its
    // real fetches run (the MasterGroupDetailView query canon).
    query: { name: member.name, avatar: member.avatar_url ?? '' },
  })
}
</script>

<style scoped>
.school-members__blocked {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
}
.school-members__blocked-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.school-members__blocked-name {
  font-weight: 600;
}
.school-members__blocked-meta {
  color: var(--velo-text-secondary);
  font-size: var(--text-sm);
}
.school-members {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.school-members__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.school-members__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* Search: the same DS glass pill as MasterGroupDetailView. */
.school-members__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.school-members__search-field {
  flex: 1;
  min-width: 0;
}

.school-members__search-field :deep(.v-input) {
  margin-bottom: 0;
}

.school-members__search-field :deep(.v-input__field) {
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-full);
  box-shadow: var(--velo-shadow-glow);
}
</style>
