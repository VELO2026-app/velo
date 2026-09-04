<!--
  VELO Frontend -- AdminCuratorGroupsView (schools FE-23 / GT P4)

  Read-only list of EVERY school, including frozen ones -- the only place in
  the system where an inactive school is visible at all (for its own members
  it is indistinguishable from a deleted one, I-6). is_active is rendered as
  a badge, NOT offered as a filter: the admin is the person being asked
  "why has my school gone quiet", and both kinds belong in one answer.

  No delete/edit actions live here on purpose -- the ONE moderation lever
  for schools is the existing master-verification revoke, which freezes all
  of a curator's schools at once; a tap opens the curator's own review page
  where that lever already is.
-->

<template>
  <div class="admin-list">
    <header class="admin-list__top">
      <VBackButton @click="router.push({ name: 'admin-masters' })" />
      <h1 class="admin-list__title">Школы</h1>
      <span class="admin-list__count">{{ total || '—' }}</span>
    </header>

    <div v-if="loading && !groups.length" class="admin-list__loader"><VLoader size="lg" /></div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить школы"
      description="Проверьте соединение и попробуйте ещё раз"
    >
      <template #action
        ><VButton variant="primary" @click="load(true)">Повторить</VButton></template
      >
    </VEmptyState>

    <template v-else-if="groups.length">
      <div class="admin-list__items">
        <button
          v-for="g in groups"
          :key="g.id"
          type="button"
          class="sg-card"
          @click="router.push({ name: 'admin-master-review', params: { id: g.curator.user_id } })"
        >
          <div class="sg-card__head">
            <span class="sg-card__name">{{ g.name }}</span>
            <VBadge :variant="g.is_active ? 'success' : 'muted'">
              {{ g.is_active ? 'Активна' : 'Заморожена' }}
            </VBadge>
          </div>
          <span class="sg-card__curator">Куратор: {{ g.curator.display_name || '—' }}</span>
          <span class="sg-card__meta">
            Мастеров: {{ g.masters_count }} • Учеников: {{ g.students_count }} • с
            {{ createdLabel(g.created_at) }}
          </span>
        </button>
      </div>

      <div v-if="hasMore" class="admin-list__more">
        <VButton variant="outline" :loading="loading" @click="load(false)">Показать ещё</VButton>
      </div>
    </template>

    <VCard v-else><p class="admin-list__empty">Школ пока нет</p></VCard>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VBadge, VButton, VCard, VEmptyState, VLoader } from '@/components/ui'
import { getAdminCuratorGroups } from '@/api/curatorGroups'
import type { AdminCuratorGroupListItem } from '@/api/types'
import { useToast } from '@/composables/useToast'

const PAGE = 100

const router = useRouter()
const toast = useToast()

const groups = ref<AdminCuratorGroupListItem[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref(false)
const hasMore = computed(() => groups.value.length < total.value)

async function load(reset: boolean): Promise<void> {
  if (loading.value) return
  loading.value = true
  if (reset) error.value = false
  try {
    const offset = reset ? 0 : groups.value.length
    const res = await getAdminCuratorGroups(PAGE, offset)
    total.value = res.total
    groups.value = reset ? res.items : [...groups.value, ...res.items]
  } catch {
    toast.error('Не удалось загрузить школы')
    // W12 discipline: only a failed FIRST page is an error state; a failed
    // loadMore keeps the loaded page and toasts.
    if (reset) error.value = true
  } finally {
    loading.value = false
  }
}

// "Авг 2026" — school creation month, from created_at (UTC).
function createdLabel(iso: string): string {
  const d = new Date(iso)
  const month = new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: 'UTC' })
    .format(d)
    .replace('.', '')
  return `${month.charAt(0).toUpperCase()}${month.slice(1)} ${d.getUTCFullYear()}`
}

onMounted(() => load(true))
</script>

<style scoped>
.admin-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Same admin-list chrome as AdminParticipantsView (back + title + count). */
.admin-list__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.admin-list__title {
  font-family: var(--font-body);
  font-size: var(--text-2xl);
  color: var(--velo-text-primary);
  margin: 0;
  flex: 1;
}

.admin-list__count {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  background: var(--velo-glass-blue-15);
  border-radius: var(--radius-full);
  padding: 2px 12px;
}

.admin-list__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.admin-list__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

.admin-list__more {
  display: flex;
  justify-content: center;
}

.admin-list__empty {
  margin: 0;
  color: var(--velo-text-secondary);
  text-align: center;
}

/* School card: name + frozen/active badge, curator, counts, creation. */
.sg-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  text-align: left;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  font-family: var(--font-body);
}

.sg-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.sg-card__name {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.sg-card__curator {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}

.sg-card__meta {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}
</style>
