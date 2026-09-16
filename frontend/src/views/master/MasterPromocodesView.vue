<!--
  VELO Frontend -- MasterPromocodesView (promocodes list)

  Route /master/promocodes, «4 Promo codes» design. E10 (2026-07-01): wired to
  the delivered backend — GET /masters/me/promos (list) + PATCH .../deactivate.
  Shows the master's ACTIVE promo codes; «Удалить» soft-deactivates (backend has
  no hard delete), which drops it from the active list. Create still routes to
  the create form; copy writes to the clipboard.
-->

<template>
  <div class="promo">
    <VHeader title="Промокоды" show-back @back="router.back()">
      <template #action>
        <button type="button" class="promo__add" aria-label="Новый промокод" @click="onNew">
          <IconPlus :size="20" />
        </button>
      </template>
    </VHeader>

    <!-- Loading -->
    <div v-if="loading && promos.length === 0" class="promo__loader">
      <VLoader size="lg" />
    </div>

    <!-- Error -->
    <VEmptyState v-else-if="error" icon="warning" title="Не удалось загрузить промокоды">
      <VButton size="sm" variant="outline" @click="load">Повторить</VButton>
    </VEmptyState>

    <!-- Empty -->
    <VEmptyState
      v-else-if="activePromos.length === 0"
      icon="list"
      title="Промокодов пока нет"
      description="Создайте первый промокод для участников"
    >
      <VButton size="sm" variant="outline" @click="onNew">Создать</VButton>
    </VEmptyState>

    <!-- List -->
    <div v-else class="promo__list">
      <div v-for="p in activePromos" :key="p.id" class="promo__item">
        <div class="promo__card">
          <span class="promo__icon"><IconPromo :size="40" /></span>
          <span class="promo__divider" aria-hidden="true"></span>
          <div class="promo__info">
            <div class="promo__code">{{ p.code }}</div>
            <div class="promo__meta">
              <div>Скидка: {{ p.discount_percent }}%</div>
              <div>Использовано: {{ usedLabel(p) }}</div>
              <div>Действует до: {{ untilLabel(p) }}</div>
            </div>
          </div>
        </div>
        <div class="promo__actions">
          <VButton variant="primary" @click="onCopy(p.code)">Копировать</VButton>
          <VButton variant="danger" :loading="deactivatingId === p.id" @click="onDelete(p)">
            Удалить
          </VButton>
        </div>
      </div>
    </div>

    <Banner
      variant="warning"
      body="Промокоды для участников, которые уже оплатили вне платформы"
      class="promo__note"
    >
      <template #icon><IconHint :size="22" /></template>
    </Banner>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VLoader, VEmptyState } from '@/components/ui'
import Banner from '@/components/shared/Banner.vue'
import { IconPlus, IconPromo, IconHint } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { getMyPromos, deactivatePromo } from '@/api/promos'
import { formatShortDate } from '@/utils/format'
import type { PromoResponse } from '@/api/types'

const router = useRouter()
const toast = useToast()

// E10: real promo list. Show ACTIVE codes; deactivating one drops it from the
// active list (backend soft-deactivate — no hard delete).
const promos = ref<PromoResponse[]>([])
const loading = ref(false)
const error = ref(false)
const deactivatingId = ref<string | null>(null)

const activePromos = computed((): PromoResponse[] => promos.value.filter((p) => p.is_active))

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  try {
    const res = await getMyPromos()
    promos.value = res.items
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

function usedLabel(p: PromoResponse): string {
  return `${p.used_count} из ${p.max_uses ?? '∞'}`
}
function untilLabel(p: PromoResponse): string {
  return p.valid_until ? formatShortDate(p.valid_until) : 'бессрочно'
}

function onNew(): void {
  void router.push({ name: 'master-promocode-new' })
}
// Copy needs no backend — write the code straight to the clipboard (B2).
async function onCopy(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code)
    toast.success('Промокод скопирован')
  } catch {
    toast.error('Не удалось скопировать')
  }
}
// Soft-deactivate (no hard-delete endpoint): drops the code from the active list.
async function onDelete(p: PromoResponse): Promise<void> {
  if (deactivatingId.value) return
  deactivatingId.value = p.id
  try {
    await deactivatePromo(p.id)
    p.is_active = false
    toast.success('Промокод деактивирован')
  } catch {
    toast.error('Не удалось деактивировать промокод')
  } finally {
    deactivatingId.value = null
  }
}

onMounted(load)
</script>

<style scoped>
.promo {
  display: flex;
  flex-direction: column;
}

.promo__add {
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  border-radius: var(--radius-full);
  border: none;
  background: var(--velo-primary);
  color: var(--velo-white);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.promo__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.promo__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-4) 0;
}

.promo__item {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.promo__card {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-4);
}

.promo__icon {
  flex-shrink: 0;
  color: var(--velo-primary);
}

.promo__divider {
  align-self: stretch;
  width: 0;
  border-left: var(--velo-divider-width) dashed var(--velo-divider);
}

.promo__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.promo__code {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.promo__meta {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.6;
}

.promo__actions {
  display: flex;
  gap: var(--space-3);
}

.promo__actions > * {
  flex: 1;
}

.promo__note {
  margin-top: var(--space-2);
}
</style>
