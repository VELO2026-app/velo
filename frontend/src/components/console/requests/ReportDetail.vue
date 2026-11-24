<!--
  VELO Frontend -- ReportDetail (FE-262, slice 2)

  One complaint open in the console: what it is about, who sent it (the API
  names no one -- the ids are shown), its text, and the decision. A pending
  complaint takes one decision text: "Take action" (resolve) needs it,
  "Dismiss" takes it as an optional reason. A decided complaint shows the
  verdict, its date and its note. A master or practice target links to its
  admin screen (the mobile one until the console has its own).

  Mount it with `:key="report.id"` so the text starts empty for each complaint.
  A verdict emits `decided`; the list around it drops the complaint (the
  verdict invalidates every complaints list and the moderation badge).
-->

<template>
  <ConsoleCard class="report-detail" data-testid="report-detail">
    <header class="report-detail__head">
      <div class="report-detail__heading">
        <h2 class="report-detail__title">{{ reportTitle(report) }}</h2>
        <p class="report-detail__sub">
          {{
            t('console.moderation.submitted', {
              date: formatDateTime(report.created_at),
              id: report.id.slice(0, 8),
            })
          }}
        </p>
      </div>
      <VBadge :variant="reportStatusVariant(report.status)">
        {{ reportStatusLabel(report.status) }}
      </VBadge>
    </header>

    <div class="report-detail__parties">
      <section class="report-detail__party">
        <span class="report-detail__caption">{{ t('console.moderation.reporter') }}</span>
        <span class="report-detail__mono" data-testid="report-reporter">{{
          report.reporter_id.slice(0, 8)
        }}</span>
      </section>
      <section class="report-detail__party">
        <span class="report-detail__caption">{{ t('console.moderation.target') }}</span>
        <span class="report-detail__target">
          {{ reportTargetLabel(report.target_type) }}
          <button
            v-if="targetRoute"
            type="button"
            class="report-detail__mono report-detail__link"
            data-testid="report-target"
            @click="router.push(targetRoute)"
          >
            {{ report.target_id.slice(0, 8) }}
          </button>
          <span v-else class="report-detail__mono" data-testid="report-target">{{
            report.target_id.slice(0, 8)
          }}</span>
        </span>
      </section>
    </div>

    <section class="report-detail__text">
      <h3 class="report-detail__caption">
        {{ t('adminScreens.adminReportDetail.reportTextLabel') }}
      </h3>
      <p class="report-detail__reason" data-testid="report-reason">{{ decodedReason }}</p>
    </section>

    <template v-if="report.status === 'pending'">
      <VTextarea
        v-model="note"
        :label="t('console.moderation.decision')"
        :placeholder="t('adminScreens.adminReportDetail.resolutionPlaceholder')"
        :rows="4"
        :error="noteError"
      />
      <p class="report-detail__hint">{{ t('console.moderation.decisionHint') }}</p>
      <div class="report-detail__actions">
        <VButton :loading="resolving" :disabled="busy" @click="onResolve">
          {{ t('console.moderation.resolve') }}
        </VButton>
        <VButton variant="secondary" :loading="dismissing" :disabled="busy" @click="onDismiss">
          {{ t('adminScreens.adminReportDetail.reject') }}
        </VButton>
      </div>
    </template>

    <section v-else class="report-detail__verdict" data-testid="report-verdict">
      <p v-if="report.resolved_at" class="report-detail__sub">
        {{ t('adminScreens.adminReportDetail.processed') }}:
        {{ formatDateTime(report.resolved_at) }}
      </p>
      <template v-if="report.resolution_note">
        <h3 class="report-detail__caption">{{ t('adminScreens.adminReportDetail.note') }}</h3>
        <p class="report-detail__reason">{{ report.resolution_note }}</p>
      </template>
    </section>
  </ConsoleCard>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import { VBadge, VButton, VTextarea } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import { reportTitle } from '@/components/console/requests/reportTitle'
import { dismissReport, resolveReport, type ReportResponse } from '@/api/admin'
import { useAdminMutation } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { decodeReportReason } from '@/utils/reportReasons'
import {
  formatDateTime,
  reportStatusLabel,
  reportStatusVariant,
  reportTargetLabel,
} from '@/utils/adminHelpers'

const props = defineProps<{
  /** The complaint. */
  report: ReportResponse
}>()

const emit = defineEmits<{
  /** A verdict landed (resolved or dismissed). */
  decided: []
}>()

const router = useRouter()
const toast = useToast()

const note = ref('')
const noteError = ref('')
const resolving = ref(false)
const dismissing = ref(false)
const busy = computed(() => resolving.value || dismissing.value)

// The verdicts: every complaints list, the detail and the moderation badge go
// stale (ADMIN_INVALIDATES.decideReport).
const resolve = useAdminMutation(
  'decideReport',
  (text: string) => resolveReport(props.report.id, text),
  { waitForRefetch: false },
)
const dismiss = useAdminMutation(
  'decideReport',
  (text: string | undefined) => dismissReport(props.report.id, text),
  { waitForRefetch: false },
)

/** A master or practice has an admin detail screen; a user has none yet (no admin endpoint reads one user). */
const targetRoute = computed<RouteLocationRaw | null>(() => {
  if (props.report.target_type === 'master')
    return { name: 'admin-master-review', params: { id: props.report.target_id } }
  if (props.report.target_type === 'practice')
    return { name: 'admin-practice-detail', params: { id: props.report.target_id } }
  return null
})

/** Known reason codes decode to localized labels; legacy free text renders verbatim. */
const decodedReason = computed(() => decodeReportReason(props.report.reason))

async function onResolve(): Promise<void> {
  noteError.value = ''
  const text = note.value.trim()
  if (!text) {
    noteError.value = t('adminScreens.adminReportDetail.resolutionNotePlaceholder')
    return
  }
  if (busy.value) return
  resolving.value = true
  try {
    await resolve.mutateAsync(text)
    toast.success(t('adminScreens.adminReportDetail.resolvedToast'))
    emit('decided')
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminReportDetail.processError')))
  } finally {
    resolving.value = false
  }
}

async function onDismiss(): Promise<void> {
  if (busy.value) return
  noteError.value = ''
  dismissing.value = true
  try {
    await dismiss.mutateAsync(note.value.trim() || undefined)
    toast.success(t('adminScreens.adminReportDetail.rejectedToast'))
    emit('decided')
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminReportDetail.processError')))
  } finally {
    dismissing.value = false
  }
}
</script>

<style scoped>
.report-detail {
  flex: 1 0 auto;
}

.report-detail__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.report-detail__heading {
  min-width: 0;
}

.report-detail__title {
  margin: 0;
  font-size: var(--velo-fs-20);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.report-detail__sub {
  margin: var(--space-1) 0 0;
  font-size: var(--velo-fs-12);
  color: var(--velo-text-muted);
}

.report-detail__parties {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
}

@media (max-width: 1199px) {
  .report-detail__parties {
    grid-template-columns: minmax(0, 1fr);
  }
}

.report-detail__party {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--velo-radius-10);
  background: var(--velo-bg-subtle);
}

.report-detail__caption {
  margin: 0;
  font-size: var(--velo-fs-12);
  font-weight: inherit;
  color: var(--velo-text-secondary);
}

.report-detail__target {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
}

.report-detail__mono {
  font-family: var(--font-mono);
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
}

.report-detail__link {
  padding: 0;
  border: none;
  background: none;
  color: var(--velo-primary);
  text-decoration: underline;
  cursor: pointer;
}

.report-detail__text {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.report-detail__reason {
  margin: 0;
  font-size: var(--velo-fs-16);
  line-height: 1.6;
  color: var(--velo-text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.report-detail__hint {
  margin: calc(-1 * var(--space-2)) 0 0;
  font-size: var(--velo-fs-12);
  color: var(--velo-text-muted);
}

.report-detail__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.report-detail__verdict {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
