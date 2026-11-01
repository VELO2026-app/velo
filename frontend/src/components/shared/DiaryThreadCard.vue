<!--
  VELO Frontend -- DiaryThreadCard (Diary redesign, screen 40 "map")

  One diary event as a compact "bead" on the thread (DiaryTimeline). The
  visual form is resolved EXPLICITLY from kind -- six known forms plus a
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
    activity -- external_activity (FE-70): the entry geometry again, but
                inert (no detail/edit/delete exists) with the mood NUMBER
                in the title line
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
    <!-- Same face family as the check-in lobe, same 40px: the FE-85 faces are
         full-bleed artwork that carries its own colour, so no zone tint is
         applied (tz-mood-scale §3) -- the slot owns only geometry. -->
    <span class="tcard__slot tcard__slot--rating" aria-hidden="true">
      <component :is="standardIcon" :size="40" />
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
      <span v-if="masterName" class="tcard__prac-master">
        <span class="tcard__prac-avatar" aria-hidden="true">
          <img
            v-if="masterAvatarUrl"
            :src="masterAvatarUrl"
            alt=""
            class="tcard__prac-avatar-img"
            loading="lazy"
            decoding="async"
          />
        </span>
        <span v-if="masterName" class="tcard__prac-master-name">{{ masterName }}</span>
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

  <!-- ===================== EXTERNAL ACTIVITY (inert entry) =====================
       FE-70: the hand-entered activity reuses the split-entry geometry (icon
       box + text box), but is NOT a button -- the backend ships no detail,
       edit or delete for it, so there is nothing to tap through to. The title
       line carries the mood as a NUMBER (see useDiaryCardModel.title); the
       time is the thread's own occurred_at, like every other bead. -->
  <div v-else-if="form === 'activity'" class="tcard tcard--entry tcard--activity">
    <span class="tcard__entry-icon" aria-hidden="true">
      <component :is="standardIcon" :size="28" />
    </span>
    <span class="tcard__entry-body">
      <span class="tcard__entry-title">{{ title }}</span>
      <span class="tcard__entry-preview">{{ preview ?? '' }}</span>
    </span>
  </div>

  <!-- ===================== UNKNOWN KIND (explicit fallback) ===================== -->
  <div v-else class="tcard tcard--fallback">
    <p v-if="baseTitle" class="tcard__fallback-title">{{ baseTitle }}</p>
    <p v-if="preview" class="tcard__fallback-preview">{{ preview }}</p>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
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
  title,
  preview,
  standardIcon,
  directionIcon,
  bannerTone,
  bannerSubtitle,
  practiceTitle,
  masterName,
  masterAvatarUrl,
  practiceTime,
  practiceDuration,
  outcomeStatus,
  outcomeLabel,
  ratingLabel,
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
type ThreadForm = 'banner' | 'checkin' | 'feedback' | 'practice' | 'entry' | 'activity' | 'fallback'

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
    case 'external_activity':
      return 'activity'
    default:
      return 'fallback'
  }
})

// -- banner copy ---------------------------------------------------------------
// The confirmed-booking reference copy: "Вы записались на / [Практика с
// Мастером]" -- the master part drops out cleanly when the snapshot has no
// name. The other banner kinds keep their existing semantic title+subtitle.
// tz-i18n 2.2b: TWO keys (the design styles line 2 differently): a plain
// title line and a bracketed reference line; non-locales assemble the
// title+master pair differently ("... for X with Y").
const bannerConfirmedTitle = computed(() => t('diary.bannerConfirmedTitle'))
const bannerConfirmedRef = computed(() =>
  masterName.value
    ? t('diary.bannerConfirmedRef', {
        title: practiceTitle.value,
        master: masterName.value,
      })
    : t('diary.bannerConfirmedRefNoMaster', { title: practiceTitle.value }),
)

const bannerLine1 = computed(() =>
  kind.value === 'booking_confirmed' ? bannerConfirmedTitle.value : baseTitle.value,
)

const bannerLine2 = computed(() =>
  kind.value === 'booking_confirmed' ? bannerConfirmedRef.value : bannerSubtitle.value,
)

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
  gap: var(--space-hairline);
  min-height: calc(44px * var(--velo-de-k, 1));
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1.5px solid;
  text-align: center;
  max-width: min(calc(240px * var(--velo-de-k, 1)), 100%);
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
  font-size: var(--velo-fs-12);
  font-weight: 600;
  letter-spacing: calc(0.22px * var(--velo-de-k, 1));
}
.tcard__banner-subtitle {
  font-size: var(--velo-fs-12);
  font-weight: 600;
  letter-spacing: calc(0.22px * var(--velo-de-k, 1));
  opacity: 0.85;
}

/* ---- check-in / feedback: 267x47 organic bubble ----
   The silhouette is the absolutely positioned SVG from DiaryBubbleShape;
   these rules pin only the fixed icon slot and the text column, so a glyph
   swap can never move the text or reshape the card. */
.tcard--checkin,
.tcard--feedback {
  position: relative;
  width: calc(267px * var(--velo-de-k, 1));
  height: calc(47px * var(--velo-de-k, 1));
  /* paints the silhouette SVG (fill=currentColor) solid white */
  color: var(--velo-bg-card-solid);
}
.tcard__slot {
  position: absolute;
  /* 40px slot centered EXACTLY on the lobe center (23.29, 23.29): the lobe
     is ~46.6px across, so the glyph keeps a ~3px white rim (owner request)
     while its center stays pinned to the circle's center. */
  top: calc(3.29px * var(--velo-de-k, 1));
  width: calc(40px * var(--velo-de-k, 1));
  height: calc(40px * var(--velo-de-k, 1));
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tcard__slot :deep(svg) {
  width: 100%;
  height: 100%;
}
.tcard--checkin .tcard__slot {
  left: calc(3.29px * var(--velo-de-k, 1));
}
.tcard--feedback .tcard__slot {
  /* The mirrored lobe center: the mirror maps x -> 267 - x, so the circle
     lands at 243.71 -- NOT the un-mirrored right-cap x (243.10). */
  left: calc(223.71px * var(--velo-de-k, 1));
}
.tcard__bubble-body {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--velo-gap-2);
  min-width: 0;
}
.tcard--checkin .tcard__bubble-body {
  left: calc(78px * var(--velo-de-k, 1));
  right: calc(16px * var(--velo-de-k, 1));
}
.tcard--feedback .tcard__bubble-body {
  left: calc(16px * var(--velo-de-k, 1));
  right: calc(78px * var(--velo-de-k, 1));
}
.tcard__bubble-title {
  font-size: var(--velo-fs-12);
  font-weight: 700;
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tcard__bubble-preview {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- practice outcome: 217x67 card ---- */
.tcard--practice {
  position: relative;
  width: calc(217px * var(--velo-de-k, 1));
  height: calc(67px * var(--velo-de-k, 1));
  border-radius: var(--velo-radius-8);
  background: var(--velo-bg-card-solid);
}
.tcard__prac-icon {
  position: absolute;
  left: calc(10px * var(--velo-de-k, 1));
  top: calc(9px * var(--velo-de-k, 1));
  width: calc(30px * var(--velo-de-k, 1));
  height: calc(30px * var(--velo-de-k, 1));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--velo-text-primary);
}

.tcard__prac-icon :deep(svg) {
  width: 100%;
  height: 100%;
}
.tcard__prac-head {
  position: absolute;
  left: calc(49px * var(--velo-de-k, 1));
  top: calc(9px * var(--velo-de-k, 1));
  right: calc(9px * var(--velo-de-k, 1));
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-2);
  min-width: 0;
}
.tcard__prac-title {
  font-size: var(--velo-fs-12);
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
  flex: 0 0 calc(12px * var(--velo-de-k, 1));
  width: calc(12px * var(--velo-de-k, 1));
  height: calc(12px * var(--velo-de-k, 1));
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
  font-size: var(--velo-fs-10);
  color: var(--velo-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tcard__prac-meta {
  position: absolute;
  left: calc(9px * var(--velo-de-k, 1));
  right: calc(9px * var(--velo-de-k, 1));
  bottom: calc(8px * var(--velo-de-k, 1));
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.tcard__prac-cell {
  display: inline-flex;
  align-items: center;
  gap: var(--velo-gap-3);
  font-size: var(--velo-fs-10);
  color: var(--velo-text-secondary);
  white-space: nowrap;
}

.tcard__prac-cell :deep(svg) {
  width: calc(11px * var(--velo-de-k, 1));
  height: calc(11px * var(--velo-de-k, 1));
}
.tcard__prac-status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--velo-gap-3);
  height: calc(16px * var(--velo-de-k, 1));
  padding: 0 var(--velo-gap-6);
  border-radius: var(--velo-radius-4);
  font-size: var(--velo-fs-10);
  font-weight: 600;
  white-space: nowrap;
}

.tcard__prac-status :deep(svg) {
  width: calc(10px * var(--velo-de-k, 1));
  height: calc(10px * var(--velo-de-k, 1));
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
  gap: var(--velo-gap-6); /* the transparent gap between the two white surfaces */
  width: calc(267px * var(--velo-de-k, 1));
  height: calc(47px * var(--velo-de-k, 1));
}
.tcard__entry-icon {
  flex: 0 0 calc(47px * var(--velo-de-k, 1));
  width: calc(47px * var(--velo-de-k, 1));
  height: calc(47px * var(--velo-de-k, 1));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--velo-radius-badge);
  background: var(--velo-bg-card-solid);
  color: var(--velo-text-primary);
}

.tcard__entry-icon :deep(svg) {
  width: calc(28px * var(--velo-de-k, 1));
  height: calc(28px * var(--velo-de-k, 1));
}
.tcard__entry-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--velo-gap-2);
  padding: 0 var(--space-4);
  border-radius: var(--velo-radius-badge);
  background: var(--velo-bg-card-solid);
}
.tcard__entry-title {
  font-size: var(--velo-fs-12);
  font-weight: 700;
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tcard__entry-preview {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- external activity: the split-entry geometry, minus the button ----
   Inert by contract (no detail/edit/delete endpoint exists); cursor stays
   default so the bead never promises a tap target it cannot honour. */
.tcard--activity {
  cursor: default;
}

/* ---- unknown kind fallback (incl. backend-excluded thread_started) ---- */
.tcard--fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-hairline);
  max-width: min(calc(240px * var(--velo-de-k, 1)), 100%);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1.5px solid var(--velo-border);
  background: var(--velo-glass-blue-15);
  color: var(--velo-text-secondary);
  text-align: center;
  font-size: var(--velo-fs-12);
  cursor: default;
}
</style>
