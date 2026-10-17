<!--
  VELO Frontend -- VMoreLink (единый контрол «Подробнее»)

  ОДИН вид «forward»-ссылки на весь проект: текст-лейбл слева + белый pill
  со стрелкой `IconArrowRight` справа (тот же белый pill 63×40, что у
  VBackButton — «понятная стрелка на белом фоне»). Слово идёт ПЕРЕД стрелкой.

  Канон зафиксирован оператором 2026-06-04: чтобы «Подробнее» нигде не
  разъезжался — все use-sites берут этот компонент, а не верстают вручную.

  Use-sites: MasterCard («Подробнее» -> профиль мастера), UserDashboardView
  (AI-саммари -> детальный экран). Навигация — на стороне вызывающего (emit click).

  Usage:
    <VMoreLink @click="router.push(...)" />
    <VMoreLink label="Все отзывы" @click="..." />
-->

<template>
  <button type="button" class="v-more" @click="$emit('click')">
    <span class="v-more__text">{{ label ?? t('ui.more') }}</span>
    <span class="v-more__pill">
      <IconArrowRight :size="18" />
    </span>
  </button>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { IconArrowRight } from '@/components/icons'

// tz-i18n 1.3: label fallback resolves at render time (?? t() in template).
const { t } = useI18n({ useScope: 'global' })

defineProps<{
  /** Текст слева от стрелки. По умолчанию «Подробнее» (ui.more). */
  label?: string
}>()

defineEmits<{ click: [] }>()
</script>

<style scoped>
.v-more {
  display: flex;
  align-items: center;
  /* Контент (текст + pill) прижат вправо; width:100% — чтобы прижатие
   * работало в любом родителе (не только при stretch-колонке). */
  justify-content: flex-end;
  width: 100%;
  gap: var(--space-3);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.v-more:hover,
.v-more:active {
  opacity: 0.8;
}

.v-more__text {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  letter-spacing: var(--velo-card-letter-spacing-meta);
  color: var(--velo-text-primary);
}

/* Белый pill со стрелкой — те же размеры/вид, что у VBackButton (канон
 * «понятная стрелка на белом фоне»). Стрелка вправо = вперёд. */
.v-more__pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 63px;
  height: var(--velo-size-40);
  border-radius: var(--radius-full);
  background: var(--velo-bg-card-solid);
  color: var(--velo-text-primary);
}
</style>
