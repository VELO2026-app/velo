<!--
  VELO Frontend -- SchoolHeroCard (tz-curator.md §1.6 / §1.10 / §7.2)

  The school page's hero as ONE composite: banner strip on top, the SQUARE
  school logo in a white frame riding the seam (the frame participates in the
  flow via a negative margin -- the name follows it, §1.9), then the centred
  body: name, one counters line (students first, then masters -- the same two
  semantic icons as the list row) and an optional centred copy block.

  The copy priority is a contract, not a convenience: an analytic weekly
  summary (a future §6 payload) wins, the school's own description is the
  honest interim fallback, and nothing is ever hardcoded from the mockup's
  example. Branding: once the hash is known the banner shows the
  deterministic SchoolBrandBanner scene and the default mark becomes the
  SchoolMandalaBadge; an uploaded avatar_url wins over the mandala (§5.5
  keeps the final word on the combination).-->

<template>
  <article class="school-hero" :style="heroVars">
    <div class="school-hero__banner" aria-hidden="true">
      <!-- The deterministic brand scene once the hash is known; the neutral
           plate is the pre-branding fallback. Rendered FLAT (owner
           2026-09-19: no displacement smudge); the container matches the
           1200×600 canvas ratio so nothing is cropped or zoomed. -->
      <SchoolBrandBanner v-if="hash" :hash="hash" variant="hero" flat />
    </div>

    <div class="school-hero__body">
      <div class="school-hero__logo-frame">
        <slot name="logo">
          <!-- Priority: an uploaded avatar_url wins; otherwise the generated
               mandala -- FLAT (no shadow, no monogram) and larger (owner
               2026-09-19). -->
          <VAvatar
            v-if="avatarUrl"
            square
            size="xl"
            :name="name"
            :url="avatarUrl"
            class="school-hero__logo"
          />
          <SchoolMandalaBadge
            v-else-if="hash"
            class="school-hero__logo"
            :hash="hash"
            :size="80"
            :flat="true"
            :mandala-scale="1"
          />
          <VAvatar v-else square size="xl" :name="name" class="school-hero__logo" />
        </slot>
      </div>

      <h2 class="school-hero__name">{{ name }}</h2>

      <div class="school-hero__stats">
        <span><IconUsers :size="18" />{{ studentsLabel }}</span>
        <span><IconMeditation :size="18" />{{ mastersLabel }}</span>
      </div>

      <p v-if="copy" class="school-hero__copy">{{ copy }}</p>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { IconMeditation, IconUsers } from '@/components/icons'
import { VAvatar } from '@/components/ui'
import { plural } from '@/utils/plural'
import { brandingBodyTint } from '@/utils/schoolBranding'
import SchoolBrandBanner from '@/components/shared/SchoolBrandBanner.vue'
import SchoolMandalaBadge from '@/components/shared/SchoolMandalaBadge.vue'

const props = defineProps<{
  name: string
  avatarUrl?: string | null
  studentsCount: number
  mastersCount: number
  /** A future analytic weekly line (§6); wins over the description. */
  summary?: string | null
  /** The school's own description -- the honest interim copy. */
  description?: string | null
  /** Branding hash: server field (§5.2 B) or client schoolHashFromName (A). */
  hash?: string | null
}>()

const studentsLabel = computed(
  () => `${props.studentsCount} ${plural(props.studentsCount, 'ученик', 'ученика', 'учеников')}`,
)
const mastersLabel = computed(
  () => `${props.mastersCount} ${plural(props.mastersCount, 'мастер', 'мастера', 'мастеров')}`,
)
// The analytic summary has priority; the description is the honest temporary
// fallback; the Figma example is never hardcoded here.
const copy = computed(() => props.summary?.trim() || props.description?.trim() || '')

// Owner 2026-09-19: the area UNDER the logo is a LIGHT mid-tone of the
// school's own background -- a tinted band fading into the white body.
const heroVars = computed(() =>
  props.hash ? { '--hero-under-logo': brandingBodyTint(props.hash) } : undefined,
)
</script>

<style scoped>
.school-hero {
  overflow: hidden;
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
}

/* The reference's banner proportions, kept even while the plate is neutral.
   Owner 2026-09-19: a touch TALLER than §1.9's 3/1 -- the banner now runs
   3/4 down behind the logo instead of half. */
/* The brand scene shown FULL: the container matches the 1200×600 canvas
   ratio, so nothing is cropped or zoomed in (owner 2026-09-19:
   «растянут слишком близко»). */
.school-hero__banner {
  position: relative;
  aspect-ratio: 2 / 1;
  overflow: hidden;
  background: var(--velo-glass-blue-15);
}

.school-hero__body {
  display: grid;
  justify-items: center;
  padding: 0 var(--space-4) var(--space-5);
  text-align: center;
  /* The light mid-tone under the logo (owner 2026-09-19): the school's own
     bg, lightened halfway to white, fading into the white body. */
  background: linear-gradient(
    180deg,
    var(--hero-under-logo, var(--velo-bg-card-solid)),
    var(--velo-bg-card-solid) 96px
  );
}

/* The white frame rides the banner/body seam: in flow, pulled up so the
   banner passes behind the LOGO at 3/4 of its height (owner 2026-09-19).
   80px = the badge tile size (reverted to the original per owner); the
   frame's top padding and border are added back so the 3/4 line lands on
   the logo, not on the frame.
   Foreground: the banner is positioned, so without z-index it paints OVER
   the pulled-up frame (owner: «лого на переднем плане»); the frame carries
   the owner's THICK 4px border. The mandala INSIDE the tile is enlarged via
   mandalaScale (owner: «само лого внутри плитки -- больше»). */
.school-hero__logo-frame {
  position: relative;
  z-index: 1;
  display: inline-flex;
  margin-top: calc(-3 / 4 * 80px - var(--space-1) - 4px);
  padding: var(--space-1);
  border: 4px solid var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
}

.school-hero__logo {
  display: block;
  /* ...and the mark itself is NOT translucent: the initials plate is solid,
     so the banner never shows through it inside the frame. */
  background: var(--velo-bg-card-solid);
}

.school-hero__name {
  margin: var(--space-2) 0 0;
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
  overflow-wrap: anywhere;
}

.school-hero__stats {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-4);
  margin-top: var(--space-2);
  color: var(--velo-text-secondary);
  font-size: var(--text-sm);
}

.school-hero__stats span {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
}

.school-hero__copy {
  max-width: var(--velo-content-width-narrow);
  margin: var(--space-4) 0 0;
  color: var(--velo-text-primary);
  font-size: var(--text-sm);
  line-height: 1.45;
}
</style>
