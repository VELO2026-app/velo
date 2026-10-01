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
        :options="KIND_OPTIONS"
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
        <SchoolMemberRow
          v-for="member in items"
          :key="member.user_id"
          :member="member"
          @open="openMember"
        />

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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getCuratorGroupMembers, type CuratorGroupMemberKind } from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { CuratorGroupMemberItem } from '@/api/types'
import { IconLock } from '@/components/icons'
import SchoolMemberRow from '@/components/shared/SchoolMemberRow.vue'
import VShowMore from '@/components/shared/VShowMore.vue'
import { VButton, VEmptyState, VInput, VLoader, VSegmentTrack } from '@/components/ui'
import VHeader from '@/components/layout/VHeader.vue'
import { usePagination } from '@/composables/usePagination'
import { useToast } from '@/composables/useToast'

// §1.11 (owner 2026-09-22): the active roster rides ?kind= -- server truth
// in the URL, so a refresh or a deep link reopens the same list. The third
// tab «Блок» (owner 2026-09-30) is a BE-79 placeholder: no endpoint lists
// blocked members yet, so the tab never fetches -- it renders the lock
// empty state and hides the search. It is a view-local MemberTab, NOT
// CuratorGroupMemberKind, so the API contract stays honest until the
// backend lands.
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
    return 'Участник появится здесь, когда куратор заблокирует его через меню на странице профиля.'
  }
  return kind.value === 'master'
    ? 'Мастером школы участник становится после принятия предложения куратора.'
    : 'Ученики появляются в школе после вступления по ссылке-приглашению.'
})
const errorTitle = computed(() =>
  kind.value === 'master' ? 'Не удалось загрузить мастеров' : 'Не удалось загрузить учеников',
)

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

const { items, loading, error, loadMoreError, hasMore, loadMore, refresh } =
  usePagination<CuratorGroupMemberItem>((limit, offset) => {
    // BE-79 pending: no endpoint lists blocked members -- the tab is a
    // placeholder screen, never a fake request.
    if (kind.value === 'blocked') {
      return Promise.resolve({ items: [], total: 0, limit, offset })
    }
    return getCuratorGroupMembers(groupId.value, {
      kind: kind.value,
      search: trimmedSearch.value || undefined,
      limit,
      offset,
    }).catch((e: unknown) => {
      if (e instanceof ApiResponseError && e.status === 404) notFound.value = true
      throw e
    })
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

function openMember(member: CuratorGroupMemberItem): void {
  // A master opens the EXISTING public profile (any zone can render it --
  // no guard on /user/masters/:id). A student has no public page, so their
  // school-context profile carries the curator actions instead.
  if (kind.value === 'master') {
    // Owner ruling 2026-09-30: the master's page carries the curator's action
    // menu when opened from the school context -- the roster passes the
    // ?groupId= marker that turns the menu on (no new route, no new screen).
    void router.push({
      name: 'user-master-public',
      params: { id: member.user_id },
      query: { groupId: groupId.value, name: member.name, avatar: member.avatar_url ?? '' },
    })
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
