<!--
  VELO Frontend -- MasterReviewCard (FE-262)

  The verdict on a pending master application, in the web master card:
  an optional "may create schools" tick, "Reject" (a dialog asks the reason)
  and "Approve". Verification and the school-founding right are two
  decisions: the tick defaults to no and an absent tick writes nothing (the
  right can be granted later on the verified card).

  PROMOTE-ON-VERIFY: a custom method in the applicant's own methods that is
  not in the catalog pauses "Approve" on a confirm. Adding it to the catalog,
  keeping it for this master only, and dismissing the dialog all still verify
  -- the dialog never blocks, and a dismiss falls to "this master only".

  After a verdict the card emits `decided`; the screen leaves for the list,
  which the verdict has invalidated.
-->

<template>
  <ConsoleCard :title="t('console.masters.detail.review')" data-testid="master-review-card">
    <p class="review-card__text">{{ t('console.masters.detail.reviewText') }}</p>
    <VCheckbox
      v-model="grantSchools"
      :label="t('adminScreens.adminMasterReview.allowSchoolCreation')"
    />
    <div class="review-card__actions">
      <VButton variant="ghost" :disabled="busy" @click="openReject">{{
        t('adminScreens.adminMasterReview.rejectAction')
      }}</VButton>
      <VButton variant="primary" :loading="verifying" :disabled="busy" @click="onVerify">{{
        t('adminScreens.adminMasterReview.approve')
      }}</VButton>
    </div>

    <VModal :open="showReject" @close="closeReject">
      <div class="review-card__dialog" data-testid="master-reject-dialog">
        <h2 class="review-card__dialog-title">
          {{ t('adminScreens.adminMasterReview.rejectionReason') }}
        </h2>
        <VTextarea
          v-model="rejectReason"
          :placeholder="t('adminScreens.adminMasterReview.rejectionReasonPlaceholder')"
          :rows="4"
          :error="rejectError"
        />
        <div class="review-card__actions">
          <VButton variant="ghost" :disabled="rejecting" @click="closeReject">{{
            t('ui.cancel')
          }}</VButton>
          <VButton variant="danger" :loading="rejecting" @click="onReject">{{
            t('adminScreens.adminMasterReview.rejectCta')
          }}</VButton>
        </div>
      </div>
    </VModal>

    <VConfirmDialog
      :open="showPromote"
      :message="promoteMessage"
      :confirm-label="t('adminScreens.adminMasterReview.addToCatalog')"
      :cancel-label="t('adminScreens.adminMasterReview.thisMasterOnly')"
      :loading="verifying"
      @confirm="onPromoteConfirm"
      @cancel="onPromoteCancel"
    />
  </ConsoleCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { VButton, VCheckbox, VConfirmDialog, VModal, VTextarea } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import { rejectMaster, verifyMaster } from '@/api/admin'
import type { AdminMasterDetail } from '@/api/admin'
import { useAdminMutation } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { parseMethods } from '@/utils/methodTaxonomy'

const props = defineProps<{
  /** The pending master. */
  master: AdminMasterDetail
}>()

const emit = defineEmits<{
  /** The application was verified or rejected. */
  decided: []
}>()

const toast = useToast()

const verifying = ref(false)
const rejecting = ref(false)
const busy = computed(() => verifying.value || rejecting.value)

const verify = useAdminMutation(
  'verifyMaster',
  (vars: { promote?: string[]; masterOnly?: string[]; grantSchools: boolean }) =>
    verifyMaster(props.master.id, vars.promote, vars.masterOnly, vars.grantSchools),
  { waitForRefetch: false },
)
const reject = useAdminMutation(
  'rejectMaster',
  (reason: string) => rejectMaster(props.master.id, reason),
  { waitForRefetch: false },
)

// -- Reject with a reason --
const showReject = ref(false)
const rejectReason = ref('')
const rejectError = ref('')

function openReject(): void {
  rejectReason.value = ''
  rejectError.value = ''
  showReject.value = true
}

function closeReject(): void {
  if (rejecting.value) return
  showReject.value = false
}

async function onReject(): Promise<void> {
  if (busy.value) return
  rejectError.value = ''
  const reason = rejectReason.value.trim()
  if (!reason) {
    rejectError.value = t('adminScreens.adminMasterReview.rejectionReasonHint')
    return
  }
  rejecting.value = true
  try {
    await reject.mutateAsync(reason)
    toast.success(t('adminScreens.adminMasterReview.toast.requestRejected'))
    showReject.value = false
    emit('decided')
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.toast.rejectFailed')))
  } finally {
    rejecting.value = false
  }
}

// -- Verify, with the promote-on-verify pause --
/** The tick for the school-founding right; no tick writes nothing. */
const grantSchools = ref(false)
const showPromote = ref(false)
/** One entry per unmatched method: promoted or scoped one by one. */
const promoteLabels = ref<string[]>([])
const promoteMessage = computed((): string => {
  const labels = promoteLabels.value
  if (labels.length <= 1) {
    return t('adminScreens.adminCommon.methodSingle', { label: labels[0] ?? '' })
  }
  return t('adminScreens.adminCommon.methodPlural', {
    labels: labels.map((label) => t('console.masters.detail.quoted', { label })).join(', '),
  })
})

function onVerify(): void {
  if (busy.value) return
  const parsed = parseMethods(props.master.methods ?? [])
  if (parsed.customEnabled && parsed.custom.length) {
    promoteLabels.value = parsed.custom
    showPromote.value = true
    return
  }
  void doVerify()
}

async function doVerify(promote?: string[], masterOnly?: string[]): Promise<void> {
  verifying.value = true
  let verified = false
  try {
    await verify.mutateAsync({
      ...(promote !== undefined ? { promote } : {}),
      ...(masterOnly !== undefined ? { masterOnly } : {}),
      grantSchools: grantSchools.value,
    })
    verified = true
    toast.success(t('adminScreens.adminMasterReview.toast.verified'))
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminMasterReview.verificationError')))
  } finally {
    verifying.value = false
    showPromote.value = false
  }
  if (verified) emit('decided')
}

/** "Add to catalog": verify and promote the custom labels. */
function onPromoteConfirm(): void {
  void doVerify([...promoteLabels.value])
}

/** "This master only", or the dialog dismissed: verify, scoped to this master. */
function onPromoteCancel(): void {
  void doVerify(undefined, [...promoteLabels.value])
}
</script>

<style scoped>
.review-card__text {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
}

.review-card__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.review-card__dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: min(480px, 100%);
  padding: var(--space-2);
}

.review-card__dialog-title {
  margin: 0;
  font-size: var(--velo-fs-20);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}
</style>
