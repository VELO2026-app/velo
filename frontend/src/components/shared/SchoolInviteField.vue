<!--
  VELO Frontend -- SchoolInviteField (tz-curator.md §1.6, owner 2026-09-22)

  The school's reusable invite link as a WIDE SLIM CTA under the hero card
  on the school page. Curator only (the page mounts it under `isCurator`):
  the invite is the curator's handle, and the server has always answered
  everyone else with the masked 404.

  Owner form (third iteration, 2026-09-22 -- replaces the URL-display
  field): one wide slim PRIMARY button in liquid glass -- «Копировать
  ссылку-приглашение» -- plus, next to it, a round «Обновить ссылку» disc
  of the same diameter. The raw URL is NOT displayed anywhere: copying is
  the whole point, the clipboard gets the full link, the toast confirms it.

  The glass is the composer's liquid recipe distilled to tokens: the base
  is the PRIMARY itself (it must read unmistakably blue), with the two
  glass-blue washes (ice --velo-glass-blue-60 over deep --velo-glass-blue-30,
  the primary family at translucency) + backdrop blur + the glass border --
  no new colors.

  Rotation is revoke + create -- the only contract the server serves -- and
  revocation kills the link for everyone it reached, so the confirm dialog
  is not decoration (the same doctrine the removed CuratorGroupInviteSheet
  carried; this button is the entry point that sheet never had). Without a
  link yet the round disc is a plain RETRY (nothing to revoke -- no
  confirm).

  503 bot_url_not_configured and friends: honest toast, and the copy tap
  itself lazy-mints on demand -- the button never sits dead-disabled; a
  failed mint is retried by the next tap. NO fabricated URL -- a link that
  looks valid and resolves nowhere is the exact failure the backend raises
  to prevent.
-->

<template>
  <div class="sif">
    <button type="button" class="sif__copy" :disabled="copying" @click="onCopy">
      Копировать ссылку-приглашение
    </button>

    <!-- Rotate (confirm first: revocation kills the link for everyone), or
         retry while no link exists (nothing to confirm revoking). -->
    <button
      type="button"
      class="sif__refresh"
      aria-label="Обновить ссылку"
      :disabled="loading || rotating || copying"
      @click="onSideTap"
    >
      <IconRefresh :size="20" />
    </button>

    <VConfirmDialog
      :open="rotateConfirmOpen"
      title="Обновить ссылку?"
      message="Прежняя ссылка перестанет работать для всех, у кого она есть. Новую вы увидите сразу здесь."
      confirm-label="Обновить"
      :loading="rotating"
      @confirm="onRotateConfirm"
      @close="rotateConfirmOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { createCuratorGroupInvite, revokeCuratorGroupInvite } from '@/api/curatorGroups'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { VConfirmDialog } from '@/components/ui'
import { IconRefresh } from '@/components/icons'

const props = defineProps<{
  groupId: string
}>()

const toast = useToast()

const loading = ref(true)
const inviteUrl = ref<string | null>(null)
const copying = ref(false)
const rotating = ref(false)
const rotateConfirmOpen = ref(false)

// Mint-or-get on mount: repeat calls return the SAME url by contract, so a
// page re-entry never rotates anything, it just shows what is already live.
onMounted(() => {
  void load()
})

async function load(): Promise<void> {
  loading.value = true
  inviteUrl.value = null
  try {
    const res = await createCuratorGroupInvite(props.groupId)
    inviteUrl.value = res.invite_url
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось получить ссылку'))
  } finally {
    loading.value = false
  }
}

async function onCopy(): Promise<void> {
  // Mutual exclusion with rotation: copying a link that a concurrent
  // rotation is about to kill would hand the curator a dead link.
  if (copying.value || rotating.value) return
  copying.value = true
  try {
    // Lazy mint: a failed probe or a fresh page is no reason to refuse the
    // tap -- the button mints on demand and copies in one motion, so it is
    // never a dead blue pill.
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

function onSideTap(): void {
  if (loading.value || rotating.value || copying.value) return
  if (inviteUrl.value) {
    rotateConfirmOpen.value = true
  } else {
    void load()
  }
}

/** Rotation is revoke + create -- the only contract the server serves.
 *  Revocation kills the link for everyone it reached: hence the confirm.
 *  A failed rotation keeps the field honest: the dead url is dropped (the
 *  quiet state + the side disc as retry take over), never re-shown. */
async function onRotateConfirm(): Promise<void> {
  if (rotating.value) return
  rotating.value = true
  try {
    await revokeCuratorGroupInvite(props.groupId)
    const res = await createCuratorGroupInvite(props.groupId)
    inviteUrl.value = res.invite_url
    rotateConfirmOpen.value = false
    toast.success('Ссылка обновлена')
  } catch (e) {
    inviteUrl.value = null
    toast.error(extractApiError(e, 'Не удалось обновить ссылку'))
  } finally {
    rotating.value = false
  }
}
</script>

<style scoped>
.sif {
  /* One height rules the pair: the CTA and the refresh disc share
     --velo-size-44 (the DS round-disc token), so the circle sits flush
     beside the wide button. */
  --sif-h: var(--velo-size-44);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

/* The CTA: wide slim primary in liquid glass. The base is the PRIMARY
   itself -- it must read unmistakably blue -- and the two glass-blue
   washes (ice over deep, both the primary hue at translucency) plus the
   backdrop blur are what make it glass instead of flat paint. */
.sif__copy {
  flex: 1;
  min-width: 0;
  height: var(--sif-h);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-white);
  background:
    linear-gradient(180deg, var(--velo-glass-blue-60) 0%, var(--velo-glass-blue-30) 100%),
    var(--velo-primary);
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-full);
  backdrop-filter: blur(8px) saturate(1.2);
  -webkit-backdrop-filter: blur(8px) saturate(1.2);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.sif__copy:disabled {
  opacity: 0.5;
  cursor: default;
}

.sif__copy:not(:disabled):active {
  opacity: 0.85;
}

/* The refresh disc: same diameter, ghost outline (the composer's mic seat). */
.sif__refresh {
  width: var(--sif-h);
  height: var(--sif-h);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--velo-text-primary);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.sif__refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

.sif__refresh:not(:disabled):active {
  opacity: 0.85;
}
</style>
