<!--
  VELO Frontend -- SchoolInviteField (tz-curator.md §1.6, owner 2026-09-22)

  The school's reusable invite link under the hero card on the school
  page. Curator only (the page mounts it under `isCurator`): the invite is
  the curator's handle, and the server has always answered everyone else
  with the masked 404.

  Owner form (fifth iteration, 2026-10-01 -- the hand-drawn junction is
  GONE, owner ruling «возьми за основу сущность из дневника»): the
  silhouette IS the diary's bubble entity -- the check-in / feedback
  bead's exact Figma path (DiaryBubbleShape, screen 40), lobe mirrored
  to the right where the mock's disc sits. One continuous
  capsule-plus-lobe shape through the two concave necks, painted white
  over the app's backdrop like the diary beads -- NO rim, no strokes.
  FULL WIDTH (owner 2026-10-01): the chip stretches the whole available
  width at its native 267:47 ratio, which is why the path lives in this
  component's own svg -- DiaryBubbleShape's CSS mirror
  (translateX(267px)) is pinned to the native box and breaks on any
  other width; the mirror here is transform="translate(267 0)
  scale(-1 1)" in viewBox units, which scales with the shape. The lobe
  carries a PRIMARY disc with the white copy glyph (the mock's disc),
  inset by a white rim (owner 2026-10-01: «увеличить ободок» -- ~4.5
  viewBox units, ≈5-6px); the capsule carries the link glyph +
  «Ссылка-приглашение» centered at 18px. The whole chip is ONE button --
  one tap, one copy (owner 2026-10-01: both seats were the same motion
  anyway).

  The raw URL is NOT displayed anywhere: copying is the whole point, the
  clipboard gets the full link, the toast confirms it.

  Rotation is NOT surfaced here anymore (the mock carries no refresh
  seat): the server's revoke+create contract stands untouched in
  api/curatorGroups.ts, it just has no entry point in this field. What
  the copy tap keeps from that era is the lazy mint -- a failed probe or
  a fresh page is no reason to refuse the tap: it mints on demand and
  copies in one motion, so the button never sits dead-disabled; a failed
  mint is retried by the next tap. NO fabricated URL -- a link that looks
  valid and resolves nowhere is the exact failure the backend raises to
  prevent.

  503 bot_url_not_configured and friends: honest toast, nothing else.
-->

<template>
  <div class="sif">
    <button
      type="button"
      class="sif__copy"
      aria-label="Скопировать ссылку-приглашение"
      :disabled="copying"
      @click="onCopy"
    >
      <!-- The diary bubble's exact path, mirrored in viewBox units (lobe
           right) so it stays true at ANY width. -->
      <svg class="sif__shape" viewBox="0 0 267 47" aria-hidden="true">
        <g transform="translate(267 0) scale(-1 1)">
          <path
            class="sif__body"
            d="M243.103 0C255.939 0 266.347 10.4063 266.347 23.2432C266.347 36.0801 255.939 46.4863 243.103 46.4863H81.7666C74.2717 46.4863 67.6061 42.9388 63.3562 37.4314C60.683 33.9673 56.9488 31.0547 52.5732 31.0547C48.1866 31.0547 44.4456 33.9808 41.7745 37.4604C37.5175 43.0059 30.8215 46.5811 23.29 46.5811C10.4273 46.5808 0 36.1529 0 23.29C0.000245341 10.4274 10.4274 0.000245326 23.29 0C31.4225 0 38.5811 4.16834 42.7466 10.485C44.9985 13.8997 48.4505 16.7217 52.5409 16.7217C56.6365 16.7217 60.0913 13.8925 62.3445 10.4723C66.5005 4.16373 73.647 6.21446e-05 81.7666 0H243.103Z"
          />
        </g>
      </svg>

      <span class="sif__label">
        <IconLink :size="20" class="sif__glyph" />
        Ссылка-приглашение
      </span>

      <!-- The mock's disc: the bubble's own lobe painted PRIMARY, the
           white copy glyph at its heart. -->
      <span class="sif__lobe" aria-hidden="true">
        <IconCopy :size="20" />
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { createCuratorGroupInvite } from '@/api/curatorGroups'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { IconCopy, IconLink } from '@/components/icons'

const props = defineProps<{
  groupId: string
}>()

const toast = useToast()

const inviteUrl = ref<string | null>(null)
const copying = ref(false)

// Mint-or-get on mount: repeat calls return the SAME url by contract, so a
// page re-entry never rotates anything, it just shows what is already live.
onMounted(() => {
  void load()
})

async function load(): Promise<void> {
  try {
    const res = await createCuratorGroupInvite(props.groupId)
    inviteUrl.value = res.invite_url
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось получить ссылку'))
  }
}

/** One chip, one motion. Lazy mint: without a live url the tap mints
 *  first and copies in one motion, so the button never sits
 *  dead-disabled. */
async function onCopy(): Promise<void> {
  if (copying.value) return
  copying.value = true
  try {
    if (!inviteUrl.value) {
      const res = await createCuratorGroupInvite(props.groupId)
      inviteUrl.value = res.invite_url
    }
    await navigator.clipboard.writeText(inviteUrl.value)
    toast.success('Ссылка скопирована')
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось скопировать ссылку'))
  } finally {
    copying.value = false
  }
}
</script>

<style scoped>
.sif {
  display: flex;
  width: 100%;
}

/* The diary bead's construction (DiaryThreadCard's own recipe): the
   bubble paints the white silhouette via currentColor, everything else
   rides above it. FULL WIDTH at the bead's native 267:47 ratio. */
.sif__copy {
  position: relative;
  width: 100%;
  aspect-ratio: 267 / 47;
  padding: 0;
  background: none;
  border: none;
  color: var(--velo-bg-card-solid);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.sif__shape {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.sif__body {
  fill: currentColor;
}

/* The capsule half: glyph + label CENTERED (owner 2026-10-01) at the base
   text size, inside the straight capsule only -- the mirrored neck zone
   begins at 185.23/267 (~69%) of the width, so the label never rides
   onto it. */
.sif__label {
  position: absolute;
  top: 0;
  left: 0;
  width: 69%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font-family: var(--font-body);
  font-size: var(--text-base);
  white-space: nowrap;
  color: var(--velo-text-primary);
}

.sif__glyph {
  color: var(--velo-primary);
}

/* The lobe disc: PRIMARY, centered on the mirrored lobe circle (viewBox
   center 243.71, 23.29 / r 23.29) and inset by the WHITE RIM (owner
   2026-10-01 «увеличить ободок»: 4.5 viewBox units ≈ 5-6px each side).
   All positions in % so the disc scales with the fluid width. */
.sif__lobe {
  position: absolute;
  top: 9.57%; /* (23.29 - 18.79) / 47 */
  right: 1.69%; /* 4.5 / 267 */
  width: 14.08%; /* 2 x 18.79 / 267 */
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--velo-primary);
  color: var(--velo-white);
}

.sif__copy:disabled {
  opacity: 0.5;
  cursor: default;
}

.sif__copy:not(:disabled):active {
  opacity: 0.85;
}
</style>
