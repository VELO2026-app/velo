<!--
  VELO Frontend -- DiaryThreadCard (Diary redesign, screen 40 "map")

  One diary event as a compact "bead" on the thread (DiaryTimeline). The
  visual form is resolved EXPLICITLY from kind -- five known forms plus a
  fallback; there is no generic v-else that could dress an arbitrary kind in
  a known card:

    banner   -- booking_confirmed / booking_cancelled_by_user /
                practice_rescheduled / practice_cancelled_by_master:
                centered status pill (teal only for a confirmed booking)
    checkin  -- organic bubble, lobe LEFT, the exact Figma silhouette
                (DiaryBubbleShape): mood glyph in the lobe + title/preview
    feedback -- the SAME silhouette mirrored (lobe RIGHT): rating glyph +
                title/preview; the icon keeps its rating-zone colour
    practice -- practice_outcome: dedicated 217x67 card (direction icon,
                title, master row, time/duration meta, Done / "Вы не пришли")
    entry    -- note / dream: two separate white surfaces (icon box + text
                box) with a transparent gap between them
    fallback -- anything else (incl. thread_started, which the backend feed
                excludes): inert neutral chip, never a known card shape

  The kind->title/icon/preview derivation comes from the shared
  useDiaryCardModel composable (same source as the dormant flat DiaryFeedCard);
  this component owns ONLY the thread compositions and geometry.
-->

<template>
  <!-- ===================== SYSTEM BANNER ===================== -->
  <div v-if="form === 'banner'" class="tcard tcard--banner" :class="`tcard--banner-${bannerTone}`">
    <p class="tcard__banner-title">{{ bannerLine1 }}</p>
    <p v-if="bannerLine2" class="tcard__banner-subtitle">{{ bannerLine2 }}</p>
  </div>

  <!-- ===================== CHECK-IN (bubble, lobe left) ===================== -->
  <button
    v-else-if="form === 'checkin'"
    type="button"
    class="tcard tcard--checkin"
    :aria-label="bubbleA11y"
    @click="onTap"
  >
    <DiaryBubbleShape side="left" />
    <span class="tcard__slot" aria-hidden="true">
      <component :is="standardIcon" :size="40" />
    </span>
    <span class="tcard__bubble-body">
      <span class="tcard__bubble-title">{{ baseTitle }}</span>
      <span class="tcard__bubble-preview">{{ bubblePreview }}</span>
    </span>
  </button>

  <!-- ===================== FEEDBACK (mirrored bubble, lobe right) ===================== -->
  <button
    v-else-if="form === 'feedback'"
    type="button"
    class="tcard tcard--feedback"
    :aria-label="bubbleA11y"
    @click="onTap"
  >
    <DiaryBubbleShape side="right" />
    <!-- 36, not 40: the rating glyphs carry ~5% baked-in viewBox padding
         (their artwork reaches only ~89% of the box), so at 40 the outlined
         glyph crowded the lobe. The slot below stays pinned to the lobe
         center -- the icon centers through it. -->
    <span
      class="tcard__slot tcard__slot--rating"
      :style="{ color: ratingIconColor }"
      aria-hidden="true"
    >
      <component :is="standardIcon" :size="36" />
    </span>
    <span class="tcard__bubble-body">
      <span class="tcard__bubble-title">{{ baseTitle }}</span>
      <span class="tcard__bubble-preview">{{ bubblePreview }}</span>
    </span>
  </button>

  <!-- ===================== PRACTICE OUTCOME (217x67 card) ===================== -->
  <button
    v-else-if="form === 'practice'"
    type="button"
    class="tcard tcard--practice"
    :aria-label="practiceA11y"
    @click="onTap"
  >
    <span class="tcard__prac-icon" aria-hidden="true">
      <component :is="directionIcon" :size="30" />
    </span>
    <span class="tcard__prac-head">
      <span class="tcard__prac-title">{{ practiceTitle }}</span>
      <span v-if="masterName || masterVerified" class="tcard__prac-master">
        <span class="tcard__prac-avatar" aria-hidden="true">
          <img
            v-if="masterAvatarUrl"
            :src="masterAvatarUrl"
            alt=""
            class="tcard__prac-avatar-img"
          />
        </span>
        <span v-if="masterName" class="tcard__prac-master-name">{{ masterName }}</span>
        <IconCheck v-if="masterVerified" :size="10" class="tcard__prac-verified" />
      </span>
    </span>
    <span class="tcard__prac-meta">
      <span v-if="practiceTime" class="tcard__prac-cell">
        <IconCalendar :size="11" />{{ practiceTime }}
      </span>
      <span v-if="practiceDuration" class="tcard__prac-cell">
        <IconClock :size="11" />{{ practiceDuration }}
      </span>
      <!-- Attended shows BOTH the check and the word "Done" (thread target);
           a miss keeps its "Вы не пришли" label. -->
      <span class="tcard__prac-status" :class="`tcard__prac-status--${outcomeStatus}`">
        <IconCheck v-if="outcomeAttended" :size="10" />{{ outcomeText }}
      </span>
    </span>
  </button>

  <!-- ===================== NOTE / DREAM (split entry) ===================== -->
  <button
    v-else-if="form === 'entry'"
    type="button"
    class="tcard tcard--entry"
    :aria-label="entryA11y"
    @click="onTap"
  >
    <span class="tcard__entry-icon" aria-hidden="true">
      <component :is="standardIcon" :size="28" />
    </span>
    <span class="tcard__entry-body">
      <span class="tcard__entry-title">{{ baseTitle }}</span>
      <!-- The day already lives in the timeline date node; no preview means an
           empty second line -- the time must never silently replace it. -->
      <span class="tcard__entry-preview">{{ preview ?? '' }}</span>
    </span>
  </button>

  <!-- ===================== UNKNOWN KIND (explicit fallback) ===================== -->
  <div v-else class="tcard tcard--fallback">
    <p v-if="baseTitle" class="tcard__fallback-title">{{ baseTitle }}</p>
    <p v-if="preview" class="tcard__fallback-preview">{{ preview }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDiaryCardModel } from '@/composables/useDiaryCardModel'
import DiaryBubbleShape from '@/components/shared/DiaryBubbleShape.vue'
import { IconCheck, IconCalendar, IconClock } from '@/components/icons'
import type { DiaryFeedItem } from '@/api/types'

const props = defineProps<{
  item: DiaryFeedItem
  timezone?: string
}>()

const emit = defineEmits<{
  tap: [payload: { item: DiaryFeedItem; editable: boolean }]
}>()

// Shared card model (same source as DiaryFeedCard).
const {
  kind,
  baseTitle,
  preview,
  standardIcon,
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
  ratingLabel,
  ratingIconColor,
  moodLabel,
  editable,
} = useDiaryCardModel(
  () => props.item,
  () => props.timezone,
)

// -- form resolution -----------------------------------------------------------
// Explicit kind -> visual form. Anything unrecognized (incl. thread_started,
// which the backend feed excludes server-side) lands on the inert fallback
// instead of masquerading as a known card.
type ThreadForm = 'banner' | 'checkin' | 'feedback' | 'practice' | 'entry' | 'fallback'

const form = computed<ThreadForm>(() => {
  switch (kind.value) {
    case 'booking_confirmed':
    case 'booking_cancelled_by_user':
    case 'practice_rescheduled':
    case 'practice_cancelled_by_master':
      return 'banner'
    case 'checkin':
      return 'checkin'
    case 'feedback':
      return 'feedback'
    case 'practice_outcome':
      return 'practice'
    case 'note':
    case 'dream':
      return 'entry'
    default:
      return 'fallback'
  }
})

// -- banner copy ---------------------------------------------------------------
// The confirmed-booking reference copy: "Вы записались на / [Практика с
// Мастером]" -- the master part drops out cleanly when the snapshot has no
// name. The other banner kinds keep their existing semantic title+subtitle.
const BANNER_CONFIRMED_TITLE = 'Вы записались на'

const bannerLine1 = computed(() =>
  kind.value === 'booking_confirmed' ? BANNER_CONFIRMED_TITLE : baseTitle.value,
)

const bannerLine2 = computed(() => {
  if (kind.value === 'booking_confirmed') {
    const withMaster = masterName.value ? ` с ${masterName.value}` : ''
    return `[${practiceTitle.value}${withMaster}]`
  }
  return bannerSubtitle.value
})

// -- bubble copy (check-in / feedback) -----------------------------------------
// Line 2 is the user's comment preview; the mood/rating LABEL is only the
// no-comment fallback (and picks the icon) -- never a heading suffix here.
const bubblePreview = computed(() => {
  if (preview.value) return preview.value
  return form.value === 'checkin' ? moodLabel.value : ratingLabel.value
})

const bubbleA11y = computed(() =>
  bubblePreview.value ? `${baseTitle.value}: ${bubblePreview.value}` : baseTitle.value,
)

// -- practice outcome ----------------------------------------------------------
const outcomeAttended = computed(() => outcomeStatus.value === 'attended')
const outcomeText = computed(() => (outcomeAttended.value ? 'Done' : outcomeLabel.value))

const practiceA11y = computed(() => {
  const when = [practiceTime.value, practiceDuration.value].filter(Boolean).join(', ')
  return [practiceTitle.value, masterName.value, when, outcomeText.value].filter(Boolean).join(', ')
})

// -- note / dream ---------------------------------------------------------------
const entryA11y = computed(() =>
  preview.value ? `${baseTitle.value}: ${preview.value}` : baseTitle.value,
)

function onTap(): void {
  emit('tap', { item: props.item, editable: editable.value })
}
</script>

<style scoped>
/* Thread-scale ("bead on the thread") cards. Colors via tokens; px geometry
   from the thread Figma reference (bubble 267x47, practice card 217x67, split
   entry 267x47). The bubble SVG itself lives in DiaryBubbleShape. */
.tcard {
  font-family: var(--font-body);
  color: var(--velo-text-primary);
  border: none;
  background: none;
  padding: 0;
  text-align: left;
  line-height: 1.2;
  cursor: pointer;
}

/* ---- system banner (rounded status pill) ---- */
.tcard--banner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-height: 44px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1.5px solid;
  text-align: center;
  max-width: 240px;
  cursor: default;
}
.tcard--banner-teal {
  background: var(--velo-glass-teal-40);
  border-color: var(--velo-teal-400);
  color: var(--velo-teal-600);
}
.tcard--banner-neutral {
  background: var(--velo-glass-blue-15);
  border-color: var(--velo-border);
  color: var(--velo-text-secondary);
}
.tcard__banner-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.22px;
}
.tcard__banner-subtitle {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.22px;
  opacity: 0.85;
}

/* ---- check-in / feedback: 267x47 organic bubble ----
   The silhouette is the absolutely positioned SVG from DiaryBubbleShape;
   these rules pin only the fixed icon slot and the text column, so a glyph
   swap can never move the text or reshape the card. */
.tcard--checkin,
.tcard--feedback {
  position: relative;
  width: 267px;
  height: 47px;
  /* paints the silhouette SVG (fill=currentColor) solid white */
  color: var(--velo-bg-card-solid);
}
.tcard__slot {
  position: absolute;
  /* 40px slot centered EXACTLY on the lobe center (23.29, 23.29): the lobe
     is ~46.6px across, so the glyph keeps a ~3px white rim (owner request)
     while its center stays pinned to the circle's center. */
  top: 3.29px;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tcard--checkin .tcard__slot {
  left: 3.29px;
}
.tcard--feedback .tcard__slot {
  /* The mirrored lobe center: the mirror maps x -> 267 - x, so the circle
     lands at 243.71 -- NOT the un-mirrored right-cap x (243.10). */
  left: 223.71px;
}
.tcard__bubble-body {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
}
.tcard--checkin .tcard__bubble-body {
  left: 78px;
  right: 16px;
}
.tcard--feedback .tcard__bubble-body {
  left: 16px;
  right: 78px;
}
.tcard__bubble-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tcard__bubble-preview {
  font-size: 12px;
  color: var(--velo-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- practice outcome: 217x67 card ---- */
.tcard--practice {
  position: relative;
  width: 217px;
  height: 67px;
  border-radius: 8px;
  background: var(--velo-bg-card-solid);
}
.tcard__prac-icon {
  position: absolute;
  left: 10px;
  top: 9px;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--velo-text-primary);
}
.tcard__prac-head {
  position: absolute;
  left: 49px;
  top: 9px;
  right: 9px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tcard__prac-title {
  font-size: 13px;
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tcard__prac-master {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
.tcard__prac-avatar {
  flex: 0 0 12px;
  width: 12px;
  height: 12px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-teal-40);
  overflow: hidden;
}
.tcard__prac-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tcard__prac-master-name {
  font-size: 10px;
  color: var(--velo-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tcard__prac-verified {
  flex: 0 0 auto;
  color: var(--velo-teal-400);
}
.tcard__prac-meta {
  position: absolute;
  left: 9px;
  right: 9px;
  bottom: 8px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.tcard__prac-cell {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--velo-text-secondary);
  white-space: nowrap;
}
.tcard__prac-status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 16px;
  padding: 0 7px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}
.tcard__prac-status--attended {
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-600);
}
.tcard__prac-status--no_show {
  background: var(--velo-glass-blue-15);
  color: var(--velo-text-secondary);
}

/* ---- note / dream: split entry (two surfaces, transparent gap) ---- */
.tcard--entry {
  display: flex;
  gap: 6px; /* the transparent gap between the two white surfaces */
  width: 267px;
  height: 47px;
}
.tcard__entry-icon {
  flex: 0 0 47px;
  width: 47px;
  height: 47px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-bg-card-solid);
  color: var(--velo-text-primary);
}
.tcard__entry-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 0 16px;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-bg-card-solid);
}
.tcard__entry-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tcard__entry-preview {
  font-size: 12px;
  color: var(--velo-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- unknown kind fallback (incl. backend-excluded thread_started) ---- */
.tcard--fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  max-width: 240px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1.5px solid var(--velo-border);
  background: var(--velo-glass-blue-15);
  color: var(--velo-text-secondary);
  text-align: center;
  font-size: 12px;
  cursor: default;
}
</style>
