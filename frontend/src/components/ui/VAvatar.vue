<!--
  VELO Frontend -- VAvatar Component (Phase F2.1, hardened 2026-07-14)

  Circular avatar. Shows image if url provided, otherwise initials from name.
  Matches mockup avatar patterns (student-avatar, user-avatar, master-avatar).

  A url that is SET but fails to load also falls back to initials (see
  loadFailed below) -- without that, a dead image host paints a broken-image
  glyph and the initials path is never reached.

  Loading (motion report §8.3.6): the initials sit UNDER the photo, which is
  decoded off the main thread and fades in once loaded -- no empty plate
  followed by a hard pop. An image already in the cache shows at once.

  Usage:
    <VAvatar name="Мария К." size="md" />
    <VAvatar name="Alex" url="/avatars/alex.jpg" size="lg" />
-->

<template>
  <div class="v-avatar" :class="[`v-avatar--${size}`, { 'v-avatar--square': square }]">
    <!-- Hidden once the photo is in: a transparent PNG mark must not show
         letters through. -->
    <span
      class="v-avatar__initials"
      :class="{ 'v-avatar__initials--covered': showImg && loaded }"
      :aria-hidden="showImg || undefined"
      >{{ initials }}</span
    >
    <img
      v-if="showImg"
      ref="imgEl"
      :src="url"
      :alt="name"
      class="v-avatar__img"
      :class="{ 'v-avatar__img--loaded': loaded }"
      loading="lazy"
      decoding="async"
      @load="loaded = true"
      @error="loadFailed = true"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

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
const loaded = ref(false)
const imgEl = ref<HTMLImageElement | null>(null)
const showImg = computed(() => !!props.url && !loadFailed.value)

// Cached image: mark it loaded before the first paint, so it never fades.
onMounted(() => {
  if (imgEl.value?.complete && imgEl.value.naturalWidth > 0) loaded.value = true
})

// A fresh URL deserves a fresh attempt: Vue recycles this component across list
// rows, so without this reset one broken avatar would poison the next row.
watch(
  () => props.url,
  () => {
    loadFailed.value = false
    loaded.value = false
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
  position: relative;
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
  font-size: var(--velo-fs-14);
}

.v-avatar--lg {
  width: 64px;
  height: 64px;
  font-size: var(--velo-fs-22);
}

.v-avatar--xl {
  width: 80px;
  height: 80px;
  font-size: var(--velo-fs-28);
}

.v-avatar__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity var(--velo-dur-base) var(--velo-ease-out);
}

.v-avatar__img--loaded {
  opacity: 1;
}

.v-avatar__initials {
  line-height: 1;
  transition: opacity var(--velo-dur-base) var(--velo-ease-out);
}

.v-avatar__initials--covered {
  opacity: 0;
}
</style>
