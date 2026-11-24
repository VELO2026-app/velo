// =============================================================================
// VELO Frontend -- the dashboard's attention queues (FE-268)
// =============================================================================
//
// The queues an admin works, each a count and the module that holds it:
//
//   masters to review   `GET /admin/stats` (pending_verifications)  -> masters
//   complaints          reports awaiting moderation (the counters)  -> moderation
//   method changes      `GET /admin/stats` (pending_method_changes) -> moderation
//   open tickets        `GET /support/tickets?status=open`          -> support
//   payouts             `GET /admin/withdrawals?status=pending`     -> finance
//                       (only on an instance with the payments option)
//
// A queue that needs data the API does not have is not here: "tickets
// without an answer" and the oldest-wait lines of the design need a backend
// (BE-259). The counters are the entry the menu badges read; the ticket and
// payout counts are their own requests, each told once when it fails.
// =============================================================================

import { t } from '@/locales'
import { computed, type ComputedRef } from 'vue'
import { useQuery } from '@pinia/colada'
import type { AttentionQueue } from '@/components/console/overview/types'
import { IconFinance, IconGroup, IconRepeat, IconSupport, IconWarning } from '@/components/icons'
import {
  adminOpenTicketsQuery,
  adminPendingWithdrawalsQuery,
  onFailedRequest,
  useAdminStats,
} from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { isOptionEnabled } from '@/platform/instance'
import { consoleRouteName } from '@/utils/console/modules'

/** What the dashboard reads of its queues. */
export interface AttentionQueuesState {
  /** The queues to show, in menu order. */
  queues: ComputedRef<AttentionQueue[]>
  /** The counters are unknown (the first read failed): the queues read dashes. */
  failed: ComputedRef<boolean>
  /** Ask the counters again (the banner's Retry). */
  reload: () => void
}

/** The attention queues with their counts, for the dashboard. */
export function useAttentionQueues(): AttentionQueuesState {
  const toast = useToast()
  const counters = useAdminStats()
  const tickets = useQuery(adminOpenTicketsQuery)
  // The payout queue is the payments option's admin surface: with the option
  // off there is no queue and no request.
  const paymentsEnabled = isOptionEnabled('payments')
  const payouts = useQuery(() => adminPendingWithdrawalsQuery(paymentsEnabled))

  // The counters' failure is the menu's toast; these two are the dashboard's.
  const tell = (error: unknown): void =>
    toast.error(extractApiError(error, t('console.dashboard.attention.loadFailed')))
  onFailedRequest(tickets, tell)
  onFailedRequest(payouts, tell)

  const queues = computed<AttentionQueue[]>(() => {
    // Zero while unanswered would read "nothing waits": null until it answers.
    const known = counters.stats.value !== null
    const label = (key: string): string => t(`console.dashboard.attention.queues.${key}`)
    const list: AttentionQueue[] = [
      {
        key: 'verifications',
        label: label('verifications'),
        icon: IconGroup,
        count: known ? counters.pendingVerifications.value : null,
        to: { name: consoleRouteName('masters') },
      },
      {
        key: 'complaints',
        label: label('complaints'),
        icon: IconWarning,
        count: known ? counters.pendingModeration.value : null,
        to: { name: consoleRouteName('moderation'), query: { tab: 'complaints' } },
      },
      {
        key: 'methods',
        label: label('methods'),
        icon: IconRepeat,
        count: known ? counters.pendingMethodChanges.value : null,
        to: { name: consoleRouteName('moderation'), query: { tab: 'methods' } },
      },
      {
        key: 'tickets',
        label: label('tickets'),
        icon: IconSupport,
        count: tickets.data.value?.count ?? null,
        more: tickets.data.value?.more ?? false,
        to: { name: consoleRouteName('support'), query: { tab: 'open' } },
      },
    ]
    if (paymentsEnabled) {
      list.push({
        key: 'payouts',
        label: label('payouts'),
        icon: IconFinance,
        count: payouts.data.value ?? null,
        to: { name: consoleRouteName('finance') },
      })
    }
    return list
  })

  return {
    queues,
    failed: counters.failed,
    reload: () => void counters.reload(),
  }
}
