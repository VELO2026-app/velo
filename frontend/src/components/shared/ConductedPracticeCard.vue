<!--
  VELO Frontend -- ConductedPracticeCard (shared, FE-190)

  One conducted practice of an analytics period, newest first in its list:
  icon + title, one line (date · students · feedbacks) and the bare
  five-color strip of the practice's reviews. Shared by the school's analytics
  (SchoolAnalyticsView, with the practice's master under the title) and the
  master's own analytics (AnalyticsView, with the detail blocks below).

  Detail (master analytics, BE-222): the practice's four blocks, the same
  ones the practice analytics screen shows -- before, after, came -> left
  (i18n:shared.analytics.cameLeft) and reviews (i18n:shared.analytics.reviews):
  the last two are counts only, the people and the texts live on the
  practice's own screen. Every block says how many of the
  attendees it summarizes ("5 of 10", i18n:shared.analytics.outOf).

  The card is a link only when `clickable`: a tap on the summary (icon, title,
  counts, strip) emits `open`. The detail blocks hold their own expanders, so
  they are outside the tap target -- no button inside a button.
-->
<template>
  <VCard class="conducted-practice">
    <!-- Only the summary is the tap target: the detail below holds the blocks'
         own expanders, and a button must not contain buttons. -->
    <div
      class="conducted-practice__summary"
      :role="clickable ? 'button' : undefined"
      :tabindex="clickable ? 0 : undefined"
      @click="open"
      @keydown.enter.space.prevent="open"
    >
      <div class="conducted-practice__head">
        <component :is="practiceIconFor(practice)" :size="40" aria-hidden="true" />
        <div class="conducted-practice__main">
          <span class="conducted-practice__title">{{ practice.title }}</span>
          <span v-if="practice.master_name" class="conducted-practice__meta">
            <VAvatar
              :name="practice.master_name"
              :url="practice.master_avatar_url ?? undefined"
              size="sm"
            />
            {{ practice.master_name }}
          </span>
        </div>
      </div>
      <div class="conducted-practice__counts">
        <span>{{ formatShortDate(practice.scheduled_at, practice.timezone) }}</span>
        <span>{{
          t('user.screens.schoolAnalytics.studentsLine', { n: practice.attendees_count })
        }}</span>
        <span>{{
          t('user.screens.schoolAnalytics.feedbacksLine', { n: practice.reviews_count })
        }}</span>
      </div>
      <!-- Bare five-color strip: proportional fills only. -->
      <div v-if="practice.reviews_count > 0" class="conducted-practice__strip" aria-hidden="true">
        <div
          v-for="segment in segments"
          :key="segment.key"
          :style="{ flex: `${segment.count} 1 0`, background: segment.fill }"
        />
      </div>
    </div>

    <div v-if="detail" class="conducted-practice__detail">
      <PracticeMoodDistribution
        :title="t('shared.analytics.before')"
        :counts="detail.before"
        :participants="detail.attended"
      />
      <PracticeMoodDistribution
        :title="t('shared.analytics.after')"
        :counts="detail.after"
        :participants="detail.attended"
      />
      <div class="conducted-practice__pairs">
        <h2>{{ t('shared.analytics.cameLeft') }}</h2>
        <span>
          <IconGroup :size="18" aria-hidden="true" />
          {{ t('shared.analytics.outOf', { a: detail.pairs_total, b: detail.attended }) }}
        </span>
      </div>
      <div class="conducted-practice__pairs">
        <h2>{{ t('shared.analytics.reviews') }}</h2>
        <span>
          <IconGroup :size="18" aria-hidden="true" />
          {{ t('shared.analytics.outOf', { a: detail.reviews_total, b: detail.attended }) }}
        </span>
      </div>
    </div>
  </VCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { VAvatar, VCard } from '@/components/ui'
import { IconGroup } from '@/components/icons'
import PracticeMoodDistribution from '@/components/shared/practice-analytics/PracticeMoodDistribution.vue'
import { practiceIconFor } from '@/utils/displayHelpers'
import { formatShortDate } from '@/utils/format'
import {
  moodStripBars,
  type ConductedPractice,
  type ConductedPracticeDetail,
} from './conductedPractice'

const props = defineProps<{
  practice: ConductedPractice
  /** Master analytics only: the four blocks below the summary. */
  detail?: ConductedPracticeDetail
  clickable?: boolean
}>()

const emit = defineEmits<{ open: [practiceId: string] }>()

function open(): void {
  if (props.clickable) emit('open', props.practice.practice_id)
}

const segments = computed(() => moodStripBars(props.practice.rating).filter((bar) => bar.count > 0))
</script>

<style scoped>
.conducted-practice {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.conducted-practice__summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.conducted-practice__summary[role='button'] {
  cursor: pointer;
  transition:
    transform var(--transition-fast),
    opacity var(--transition-fast);
  -webkit-tap-highlight-color: transparent;
}

/* Press: the summary sinks a little under the finger, the way a clickable
   VCard does (the whole card used to be that VCard). */
.conducted-practice__summary[role='button']:active {
  transform: scale(0.985);
  opacity: 0.92;
  transition-duration: var(--velo-dur-press);
}

.conducted-practice__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.conducted-practice__head > svg {
  flex-shrink: 0;
  color: var(--velo-text-primary);
}

.conducted-practice__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--velo-gap-2);
}

.conducted-practice__title {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conducted-practice__meta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

.conducted-practice__counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

/* Bare five-color strip: proportional fills, no labels (the labeled scales
   live in the blocks of the detail, or in the school's block above the list). */
.conducted-practice__strip {
  display: flex;
  gap: var(--velo-gap-3);
  height: 10px;
  border-radius: var(--radius-full);
  overflow: hidden;
}

.conducted-practice__strip > div {
  min-width: 4px;
}

.conducted-practice__detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  cursor: default;
}

.conducted-practice__pairs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.conducted-practice__pairs h2 {
  margin: 0;
}

.conducted-practice__pairs span {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--velo-text-secondary);
}
</style>
