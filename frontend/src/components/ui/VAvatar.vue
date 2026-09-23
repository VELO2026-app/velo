<!--
  VELO Frontend -- VAvatar Component (Phase F2.1, hardened 2026-07-14)

  Circular avatar. Shows image if url provided, otherwise initials from name.
  Matches mockup avatar patterns (student-avatar, user-avatar, master-avatar).

  A url that is SET but fails to load also falls back to initials (see
  loadFailed below) -- without that, a dead image host paints a broken-image
  glyph and the initials path is never reached.

  Usage:
    <VAvatar name="Мария К." size="md" />
    <VAvatar name="Alex" url="/avatars/alex.jpg" size="lg" />
-->

<template>
  <div class="v-avatar" :class="[`v-avatar--${size}`, { 'v-avatar--square': square }]">
    <img
      v-if="url && !loadFailed"
      :src="url"
      :alt="name"
      class="v-avatar__img"
      @error="loadFailed = true"
    />
    <span v-else class="v-avatar__initials">{{ initials }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    url?: string
    size?: 'sm' | 'md' | 'lg' | 'xl'
    /** Squared corners for school/brand marks (tz-curator.md §1.4/§1.6) --
     *  the same image+initials contract, a rounded-square plate. */
    square?: boolean
  }>(),
  {
    url: '',
    size: 'md',
    square: false,
  },
)

// 2026-07-14: an avatar URL can be perfectly valid in the DB and still be dead
// on the network -- t.me was pulled at the registry level and every Telegram
// userpic died with it. `v-if="url"` alone keeps the <img> mounted, so the user
// gets a broken-image icon while the initials fallback right below sits unused.
// Falling back on `error` makes ANY dead avatar host (this one or the next)
// degrade into clean initials instead of a broken glyph.
const loadFailed = ref(false)

// A fresh URL deserves a fresh attempt: Vue recycles this component across list
// rows, so without this reset one broken avatar would poison the next row.
watch(
  () => props.url,
  () => {
    loadFailed.value = false
  },
)

const initials = computed(() => {
  const parts = props.name.trim().split(/\s+/)
  const first = (parts[0] ?? '').charAt(0)
  const second = (parts[1] ?? '').charAt(0)
  if (first && second) {
    return (first + second).toUpperCase()
  }
  return (first || '?').toUpperCase()
})
</script>

<style scoped>
.v-avatar {
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--velo-bg-subtle);
  color: var(--velo-primary);
  flex-shrink: 0;
  overflow: hidden;
}

/* tz-curator.md §1.4/§1.6: a school's mark is a ROUNDED SQUARE, not a circle
   (list lead + the page hero's seam logo). Same plate, squared corners. */
.v-avatar--square {
  border-radius: var(--radius-md);
}

.v-avatar--sm {
  width: 32px;
  height: 32px;
  font-size: var(--text-12);
}

.v-avatar--md {
  width: var(--velo-size-40);
  height: var(--velo-size-40);
  font-size: 14px;
}

.v-avatar--lg {
  width: 64px;
  height: 64px;
  font-size: 22px;
}

.v-avatar--xl {
  width: 80px;
  height: 80px;
  font-size: 28px;
}

.v-avatar__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.v-avatar__initials {
  line-height: 1;
}
</style>
