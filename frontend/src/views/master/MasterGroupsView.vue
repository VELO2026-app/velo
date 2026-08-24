<!--
  VELO Frontend -- MasterGroupsView (Master GROUPS P2, PROMPT №591)

  "Мои группы" -- replaces "Мои ученики" as the dashboard entry. Lists the
  two virtual groups («Ученики» always first, «Удалённые» last and omitted
  when empty) plus every custom group, in the order the backend returns
  (GET /masters/me/groups).

  Reuses VListRow (row shell), VShowMore (the "+ ещё N групп" expander) --
  no bespoke visual component, DS tokens only.

  G2 (PROMPT №609, owner-ruled): the per-card «share» + «⋯» actions
  (invite/rename/delete) MOVED into MasterGroupDetailView's header menu --
  reachable from there for ANY group (empty or not), not just the ones the
  old empty-group CTA covered. Cards here are plain, tap-to-open rows now.

  G1 (PROMPT №609, owner-ruled): ONE search field matches BOTH group names
  (client-side, over the already-loaded `groups`) AND people across CUSTOM
  groups (server-side, debounced -- the original P6/PROMPT №607 people
  search, unchanged in mechanism). The two result kinds are VISUALLY
  SEPARATED under their own section heading (Группы / Участники) rather
  than interleaved, so they never blur into one list -- groups first
  (this screen's own primary content), people below (the wider,
  cross-group search). Empty query -> the groups list unchanged (below).
-->

<template>
  <div class="groups">
    <VHeader title="Мои группы" show-back @back="router.push({ name: 'master-dashboard' })">
      <!-- G3 (PROMPT №609): top-right, same row as the title (measured
           from the owner's SVG: 40px circle, right-aligned to the cards'
           own right edge -- VHeader's #action slot already sits flush
           with the header row's right side, same rail). -->
      <template #action>
        <button type="button" class="groups__add-btn" aria-label="Новая группа" @click="onCreate">
          <IconPlusFilled :size="20" />
        </button>
      </template>
    </VHeader>

    <div class="groups__content">
      <!-- T24-21/22/23 (PROMPT №639): restyled to the owner's measured search
           field -- white glow (not a border), no magnifier button (the field
           already self-triggers via its own watch()+debounce below), stretched
           to the group cards' own width. Deliberately NOT the same as
           MasterStudentsView's search field anymore (see the delivery report
           on whether a shared component is worth extracting now). -->
      <div class="groups__search">
        <div class="groups__search-field">
          <VInput
            v-model="search"
            placeholder="Искать..."
            aria-label="Искать по группам и участникам"
            @focus="onFieldFocus"
          />
        </div>
      </div>

      <template v-if="search.trim()">
        <!-- Group-name matches: instant, client-side over already-loaded groups. -->
        <template v-if="matchingGroups.length">
          <h2 class="velo-section-title groups__search-heading">Группы</h2>
          <div
            v-for="group in matchingGroups"
            :key="group.id"
            class="groups__row-wrap"
            role="button"
            tabindex="0"
            @click="openDetail(group)"
            @keydown.enter.space.prevent="openDetail(group)"
          >
            <VListRow :title="group.name" :subtitle="`Участников: ${group.members_count}`" />
          </div>
        </template>

        <!-- People matches: server-side, debounced (P6, PROMPT №607 mechanism unchanged). -->
        <div v-if="searchLoading" class="groups__state">
          <VLoader size="lg" />
        </div>

        <VEmptyState
          v-else-if="searchError"
          icon="warning"
          title="Не удалось выполнить поиск"
          :description="searchError"
        >
          <VButton size="sm" variant="outline" @click="loadSearch">Повторить</VButton>
        </VEmptyState>

        <template v-else-if="searchResults.length">
          <h2 class="velo-section-title groups__search-heading">Участники</h2>
          <VListRow
            v-for="row in searchResults"
            :key="`${row.student_user_id}-${row.group_id}`"
            :title="row.name"
          >
            <template #lead>
              <VAvatar :name="row.name" :url="row.avatar_url ?? undefined" size="md" />
            </template>
            <template #trailing>
              <VChip>{{ row.group_name }}</VChip>
            </template>
          </VListRow>
        </template>

        <!-- Combined empty: NEITHER kind matched (not loading, not erroring). -->
        <VEmptyState
          v-if="
            !searchLoading &&
            !searchError &&
            matchingGroups.length === 0 &&
            searchResults.length === 0
          "
          icon="group"
          title="Никого не найдено"
          description="Попробуйте изменить запрос"
        />
      </template>

      <!-- Loading (groups list) -->
      <div v-else-if="loading" class="groups__state">
        <VLoader size="lg" />
      </div>

      <!-- Error (groups list) -->
      <VEmptyState
        v-else-if="error"
        icon="warning"
        title="Не удалось загрузить группы"
        :description="error"
      >
        <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
      </VEmptyState>

      <template v-else>
        <div
          v-for="group in visibleGroups"
          :key="group.id"
          class="groups__row-wrap"
          role="button"
          tabindex="0"
          @click="openDetail(group)"
          @keydown.enter.space.prevent="openDetail(group)"
        >
          <VListRow :title="group.name" :subtitle="`Участников: ${group.members_count}`" />
        </div>

        <VShowMore
          v-if="!expanded && hiddenCount > 0"
          :count="hiddenCount"
          :noun="plural(hiddenCount, 'группа', 'группы', 'групп')"
          @click="expanded = true"
        />

        <VEmptyState
          v-if="groups.length === 0"
          icon="group"
          title="Групп пока нет"
          description="Создайте первую группу учеников"
        />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VLoader, VEmptyState, VButton, VListRow, VInput, VAvatar, VChip } from '@/components/ui'
import { IconPlusFilled } from '@/components/icons'
import VShowMore from '@/components/shared/VShowMore.vue'
import { getGroups, searchGroupMemberships } from '@/api/groups'
import { extractApiError } from '@/composables/useApiError'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { plural } from '@/utils/plural'
import type { GroupListItem, GroupSearchMemberItem } from '@/api/groups'

const router = useRouter()
const { onFieldFocus } = useKeyboardFieldScroll()

const groups = ref<GroupListItem[]>([])
const loading = ref(true)
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await getGroups()
    groups.value = res.items
  } catch (e) {
    error.value = extractApiError(e, 'Попробуйте ещё раз')
  } finally {
    loading.value = false
  }
}
onMounted(load)

// -- Cross-group people-search (P6, PROMPT №607) --
// One row per (person, CUSTOM group) MEMBERSHIP -- owner-approved preview,
// deliberately NOT deduped. Server-side + debounced exactly like
// MasterGroupDetailView's own member search (same 300ms, same
// watch+setTimeout shape). The backend requires search to be non-empty
// (min_length=1), so an empty query is never sent -- see the early return
// in the watcher below, which also clears any stale results.
const search = ref('')
const searchResults = ref<GroupSearchMemberItem[]>([])
const searchLoading = ref(false)
const searchError = ref('')

async function loadSearch(): Promise<void> {
  searchLoading.value = true
  searchError.value = ''
  try {
    const res = await searchGroupMemberships(search.value)
    searchResults.value = res.items
  } catch (e) {
    searchError.value = extractApiError(e, 'Попробуйте ещё раз')
  } finally {
    searchLoading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, (value) => {
  clearTimeout(searchTimer)
  if (!value.trim()) {
    searchResults.value = []
    searchError.value = ''
    return
  }
  searchTimer = setTimeout(loadSearch, 300)
})

// Show the first 5 (owner Q7, PROMPT №610 -- was 10); the rest hide behind
// the outlined "+ ещё N групп" pill (VShowMore already built this exact
// recipe -- primary stroke + primary text, see that file -- no visual
// change needed there, only this constant). Never applies while a search
// query is active: that's a structurally separate branch above
// (`v-if="search.trim()"`), which renders ALL of `matchingGroups`
// un-truncated -- search results are never hidden behind this expander.
const GROUPS_PREVIEW = 5
const expanded = ref(false)
const visibleGroups = computed((): GroupListItem[] =>
  expanded.value ? groups.value : groups.value.slice(0, GROUPS_PREVIEW),
)
const hiddenCount = computed((): number => Math.max(0, groups.value.length - GROUPS_PREVIEW))

function openDetail(group: GroupListItem): void {
  // Owner Q4 (PROMPT №610): `description` rides along the SAME router-query
  // mechanism `name` already uses -- no new "get one group" endpoint for a
  // value the caller already has in hand. `undefined` (not null) so vue-
  // router omits the query key entirely rather than serializing "null".
  router.push({
    name: 'master-group-detail',
    params: { id: group.id },
    query: { name: group.name, description: group.description ?? undefined },
  })
}

function onCreate(): void {
  router.push({ name: 'master-group-create' })
}

// G1 (PROMPT №609): group-NAME matches -- instant, client-side over the
// already-loaded `groups` (no fetch, unlike the people search below).
// Includes the two virtuals same as the plain list does (no special
// exclusion asked for or implied).
const matchingGroups = computed((): GroupListItem[] => {
  const q = search.value.trim().toLowerCase()
  if (!q) return []
  return groups.value.filter((g) => g.name.toLowerCase().includes(q))
})
</script>

<style scoped>
.groups {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.groups__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.groups__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* -- Cross-group search (P6, PROMPT №607; restyled T24-21/22/23, PROMPT №639) --
   T24-22: the magnifier button is REMOVED (the field already self-triggers
   via its own watch()+debounce below) -- `.groups__search` now wraps only
   the field, so it stretches to the full content width (T24-23), matching
   the group cards (`.groups__row-wrap`) below: both are direct children of
   `.groups__content`, which has zero horizontal padding of its own (rides
   the app-wide rail), so "100% width" IS "same width as the cards" -- not a
   hardcoded px figure (the owner's measured 336px is what HIS canvas
   happened to compute at a specific viewport width, not a fixed target;
   hardcoding it would fight the cards' own fluid width instead of matching
   it). */
.groups__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.groups__search-field {
  flex: 1;
  min-width: 0;
}

.groups__search-field :deep(.v-input) {
  margin-bottom: 0;
}

/* T24-21: height 50 (--velo-size-50, this token's own comment already reads
   "search / chat input field height" -- no new token needed) + radius 25 on
   a 50px-tall field IS --radius-full (any radius >= half the height renders
   the same maximal pill, confirmed against the owner's own number) + fill
   --velo-primary at 15% is --velo-glass-blue-15 (already the exact rgba of
   --velo-primary at 0.15 -- confirmed, not approximated) -- all three were
   already-tokened, DS-first satisfied without minting anything. */
.groups__search-field :deep(.v-input__field) {
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-full);
  height: var(--velo-size-50);
  /* White glow, NOT a border -- pure white drop shadow, no offset. DERIVED
     FIGURES: the owner relayed dilate 8.82 / blur 13.167 from his design file
     but this session could not reach that file to re-derive them directly --
     built to the relayed numbers verbatim, per his own fallback instruction.
     Distinct from the pre-existing --velo-shadow-glow token (0 0 20.9px 7px
     white) used on MasterGroupDetailView's own search field -- that token's
     own comment already admits it's "the closest EXISTING match" to a
     similarly-measured glow, not this exact value; inlined here rather than
     silently reusing the approximate token for a number given explicitly
     this time. */
  box-shadow: 0 0 13.167px 8.82px #ffffff;
}

/* T24-21: placeholder 16px (--text-16) -- the FIELD's own text stays the DS
   default (--text-base, 18px, VInput's shared size); only the placeholder is
   smaller, per the owner's measurement. Colour is NOT set here on purpose:
   it inherits VInput's [FE-25] --velo-text-placeholder (the readable
   placeholder-only token). The pre-FE-25 comment claimed "kept at
   --velo-text-muted 50%" and recorded a moot 60%-opacity ask (2.57:1) --
   both superseded by the owner's option-B ruling (probekit sweep 2026-08,
   item 9; variables.css:49). */
.groups__search-field :deep(.v-input__field::placeholder) {
  font-size: var(--text-16);
}

.groups__row-wrap {
  cursor: pointer;
}

/* G1 (PROMPT №609): section headings separating group-name matches from
   people matches -- reuses the app-wide velo-section-title class
   (MasterStudentProfileView's «Последние check-ins»/«Feedbacks» recipe),
   just a small top gap since it follows the search field / a prior
   section directly. */
.groups__search-heading {
  margin-top: var(--space-2);
}

/* G3 (PROMPT №609): top-right header control -- measured from the owner's
   SVG (3 My groups.svg): a 40px circle, #627A9C (= --velo-primary), same
   row as the title. No glow specified for this control (unlike the
   search field, G1/G5) -- plain fill only. */
.groups__add-btn {
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.groups__add-btn:active {
  opacity: 0.85;
}
</style>
