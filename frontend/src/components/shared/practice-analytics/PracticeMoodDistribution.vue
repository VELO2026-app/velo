<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import DistributionCard from '@/components/shared/DistributionCard.vue'
import { moodStripBars } from '@/components/shared/conductedPractice'
import { moodTotal, type MoodCounts } from './analytics'

const props = withDefaults(
  defineProps<{
    title: string
    counts: MoodCounts
    participants: number
    initiallyExpanded?: boolean
  }>(),
  { initiallyExpanded: false },
)

const bars = computed(() => moodStripBars(props.counts))
const countLabel = computed(() =>
  t('shared.components.moodOf', { n: moodTotal(props.counts), total: props.participants }),
)
</script>

<template>
  <DistributionCard
    :title="title"
    :count-label="countLabel"
    :bars="bars"
    :empty-text="t('shared.components.moodEmpty')"
    :initially-expanded="initiallyExpanded"
  />
</template>
