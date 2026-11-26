<!--
  VELO Frontend -- MasterStudentsView (Master DS, 2026-06-11)

  The my-students screen (i18n:masterScreens.masterStudents.title) — the
  master's students list. Reached from the dashboard row.
  Rendered inside MasterShell.

  LIVE (E5): getStudents() → GET /api/v1/masters/me/students →
  PaginatedStudentsResponse { items: StudentListItem[], total, limit, offset };
  each item = { id, name, avatar_url, practices_count, needs_attention }.
  Every page is read (useAllPages, FE-260) and the search filters them
  client-side; past the read cap a line says how many of the total show. The message action opens the
  shared send-message sheet, which posts into the eternal DM (T3 chat).
-->

<template>
  <div class="students">
    <VHeader
      :title="t('masterScreens.masterStudents.title')"
      show-back
      @back="router.push({ name: 'master-dashboard' })"
    />

    <div class="students__content">
      <!-- Loading -->
      <div v-if="loading" class="students__state">
        <VLoader size="lg" />
      </div>

      <!-- Error -->
      <VEmptyState
        v-else-if="error"
        icon="warning"
        :title="t('masterScreens.masterStudents.toast.loadFailed')"
        :description="error"
      >
        <VButton size="sm" variant="outline" @click="load">{{ t('common.retry') }}</VButton>
      </VEmptyState>

      <template v-else>
        <!-- Search: DS pattern — VInput glass pill + magnifier, uniform with the
             user/diary search (DiarySearchModal). Static glass fill (no live
             backdrop-filter) → no keyboard-focus flicker. Live client-side filter. -->
        <div class="students__search">
          <div class="students__search-field">
            <VInput
              v-model="query"
              kind="search"
              :placeholder="t('masterScreens.masterStudents.search.placeholder')"
              :aria-label="t('masterScreens.masterStudents.search.aria')"
              @focus="onFieldFocus"
            />
          </div>
          <span class="students__search-btn" aria-hidden="true"><IconSearch :size="20" /></span>
        </div>

        <!-- List. A row is two sibling buttons: a button must not hold another
             interactive control. The open button's ::after covers the whole
             row, so a tap anywhere on it opens the profile; the message button
             sits above that layer. A button holds phrasing content only, hence
             the spans. -->
        <div v-for="student in visibleStudents" :key="student.id" class="students__row">
          <button type="button" class="students__open velo-btn-reset" @click="openProfile(student)">
            <VAvatar :name="student.name" size="md" />
            <span class="students__body">
              <span class="students__name">{{ student.name }}</span>
              <span class="students__meta">
                {{ t('masterScreens.masterCommon.practicesCount', { n: student.practices_count }) }}
              </span>
              <span v-if="student.needs_attention" class="students__attn">
                <IconWarning :size="14" />{{ t('masterScreens.masterStudents.needsAttention') }}
              </span>
            </span>
          </button>
          <button
            type="button"
            class="students__msg"
            :aria-label="t('common.writeMessage')"
            @click="openMessage(student.id, student.name)"
          >
            <IconMessages :size="22" />
          </button>
        </div>

        <!-- Reveal the rest when there are more than the preview cap. -->
        <VShowMore
          v-if="!expanded && hiddenCount > 0"
          plus
          :label="t('masterScreens.masterStudents.moreStudents', hiddenCount)"
          @click="expanded = true"
        />

        <p v-if="!complete" class="students__partial">
          {{ t('masterScreens.masterCommon.shownOf', { shown: students.length, total }) }}
        </p>

        <!-- Empty: no students at all vs no search match -->
        <VEmptyState
          v-if="students.length === 0"
          icon="group"
          :title="t('masterScreens.masterStudents.empty.title')"
          :description="t('masterScreens.masterStudents.empty.text')"
        />
        <VEmptyState
          v-else-if="filtered.length === 0"
          icon="group"
          :title="t('common.searchNoHits')"
          :description="t('common.searchHint')"
        />
      </template>
    </div>

    <SendMessageModal
      :open="msgOpen"
      :student-id="msgId"
      :name="msgName"
      @close="msgOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VAvatar, VEmptyState, VLoader, VButton, VInput } from '@/components/ui'
import { IconSearch, IconWarning, IconMessages } from '@/components/icons'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import VShowMore from '@/components/shared/VShowMore.vue'
import { getStudents } from '@/api/masters'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { useAllPages } from '@/composables/useAllPages'
import type { StudentListItem } from '@/api/types'

const router = useRouter()

// Lift the search field above the soft keyboard once it settles (shared M5
// composable) so it's not left under the keyboard on focus (K3).
const { onFieldFocus } = useKeyboardFieldScroll()

// -- Students (E5: GET /masters/me/students), every page of them. Search
//    filters them client-side; needs_attention drives the inline warning badge. --
const {
  items: students,
  total,
  complete,
  loading,
  failed,
  load,
} = useAllPages<StudentListItem>(getStudents, true)
const error = computed(() => (failed.value ? t('common.tryAgain') : ''))
onMounted(load)

const query = ref('')
const filtered = computed((): StudentListItem[] => {
  const q = query.value.trim().toLowerCase()
  if (!q) return students.value
  return students.value.filter((s) => s.name.toLowerCase().includes(q))
})

// Show the first 10; the rest hide behind a "+ more students" pill (resolves
// via `t('masterScreens.masterStudents.moreStudents', hiddenCount)`) until
// tapped (operator 2026-06-25). The cap applies to the current
// (search-)filtered list.
const STUDENTS_PREVIEW = 10
const expanded = ref(false)
const visibleStudents = computed((): StudentListItem[] =>
  expanded.value ? filtered.value : filtered.value.slice(0, STUDENTS_PREVIEW),
)
const hiddenCount = computed((): number => Math.max(0, filtered.value.length - STUDENTS_PREVIEW))

// The detail endpoint carries no name → pass it forward from the list row.
function openProfile(student: StudentListItem): void {
  void router.push({
    name: 'master-student-profile',
    params: { id: student.id },
    query: { name: student.name },
  })
}

// -- Send-message sheet (REAL: posts into the eternal DM with the student) --
const msgOpen = ref(false)
const msgId = ref('')
const msgName = ref('')
function openMessage(id: string, name: string): void {
  msgId.value = id
  msgName.value = name
  msgOpen.value = true
}
</script>

<style scoped>
.students {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.students__content {
  flex: 1;
  /* F-5 rail sync: ride MobileLayout's 24px rail (no local h-padding).
     Top trimmed to raise the search closer to the header (design «3 Students»). */
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  /* Inter-card spacing tightened to the design (~10px → nearest token). */
  gap: var(--space-2);
}

.students__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* -- Search: DS VInput glass pill + magnifier, uniform with the user/diary
      search (DiarySearchModal). Same VInput primitive + glass-pill override, so
      there is no bespoke search form here. The glass fill is STATIC (no
      backdrop-filter) → focusing it never re-samples the keyboard-displaced
      fixed background, which is what flickered on iOS/Telegram webview. -- */
.students__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* Gap to the first student card (design ~25px = space-2 row gap + this). */
  margin-bottom: var(--space-4);
}

.students__search-field {
  flex: 1;
  min-width: 0;
}

/* Drop VInput's default bottom margin so the magnifier centers on the field row
   (same fix DiarySearchModal applies). */
.students__search-field :deep(.v-input) {
  margin-bottom: 0;
}

/* Glass-blue pill, overriding VInput's white plate — the diary search standard. */
.students__search-field :deep(.v-input__field) {
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-full);
}

.students__search-btn {
  width: var(--velo-size-44);
  height: var(--velo-size-44);
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* -- Student row -- */
.students__row {
  /* Positioning context of the open button's ::after. */
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--velo-card-padding-y) var(--space-4);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.students__row:active {
  opacity: 0.85;
}

/* The open button is the row's content (avatar + text). Its ::after covers the
   whole row, so a tap anywhere on the row opens the profile. */
.students__open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.students__open::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

/* The keyboard ring goes round the whole row, not only the avatar and text.
   Without :has() support the button keeps its own ring. */
@supports selector(:has(*)) {
  .students__open:focus-visible {
    outline: none;
  }

  .students__row:has(.students__open:focus-visible) {
    outline: 2px solid var(--velo-border-input-focus);
  }
}

.students__body {
  display: block;
  flex: 1;
  min-width: 0;
}

.students__name {
  display: block;
  font-family: var(--font-body);
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
}

.students__partial {
  margin: 0;
  font-family: var(--font-body);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  text-align: center;
}

.students__meta {
  display: block;
  font-family: var(--font-body);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  margin-top: var(--velo-gap-2);
}

.students__attn {
  display: inline-flex;
  align-items: center;
  gap: var(--velo-card-gap-icon-title);
  margin-top: var(--velo-gap-6);
  padding: var(--velo-gap-3) var(--velo-gap-11);
  border-radius: var(--velo-radius-badge);
  background: var(--velo-warning-bg);
  color: var(--velo-peach-500);
  font-size: var(--velo-fs-14);
}

.students__attn svg {
  color: var(--velo-warning);
}

.students__msg {
  /* Stacks above the open button's ::after, which covers the row. */
  position: relative;
  width: var(--velo-size-46);
  height: var(--velo-size-46);
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

.students__msg:active {
  opacity: 0.85;
}
</style>
