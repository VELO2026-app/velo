<!--
  VELO Frontend -- MasterRightsCard (FE-262)

  What an admin can do with a VERIFIED master, in the web master card: two
  cards.

  "Master rights": the school-founding right as a switch
  (PATCH /admin/masters/{id}/can-create-schools). Verification only admits
  pending applications, so this is the one lever for a master verified long
  ago. Idempotent both ways; revoking closes NEW schools only, what the
  master already owns keeps living.

  "Revoke master status": a confirm dialog that first asks the revoke
  preview (GET .../revoke-preview) and names what stays behind -- practices
  on the schedule, a non-zero balance, payouts in flight. The advisory warns
  and never blocks; a failed preview says the check did not run. Revoking
  suspends the profile and turns the account back to a user, data kept
  (POST .../revoke).
-->

<template>
  <ConsoleCard :title="t('console.masters.detail.rights')" data-testid="master-rights-card">
    <div class="rights-card__row">
      <div class="rights-card__text">
        <span class="rights-card__name">{{ t('console.masters.detail.schoolRight') }}</span>
        <span class="rights-card__hint">{{ t('console.masters.detail.schoolRightHint') }}</span>
      </div>
      <VSwitch
        :model-value="master.can_create_schools ?? false"
        :disabled="togglingRight || revoking"
        :aria-label="t('console.masters.detail.schoolRight')"
        @update:model-value="onToggleRight"
      />
    </div>
  </ConsoleCard>

  <ConsoleCard :title="t('console.masters.detail.revoke')" data-testid="master-revoke-card">
    <div class="rights-card__row">
      <p class="rights-card__hint rights-card__hint--wide">
        {{ t('console.masters.detail.revokeText') }}
      </p>
      <VButton variant="danger" :loading="revoking" :disabled="revoking" @click="openRevoke">
        {{ t('adminScreens.adminMasterReview.revokeMaster') }}
      </VButton>
    </div>

    <VConfirmDialog
      :open="showRevoke"
      :message="revokeMessage"
      :confirm-label="t('adminScreens.adminMasterReview.revoke')"
      danger
      :loading="revoking"
      @confirm="onRevoke"
      @cancel="closeRevoke"
    />
  </ConsoleCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import { VButton, VConfirmDialog, VSwitch } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import { revokeMaster, setMasterSchoolRight } from '@/api/admin'
import type { AdminMasterDetail, RevokeMasterAdvisory } from '@/api/admin'
import {
  adminRevokePreviewQuery,
  patchAdminMaster,
  useAdminMutation,
} from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { masterDisplayName } from '@/utils/adminHelpers'

const props = defineProps<{
  /** The verified master. */
  master: AdminMasterDetail
}>()

const toast = useToast()
const queryCache = useQueryCache()

// -- The school-founding right --
const togglingRight = ref(false)
const schoolRight = useAdminMutation(
  'setSchoolRight',
  (grant: boolean) => setMasterSchoolRight(props.master.id, grant),
  {
    write: (res) =>
      patchAdminMaster(queryCache, props.master.id, { can_create_schools: res.can_create_schools }),
    waitForRefetch: false,
  },
)

async function onToggleRight(grant: boolean): Promise<void> {
  if (togglingRight.value || revoking.value) return
  togglingRight.value = true
  try {
    const res = await schoolRight.mutateAsync(grant)
    toast.success(
      res.can_create_schools
        ? t('adminScreens.adminMasterReview.toast.schoolRightGranted')
        : t('adminScreens.adminMasterReview.toast.schoolRightRevoked'),
    )
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.grantChangeFailed')))
  } finally {
    togglingRight.value = false
  }
}

// -- Revoke the master, with the advisory --
const showRevoke = ref(false)
const revoking = ref(false)
// Best-effort: asked each time the dialog opens; until it answers (or when it
// fails) the dialog keeps the base message -- the revoke itself does not
// depend on the preview.
const revokePreview = useQuery(() =>
  adminRevokePreviewQuery({ userId: props.master.id, enabled: showRevoke.value }),
)
const revokeAdvisory = computed<RevokeMasterAdvisory | null>(() =>
  revokePreview.asyncStatus.value === 'loading' || revokePreview.error.value
    ? null
    : (revokePreview.data.value ?? null),
)

const revokeMessage = computed<string>(() => {
  const base = t('adminScreens.adminMasterReview.revokeMessage', {
    name: masterDisplayName(props.master),
  })
  const a = revokeAdvisory.value
  // A failed preview must not read as "no warnings": say the check did not run.
  if (!a && revokePreview.error.value) {
    return t('adminScreens.adminMasterReview.revokePreviewFailed', { base })
  }
  if (!a || !a.has_warnings) return base
  const warns: string[] = []
  if (a.scheduled_or_live_practices > 0) {
    warns.push(
      t('adminScreens.adminMasterReview.warnSchedule', { n: a.scheduled_or_live_practices }),
    )
  }
  if (a.available_cents > 0 || a.frozen_cents > 0) {
    warns.push(t('adminScreens.adminMasterReview.nonZeroBalance'))
  }
  if (a.pending_withdrawals > 0) {
    warns.push(t('adminScreens.adminMasterReview.warnWithdrawals', { n: a.pending_withdrawals }))
  }
  return t('adminScreens.adminMasterReview.revokeWarning', { base, warns: warns.join(', ') })
})

function openRevoke(): void {
  showRevoke.value = true
  // A second opening asks again: the numbers move (a booking, a payout).
  void revokePreview.refetch()
}

function closeRevoke(): void {
  if (revoking.value) return
  showRevoke.value = false
}

const revoke = useAdminMutation('revokeMaster', () => revokeMaster(props.master.id), {
  write: () => patchAdminMaster(queryCache, props.master.id, { master_status: 'suspended' }),
  waitForRefetch: false,
})

async function onRevoke(): Promise<void> {
  if (revoking.value) return
  revoking.value = true
  try {
    await revoke.mutateAsync()
    showRevoke.value = false
    toast.success(t('adminScreens.adminMasterReview.revokedToUser'))
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.toast.revokeFailed')))
  } finally {
    revoking.value = false
  }
}
</script>

<style scoped>
.rights-card__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
}

.rights-card__text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.rights-card__name {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
}

.rights-card__hint {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.rights-card__hint--wide {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}
</style>
