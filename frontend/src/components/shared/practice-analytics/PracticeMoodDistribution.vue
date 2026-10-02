<script setup lang="ts">
import { computed } from 'vue'
import DistributionCard from '@/components/shared/DistributionCard.vue'
import { MOOD_SCALE_KEYS, MOOD_SCALE_LABELS } from '@/utils/moodScale'
import { MOOD_SCALE_FILLS } from '@/utils/displayHelpers'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'
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

const bars = computed(() =>
  MOOD_SCALE_KEYS.map((key) => ({
    key,
    label: MOOD_SCALE_LABELS[key],
    count: props.counts[key],
    fill: MOOD_SCALE_FILLS[key],
    icon: MOOD_SCALE_ICON[key],
  })),
)
const countLabel = computed(() => `${moodTotal(props.counts)} из ${props.participants}`)
</script>

<template>
  <DistributionCard
    :title="title"
    :count-label="countLabel"
    :bars="bars"
    empty-text="Пока нет отметок"
    :initially-expanded="initiallyExpanded"
  />
</template>
