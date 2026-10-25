<!--
  VELO Frontend -- AdminReportDetailView (Phase F8.3, updated F8-fix S-1/S-2)

  Full report detail with resolve / dismiss actions.

  S-1/S-2: after resolve/dismiss use router.push({ name: 'admin-reports' })
  instead of router.back(). Guarantees a fresh mount of AdminReportsView
  and a fresh loadInitial() -- no stale reports shown.
-->

<template>
  <div class="report-detail">
    <VHeader
      :title="t('adminScreens.adminReportDetail.title')"
      :show-back="true"
      @back="router.back()"
    />

    <div class="report-detail__content">
      <!-- Loading -->
      <div v-if="loading" class="report-detail__loader">
        <VLoader size="lg" />
      </div>

      <!-- Error (SW8): distinct from "not found" -- retry, not a dead end. -->
      <VEmptyState
        v-else-if="error"
        icon="warning"
        :title="t('common.loadError')"
        :description="error"
      >
        <VButton size="sm" variant="outline" @click="loadReport">{{ t('common.retry') }}</VButton>
      </VEmptyState>

      <template v-else-if="report">
        <!-- Status + type header -->
        <div class="report-detail__header">
          <VBadge :variant="reportStatusVariant(currentStatus)">
            {{ reportStatusLabel(currentStatus) }}
          </VBadge>
          <span class="report-detail__type">
            {{ reportTargetLabel(report.target_type) }}
          </span>
        </div>

        <!-- Report content -->
        <div class="report-detail__section">
          <div class="report-detail__section-title">
            {{ t('adminScreens.adminReportDetail.reportTextLabel') }}
          </div>
          <VCard class="report-detail__reason">{{ decodedReason }}</VCard>
        </div>

        <!-- Meta -->
        <div class="report-detail__section">
          <div class="report-detail__section-title">
            {{ t('adminScreens.adminReportDetail.details') }}
          </div>
          <VCard class="report-detail__meta-list" padding="none">
            <div class="report-detail__meta-row">
              <span class="report-detail__meta-key">{{
                t('adminScreens.adminReportDetail.targetType')
              }}</span>
              <span class="report-detail__meta-val">{{ report.target_type }}</span>
            </div>
            <div class="report-detail__meta-row">
              <span class="report-detail__meta-key">{{
                t('adminScreens.adminReportDetail.targetId')
              }}</span>
              <button
                v-if="targetRoute"
                type="button"
                class="report-detail__meta-val report-detail__meta-val--mono report-detail__meta-val--link"
                @click="router.push(targetRoute)"
              >
                {{ report.target_id.slice(0, 8) }}…
              </button>
              <span v-else class="report-detail__meta-val report-detail__meta-val--mono">
                {{ report.target_id.slice(0, 8) }}…
              </span>
            </div>
            <div class="report-detail__meta-row">
              <span class="report-detail__meta-key">{{
                t('adminScreens.adminReportDetail.createdLabel')
              }}</span>
              <span class="report-detail__meta-val">
                {{ formatDateTime(report.created_at) }}
              </span>
            </div>
            <template v-if="report.resolved_at">
              <div class="report-detail__meta-row">
                <span class="report-detail__meta-key">{{
                  t('adminScreens.adminReportDetail.processed')
                }}</span>
                <span class="report-detail__meta-val">
                  {{ formatDateTime(report.resolved_at) }}
                </span>
              </div>
            </template>
            <template v-if="report.resolution_note">
              <div class="report-detail__meta-row report-detail__meta-row--column">
                <span class="report-detail__meta-key">{{
                  t('adminScreens.adminReportDetail.note')
                }}</span>
                <span class="report-detail__meta-note">{{ report.resolution_note }}</span>
              </div>
            </template>
          </VCard>
        </div>

        <!-- Actions: only for pending -->
        <template v-if="currentStatus === 'pending'">
          <div class="report-detail__section">
            <div class="report-detail__section-title">
              {{ t('adminScreens.adminReportDetail.resolveCta') }}
            </div>
            <div class="report-detail__action-form">
              <VTextarea
                v-model="resolveNote"
                :label="t('adminScreens.adminReportDetail.resolutionNote')"
                :placeholder="t('adminScreens.adminReportDetail.resolutionPlaceholder')"
                :rows="3"
                :error="resolveError"
              />
              <VButton
                variant="primary"
                block
                :loading="resolving"
                :disabled="anyLoading"
                @click="onResolve"
              >
                {{ t('adminScreens.adminReportDetail.resolve') }}
              </VButton>
            </div>
          </div>

          <div class="report-detail__section">
            <div class="report-detail__section-title">
              {{ t('adminScreens.adminReportDetail.rejectCta') }}
            </div>
            <div class="report-detail__action-form">
              <VTextarea
                v-model="dismissNote"
                :label="t('adminScreens.adminReportDetail.noteOptional')"
                :placeholder="t('adminScreens.adminReportDetail.rejectionReason')"
                :rows="2"
              />
              <VButton
                variant="outline"
                block
                :loading="dismissing"
                :disabled="anyLoading"
                @click="onDismiss"
              >
                {{ t('adminScreens.adminReportDetail.reject') }}
              </VButton>
            </div>
          </div>
        </template>

        <!-- Already processed -->
        <VCard v-else class="report-detail__processed">
          {{ t('adminScreens.adminReportDetail.alreadyProcessed') }}
          <strong>{{ reportStatusLabel(currentStatus) }}</strong>
        </VCard>
      </template>

      <!-- Not found -->
      <div v-else class="report-detail__not-found">
        <VEmptyState
          icon="notfound"
          :title="t('adminScreens.adminReportDetail.notFoundTitle')"
          :description="t('adminScreens.adminReportDetail.backToList')"
        />
        <VButton variant="outline" block @click="router.back()">{{ t('ui.back') }}</VButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { decodeReportReason } from '@/utils/reportReasons'
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VBadge, VButton, VTextarea, VEmptyState, VLoader, VCard } from '@/components/ui'
import { useToast } from '@/composables/useToast'
import { getReportById, resolveReport, dismissReport } from '@/api/admin'
import type { ReportResponse } from '@/api/admin'
import { extractApiError } from '@/composables/useApiError'
import {
  reportStatusVariant,
  reportStatusLabel,
  reportTargetLabel,
  formatDateTime,
} from '@/utils/adminHelpers'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const reportId = route.params.id as string

const report = ref<ReportResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const currentStatus = ref<string>('pending')

const resolveNote = ref('')
const resolveError = ref('')
const dismissNote = ref('')

const resolving = ref(false)
const dismissing = ref(false)
const anyLoading = computed(() => resolving.value || dismissing.value)

// Clickable target — only master/practice have a navigable admin detail
// screen; both fetch by route id independently (no state hand-off needed).
// user has no GET /admin/users/{id} yet (Zod ledger) -> stays plain text.
const targetRoute = computed<RouteLocationRaw | null>(() => {
  if (!report.value) return null
  if (report.value.target_type === 'master') {
    return { name: 'admin-master-review', params: { id: report.value.target_id } }
  }
  if (report.value.target_type === 'practice') {
    return { name: 'admin-practice-detail', params: { id: report.value.target_id } }
  }
  return null
})

async function loadReport(): Promise<void> {
  const stateData = (history.state as { report?: ReportResponse }).report
  if (stateData && stateData.id === reportId) {
    report.value = stateData
    currentStatus.value = stateData.status
    return
  }
  loading.value = true
  error.value = null
  try {
    const fetched = await getReportById(reportId)
    report.value = fetched
    currentStatus.value = fetched.status
  } catch (e) {
    // SW8: own error rung + retry, distinct from "not found".
    error.value = extractApiError(e, t('adminScreens.adminReportDetail.loadFailedToast'))
  } finally {
    loading.value = false
  }
}

async function onResolve(): Promise<void> {
  resolveError.value = ''
  if (!resolveNote.value.trim()) {
    resolveError.value = t('adminScreens.adminReportDetail.resolutionNotePlaceholder')
    return
  }
  if (anyLoading.value) return
  resolving.value = true
  try {
    await resolveReport(reportId, resolveNote.value.trim())
    toast.success(t('adminScreens.adminReportDetail.resolvedToast'))
    // S-1/S-2: push to list instead of back() -- guarantees fresh loadInitial().
    // FE-100: «Модерация» opens on «Обращения»; a report returns to «Жалобы».
    void router.push({ name: 'admin-reports', query: { tab: 'complaints' } })
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminReportDetail.processError')))
  } finally {
    resolving.value = false
  }
}

async function onDismiss(): Promise<void> {
  if (anyLoading.value) return
  dismissing.value = true
  try {
    await dismissReport(reportId, dismissNote.value.trim() || undefined)
    toast.success(t('adminScreens.adminReportDetail.rejectedToast'))
    // S-1/S-2: push to list instead of back() -- guarantees fresh loadInitial().
    // FE-100: «Модерация» opens on «Обращения»; a report returns to «Жалобы».
    void router.push({ name: 'admin-reports', query: { tab: 'complaints' } })
  } catch (e) {
    toast.error(extractApiError(e, t('adminScreens.adminReportDetail.processError')))
  } finally {
    dismissing.value = false
  }
}

onMounted(loadReport)

// tz-i18n: known reason codes decode to localized labels; legacy free text
// renders verbatim.
const decodedReason = computed(() => decodeReportReason(report.value?.reason ?? ''))
</script>

<style scoped>
.report-detail {
  /* Fill AdminLayout's scroll area — never dvh (collapses on keyboard). Canon §2. */
  min-height: 100%;
}

.report-detail__content {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.report-detail__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.report-detail__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.report-detail__type {
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  margin-left: auto;
}

.report-detail__section-title {
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
  text-transform: uppercase;
  letter-spacing: var(--velo-letter-spacing-05);
  margin-bottom: var(--space-2);
}

.report-detail__reason {
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  line-height: 1.6;
}

.report-detail__meta-list {
  overflow: hidden;
}

.report-detail__meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--velo-border-width) solid var(--velo-border-light);
  gap: var(--space-2);
}

.report-detail__meta-row--column {
  flex-direction: column;
  align-items: flex-start;
}

.report-detail__meta-row:last-child {
  border-bottom: none;
}

.report-detail__meta-key {
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  flex-shrink: 0;
}

.report-detail__meta-val {
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  text-align: right;
}

.report-detail__meta-val--mono {
  font-family: monospace;
  font-size: var(--text-xs);
}

.report-detail__meta-val--link {
  background: none;
  border: none;
  padding: 0;
  color: var(--velo-primary);
  text-decoration: underline;
  cursor: pointer;
}

.report-detail__meta-note {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.5;
  margin-top: var(--space-1);
}

.report-detail__action-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.report-detail__processed {
  text-align: center;
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
}

.report-detail__not-found {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
