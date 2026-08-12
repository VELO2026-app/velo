<!--
  VELO Frontend -- DiaryFeedCard (Diary redesign)

  Dumb presentational card for one DiaryEvent in the unified feed. Three
  visual forms, chosen by `item.kind`:

    banner   -- booking_confirmed / booking_cancelled_by_user /
                practice_rescheduled / practice_cancelled_by_master
                (pill-ish status banner; teal accent for the positive
                "confirmed" case, neutral slate for cancels/reschedules)
    practice -- practice_outcome (taller white card: title + master row +
                date row + Done / "Не состоялась" outcome badge)
    standard -- checkin / feedback / note / dream / thread_started (white card:
                leading icon + title + content preview + date line; for
                thread_started the preview line is the master's name)

  The card reads loosely-typed fields from `item.snapshot` (an open dict
  whose shape depends on kind -- see DiaryFeedItem). Missing fields degrade
  gracefully (the element is simply omitted).

  Interaction: emits `tap` with the item and an `editable` flag (true for
  note/dream). The parent view decides what to do -- in this iteration it
  shows a "coming soon" toast for editable cards and ignores the rest.

  kind/mood/rating -> icon COMPONENT maps live here, NOT in displayHelpers:
  the utils layer must not import .vue files (mirrors MOOD_ICON in CheckinView).
-->

<template>
  <!-- ===================== BANNER ===================== -->
  <div
    v-if="form === 'banner'"
    class="feed-card feed-card--banner"
    :class="`feed-card--banner-${bannerTone}`"
  >
    <p class="feed-card__banner-title">{{ title }}</p>
    <p v-if="bannerSubtitle" class="feed-card__banner-subtitle">
      {{ bannerSubtitle }}
    </p>
  </div>

  <!-- ===================== PRACTICE ===================== -->
  <div v-else-if="form === 'practice'" class="feed-card feed-card--practice">
    <p class="feed-card__practice-title">{{ practiceTitle }}</p>

    <div class="feed-card__practice-master">
      <span class="feed-card__avatar" aria-hidden="true">
        <img v-if="masterAvatarUrl" :src="masterAvatarUrl" alt="" class="feed-card__avatar-img" />
      </span>
      <span class="feed-card__master-name">{{ masterName }}</span>
      <IconCheck v-if="masterVerified" :size="14" class="feed-card__verified" />
    </div>

    <div class="feed-card__practice-bottom">
      <!-- Time centred UNDER the icon (PracticeListCard canon), no leading glyph. -->
      <span class="feed-card__practice-when">{{ practiceTime }}</span>
      <span class="feed-card__practice-rest">
        <span v-if="practiceDuration" class="feed-card__practice-cell">
          <IconClock :size="14" /> {{ practiceDuration }}
        </span>
        <span v-else class="feed-card__practice-dur-empty" />
        <!-- Attended shows just a check (no "Done" text); a miss keeps its label. -->
        <span class="feed-card__outcome" :class="`feed-card__outcome--${outcomeStatus}`">
          <IconCheck v-if="outcomeStatus === 'attended'" :size="12" />
          <template v-else>{{ outcomeLabel }}</template>
        </span>
      </span>
    </div>

    <!-- Practice direction glyph, top-left. 46px — единый размер иконки
         практики по DS (как в карточках дашборда/календаря). -->
    <component :is="directionIcon" :size="46" class="feed-card__practice-icon" />
  </div>

  <!-- ===================== STANDARD ===================== -->
  <button v-else type="button" class="feed-card feed-card--standard" @click="onTap">
    <!-- Left column: icon + time UNDER it, centred — unified card language with
         PracticeListCard (time under the icon, not a top line). -->
    <span class="feed-card__iconcol">
      <span class="feed-card__icon" :class="`feed-card__icon--${item.kind}`">
        <component :is="standardIcon" :size="standardIconSize" />
      </span>
      <span class="feed-card__date">{{ dateLine }}</span>
    </span>
    <span class="feed-card__text">
      <span class="feed-card__title">{{ title }}</span>
      <span v-if="preview" class="feed-card__preview">{{ preview }}</span>
    </span>
  </button>
</template>

<script setup lang="ts">
import { useDiaryCardModel } from '@/composables/useDiaryCardModel'
import { IconCheck, IconClock } from '@/components/icons'
import type { DiaryFeedItem } from '@/api/types'

const props = defineProps<{
  item: DiaryFeedItem
  /** User timezone for date formatting (diary is a personal timeline). */
  timezone?: string
}>()

const emit = defineEmits<{
  tap: [payload: { item: DiaryFeedItem; editable: boolean }]
}>()

// All kind->form/title/icon/label derivation lives in the shared composable
// (also used by DiaryThreadCard). This card only owns its three-form template.
const {
  form,
  title,
  preview,
  dateLine,
  standardIcon,
  standardIconSize,
  directionIcon,
  bannerTone,
  bannerSubtitle,
  practiceTitle,
  masterName,
  masterAvatarUrl,
  masterVerified,
  practiceTime,
  practiceDuration,
  outcomeStatus,
  outcomeLabel,
  editable,
} = useDiaryCardModel(
  () => props.item,
  () => props.timezone,
)

function onTap(): void {
  emit('tap', { item: props.item, editable: editable.value })
}
</script>

<style scoped>
/* All colors/spacing via design tokens (variables.css) -- no hardcoded hex
   (P1 audit) and no ad-hoc px for padding/margin/gap (P3 audit). Font sizes
   use the even type scale (--text-16 / --text-12); legacy 12.375px -> --text-12
   (U4a 2026-06-06). */

.feed-card {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--font-body);
  color: var(--velo-text-primary);
}

/* ---------------- Banner ---------------- */

.feed-card--banner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  /* Tighter vertical padding + width hugging content so the banner reads as a
     compact status pill, not a full-width "sail" (operator feedback). */
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  border: 1.829px solid;
  text-align: center;
  width: fit-content;
  max-width: 290px;
  margin-inline: auto;
}

.feed-card--banner-teal {
  background: var(--velo-glass-teal-40);
  border-color: var(--velo-teal-400);
  color: var(--velo-teal-600);
}

.feed-card--banner-neutral {
  background: var(--velo-glass-blue-15);
  border-color: var(--velo-border);
  color: var(--velo-text-secondary);
}

.feed-card__banner-title {
  font-size: var(--text-12);
  letter-spacing: 0.24px;
}

.feed-card__banner-subtitle {
  font-size: var(--text-12);
  letter-spacing: 0.24px;
  opacity: 0.85;
}

/* ---------------- Practice ---------------- */

/* The practice card is the "anchor" event: it renders NARROWER (290 vs the
   336 of standard cards) and indented to the right, so the check-in / feedback
   that belong to it read as nested under it (Figma 5 Feedbacks list / map:
   x≈55, width 290). All other card forms stay full-width. */
.feed-card--practice {
  position: relative;
  width: 290px;
  margin-left: auto;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.feed-card__practice-title {
  font-size: var(--text-16);
  /* 2026-05-29: text-align LEFT, anchored at icon right edge (V3 fix, см.
   * аналогичную правку в PracticeListCard). Раньше center — при разной
   * длине titles левый край плавал ±7px по горизонтали. */
  text-align: left;
  letter-spacing: 0.32px;
  margin-left: calc(var(--space-4) + 46px + 9px);
  padding-right: var(--space-4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.feed-card__practice-master {
  display: flex;
  align-items: center;
  /* 2026-05-29: justify LEFT по той же линии что title (V3 fix). Раньше
   * center — master row плавал ±27px при разной длине имени мастера. */
  justify-content: flex-start;
  gap: var(--space-1);
  margin-left: calc(var(--space-4) + 46px + 9px);
}

.feed-card__avatar {
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-teal-40);
  overflow: hidden;
  flex-shrink: 0;
}

.feed-card__avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.feed-card__master-name {
  font-size: var(--text-12);
  color: var(--velo-text-secondary);
}

.feed-card__verified {
  color: var(--velo-teal-400);
}

/* Bottom meta — unified with PracticeListCard: time centred UNDER the icon (its
   own 46px column), duration + outcome in the rest, aligned under the title. */
.feed-card__practice-bottom {
  display: flex;
  align-items: center;
}

.feed-card__practice-when {
  width: var(--velo-size-46);
  flex-shrink: 0;
  text-align: center;
  font-size: var(--text-12);
  color: var(--velo-text-secondary);
  white-space: nowrap;
}

.feed-card__practice-rest {
  flex: 1;
  min-width: 0;
  /* Same left offset as the title (icon 46 + gap) so the duration lines up under it. */
  margin-left: calc(var(--space-4) + 9px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.feed-card__practice-cell {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-12);
  color: var(--velo-text-secondary);
}

.feed-card__outcome {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 3px var(--space-2);
  border-radius: var(--velo-radius-badge);
  font-size: var(--text-12);
}

.feed-card__outcome--attended {
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-600);
}

.feed-card__outcome--no_show {
  background: var(--velo-glass-blue-15);
  color: var(--velo-text-secondary);
}

.feed-card__practice-icon {
  position: absolute;
  top: var(--space-3);
  left: var(--space-4);
  /* Цвет — text-primary (Figma DS): иконка сама несёт circle-обводку. */
  color: var(--velo-text-primary);
}

/* ---------------- Standard ---------------- */

.feed-card--standard {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  text-align: left;
  cursor: pointer;
}

/* Left column: icon + time UNDER it, centred — unified with PracticeListCard
   (time lives under the icon, not as a top line). */
.feed-card__iconcol {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
}

.feed-card__date {
  font-size: var(--text-12);
  letter-spacing: 0.2475px;
  opacity: 0.6;
  white-space: nowrap;
}

.feed-card__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 40px container with a 32px glyph: a little breathing room so the mood face
     no longer looks cramped/squished (operator feedback, item 4). */
  width: var(--velo-size-40);
  height: var(--velo-size-40);
}

/* Monochrome glyphs take the brand text color; mood faces carry their own
   gradient and ignore this. */
.feed-card__icon--note,
.feed-card__icon--dream {
  color: var(--velo-text-primary);
}

/* Feedback rating glyph is the "fire" icon, painted the brand fire/peach color
   (Figma 5 Feedbacks list: #d4863c), NOT teal. */
.feed-card__icon--feedback {
  color: var(--velo-rating-fire);
}

.feed-card__text {
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-2);
  flex: 1;
  min-width: 0;
}

.feed-card__title {
  font-size: var(--text-16);
  letter-spacing: 0.32px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feed-card__preview {
  font-size: var(--text-12);
  letter-spacing: 0.2475px;
  opacity: 0.6;
  /* Two-line teaser; the full text opens on tap (Variant B). line-clamp
     supplies the ellipsis, so no white-space/text-overflow here. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  /* Clip an unbroken long token (e.g. a URL) instead of overflowing. */
  overflow-wrap: anywhere;
}
</style>
