<!--
  VELO Frontend -- MasterStudentsView (Master DS, 2026-06-11)

  "Мои ученики" — the master's students list. Reached from the dashboard row.
  Rendered inside MasterShell.

  LIVE (E5): getStudents() → GET /api/v1/masters/me/students →
  PaginatedStudentsResponse { items: StudentListItem[], total, limit, offset };
  each item = { id, name, avatar_url, practices_count, needs_attention }.
  Search filters the loaded page client-side. The message action opens the
  shared send-message sheet, which posts into the eternal DM (T3 chat).
-->

<template>
  <div class="students">
    <VHeader title="Мои ученики" show-back @back="router.push({ name: 'master-dashboard' })" />

    <div class="students__content">
      <!-- Loading -->
      <div v-if="loading" class="students__state">
        <VLoader size="lg" />
      </div>

      <!-- Error -->
      <VEmptyState
        v-else-if="error"
        icon="warning"
        title="Не удалось загрузить учеников"
        :description="error"
      >
        <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
      </VEmptyState>

      <template v-else>
        <!-- Search: DS pattern — VInput glass pill + magnifier, uniform with the
             user/diary search (DiarySearchModal). Static glass fill (no live
             backdrop-filter) → no keyboard-focus flicker. Live client-side filter. -->
        <div class="students__search">
          <div class="students__search-field">
            <VInput
              v-model="query"
              placeholder="Искать…"
              aria-label="Искать ученика"
              @focus="onFieldFocus"
            />
          </div>
          <span class="students__search-btn" aria-hidden="true"><IconSearch :size="20" /></span>
        </div>

        <!-- List -->
        <div
          v-for="student in visibleStudents"
          :key="student.id"
          class="students__row"
          role="button"
          tabindex="0"
          @click="openProfile(student)"
          @keydown.enter.space.prevent="openProfile(student)"
        >
          <VAvatar :name="student.name" size="md" />
          <div class="students__body">
            <div class="students__name">{{ student.name }}</div>
            <div class="students__meta">Практик: {{ student.practices_count }}</div>
            <span v-if="student.needs_attention" class="students__attn">
              <IconWarning :size="14" />Требует внимания
            </span>
          </div>
          <button
            class="students__msg"
            aria-label="Написать сообщение"
            @click.stop="openMessage(student.id, student.name)"
          >
            <IconMessages :size="22" />
          </button>
        </div>

        <!-- Reveal the rest when there are more than the preview cap. -->
        <VShowMore
          v-if="!expanded && hiddenCount > 0"
          :count="hiddenCount"
          noun="учеников"
          @click="expanded = true"
        />

        <!-- Empty: no students at all vs no search match -->
        <VEmptyState
          v-if="students.length === 0"
          icon="group"
          title="Учеников пока нет"
          description="Они появятся после первых практик"
        />
        <VEmptyState
          v-else-if="filtered.length === 0"
          icon="group"
          title="Никого не найдено"
          description="Попробуйте изменить запрос"
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
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VAvatar, VEmptyState, VLoader, VButton, VInput } from '@/components/ui'
import { IconSearch, IconWarning, IconMessages } from '@/components/icons'
import SendMessageModal from '@/components/shared/SendMessageModal.vue'
import VShowMore from '@/components/shared/VShowMore.vue'
import { getStudents } from '@/api/masters'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import type { StudentListItem } from '@/api/types'

const router = useRouter()

// Lift the search field above the soft keyboard once it settles (shared M5
// composable) so it's not left under the keyboard on focus (K3).
const { onFieldFocus } = useKeyboardFieldScroll()

// -- Students (E5: GET /masters/me/students). Search filters the loaded page
//    client-side; needs_attention drives the inline warning badge. --
const students = ref<StudentListItem[]>([])
const loading = ref(true)
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await getStudents()
    students.value = res.items
  } catch {
    error.value = 'Попробуйте ещё раз'
  } finally {
    loading.value = false
  }
}
onMounted(load)

const query = ref('')
const filtered = computed((): StudentListItem[] => {
  const q = query.value.trim().toLowerCase()
  if (!q) return students.value
  return students.value.filter((s) => s.name.toLowerCase().includes(q))
})

// Show the first 10; the rest hide behind a «+ ещё N учеников» pill until tapped
// (operator 2026-06-25). The cap applies to the current (search-)filtered list.
const STUDENTS_PREVIEW = 10
const expanded = ref(false)
const visibleStudents = computed((): StudentListItem[] =>
  expanded.value ? filtered.value : filtered.value.slice(0, STUDENTS_PREVIEW),
)
const hiddenCount = computed((): number => Math.max(0, filtered.value.length - STUDENTS_PREVIEW))

// The detail endpoint carries no name → pass it forward from the list row.
function openProfile(student: StudentListItem): void {
  router.push({
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

.students__body {
  flex: 1;
  min-width: 0;
}

.students__name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.students__meta {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin-top: var(--velo-gap-2);
}

.students__attn {
  display: inline-flex;
  align-items: center;
  gap: var(--velo-card-gap-icon-title);
  margin-top: var(--velo-gap-6);
  padding: 3px 10px;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-warning-bg);
  color: var(--velo-peach-500);
  font-size: var(--text-xs);
}

.students__attn svg {
  color: var(--velo-warning);
}

.students__msg {
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
