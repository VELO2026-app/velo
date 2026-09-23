<!--
  VELO Frontend -- MoodAvatar (Master DS, 2026-06-11; FE-85 rescale)

  Mood face used as a participant avatar on the master's check-ins / student
  screens. Renders one of the five approved FE-85 faces off the RAW 1..10
  score via the shared moodScale mapping, so a saved check-in reads as the
  same emotion in the diary, the profile and the attendance roster.

  Usage: <MoodAvatar :mood="checkin.mood" :size="46" />
-->

<template>
  <component :is="moodIcon" :size="size" />
</template>

<script setup lang="ts">
import { computed, type Component } from 'vue'
import { moodKeyFromScore } from '@/utils/moodScale'
import { MOOD_SCALE_ICON } from '@/utils/ratingIcons'

const props = withDefaults(
  defineProps<{
    /** Mood score 1..10 (as stored on Checkin). */
    mood: number
    size?: number
  }>(),
  { size: 46 },
)

const moodIcon = computed<Component>(() => MOOD_SCALE_ICON[moodKeyFromScore(props.mood)])
</script>
