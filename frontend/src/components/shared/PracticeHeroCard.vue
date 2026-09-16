<!--
  VELO Frontend -- PracticeHeroCard (shared)

  Hero card used at the top of practice/booking detail screens
  (Figma 15 / 18 / dashboard / Calendar frame 4):
    - Practice icon in a teal circle -- chosen by `direction` (taxonomy);
      falls back to a default glyph when direction is absent/unknown.
    - Title
    - Meta row: date, duration, optional participants
    - Optional difficulty dots ("Сложность **o") -- shown only when
      difficultyDots > 0 (Calendar frame 4). Word level is intentionally
      NOT shown (matches the mockup: label + dots only).
    - Optional #badge slot (e.g. "Оплачено", "LIVE" -- screen 15)

  Props cover all cases:
    - Catalog (frame 4, not booked):  participants shown, difficulty dots, no badge
    - Booked (15):                    no participants, "Оплачено" badge via slot
    - Booking detail (18):            no participants, no badge

  The outer margin is left to the parent -- this is just the card.
-->

<template>
  <div class="hero-card" :class="{ 'hero-card--form': variant === 'form' }">
    <div class="hero-card__icon">
      <component :is="iconComponent" :size="46" />
    </div>
    <h1 class="hero-card__title" :class="{ 'hero-card__title--base': titleSize === 'base' }">
      {{ title }}
    </h1>
    <div class="hero-card__meta">
      <!-- #meta переопределяет встроенный icon-row (form-вариант: Check-in / Feedback). -->
      <slot name="meta">
        <span class="hero-card__meta-item"> <IconCalendar :size="14" /> {{ date }} </span>
        <!-- duration optional: master review heads omit it (date + participants only). -->
        <span v-if="duration" class="hero-card__meta-item">
          <IconClock :size="14" /> {{ duration }}
        </span>
        <span v-if="participants" class="hero-card__meta-item">
          <IconGroup :size="14" /> {{ participants }}
        </span>
        <span v-if="recurrence" class="hero-card__meta-item">
          <IconRepeat :size="14" /> {{ recurrence }}
        </span>
        <slot name="badge" />
      </slot>
    </div>

    <!-- Difficulty dots (Calendar frame 4): label + dots only, no word level. -->
    <div v-if="difficultyDots > 0" class="hero-card__difficulty">
      <span class="hero-card__difficulty-label">Сложность</span>
      <span class="hero-card__difficulty-dots" :aria-label="difficultyLabel || undefined">
        <span
          v-for="n in 3"
          :key="n"
          class="hero-card__difficulty-dot"
          :class="{ 'hero-card__difficulty-dot--on': n <= difficultyDots }"
        />
      </span>
    </div>

    <!-- Additive optional row below meta/difficulty (e.g. master detail's rating-
         distribution badges). Default-empty -> existing consumers render unchanged. -->
    <div v-if="$slots.extra" class="hero-card__extra"><slot name="extra" /></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { IconCalendar, IconClock, IconGroup, IconRepeat } from '@/components/icons'
import { DIRECTION_ICON, DIRECTION_ICON_FALLBACK } from '@/utils/displayHelpers'
import type { PracticeDirection } from '@/api/types'

const props = withDefaults(
  defineProps<{
    title: string
    /** Layout variant. 'hero' (default) — detail-экраны. 'form' — practice-header
     *  Check-in / Feedback: меньший заголовок, meta как grid 1fr/1fr через #meta. */
    variant?: 'hero' | 'form'
    /** Title size in the hero variant. 'lg' (default) keeps every existing
     *  consumer unchanged; 'base' is the master-head canon (Reviews shrinks). */
    titleSize?: 'lg' | 'base'
    /** Built-in meta. Нужны только когда слот #meta НЕ передан (hero-вариант). */
    date?: string
    duration?: string
    /** Optional "N / M" participants string. Omit to hide (booked / detail). */
    participants?: string | null
    /** Optional recurrence label («Пн, Ср, Пт» / «Ежедневно» / «Регулярная»). Omit to hide. */
    recurrence?: string | null
    /** Content direction (taxonomy) -- taxonomy values (PracticeDirection)
     *  pick the dedicated hero glyph; unknown/absent falls back to default. */
    direction?: string | null
    /** Filled-dot count for difficulty (0 hides the block). */
    difficultyDots?: number
    /** Human difficulty label -- used for aria only (not rendered as text). */
    difficultyLabel?: string
  }>(),
  {
    variant: 'hero',
    titleSize: 'lg',
    date: '',
    duration: '',
    participants: null,
    recurrence: null,
    direction: null,
    difficultyDots: 0,
    difficultyLabel: '',
  },
)

// Icon by direction with a safe fallback. Unknown / absent direction (e.g.
// booked & booking-detail screens that don't pass it, or a freshly added
// backend direction without its own icon) renders the fallback glyph.
const iconComponent = computed(
  () =>
    (props.direction && DIRECTION_ICON[props.direction as PracticeDirection]) ||
    DIRECTION_ICON_FALLBACK,
)
</script>

<style scoped>
.hero-card {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-5) var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-2);
}

.hero-card__icon {
  width: var(--velo-size-46);
  height: var(--velo-size-46);
  display: flex;
  align-items: center;
  justify-content: center;
  /* Иконка сама несёт circle-обводку (IconMeditation.vue) — без teal-подложки. */
  color: var(--velo-text-primary);
  margin-bottom: var(--space-1);
}

.hero-card__title {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

/* Master-head canon (additive opt-in via titleSize="base"). */
.hero-card__title--base {
  font-size: var(--text-base);
}

/* Optional below-meta row (master detail rating badges). */
.hero-card__extra {
  display: flex;
  justify-content: center;
}

.hero-card__meta {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

.hero-card__meta-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.hero-card__difficulty {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

.hero-card__difficulty-dots {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.hero-card__difficulty-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-blue-15);
}

.hero-card__difficulty-dot--on {
  background: var(--velo-primary);
}

/* ===== Form variant — practice-header в Check-in / Feedback (F-3) =====
 * 19px (padding-top) и 5px (icon margin) — разовая пиксельная подгонка этого
 * варианта, точного --space-* токена под них нет; оставлены сырыми сознательно
 * (снап на ближайший токен сломал бы выверенный 1:1). */
.hero-card--form {
  padding: 19px var(--space-4) var(--space-5);
  gap: 0;
}

.hero-card--form .hero-card__icon {
  margin-bottom: 5px;
}

.hero-card--form .hero-card__title {
  font-size: var(--text-base);
  margin-bottom: var(--space-4);
}

/* Meta — один центрированный ряд: мастер · дата/статус собраны по центру с
 * фиксированным gap (вместо двух 1fr-половин, дававших дыру в центре).
 * Сами ячейки (#meta слот) стилизуются в FormShell (:slotted .form-shell__practice-meta-cell). */
.hero-card--form .hero-card__meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-5);
  width: 100%;
}
</style>
