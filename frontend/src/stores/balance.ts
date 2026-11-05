// =============================================================================
// VELO Frontend -- Balance Store (Phase F4.2)
// =============================================================================
//
// Thin store that exposes the user's balance from the auth store.
//
// Why a separate store:
//   - Single responsibility: balance formatting + refresh logic
//   - Other stores (bookings) can import it without importing auth
//   - Future F5 (topup) will add operations here
//
// Balance source: auth store's user.balance_cents (from GET /users/me).
// refresh() calls authStore.fetchMe() to get the latest balance.
// =============================================================================

import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { formatMoney } from '@/utils/format'

/** The user's balance, read from the auth store's profile, with formatting and refresh. */
export const useBalanceStore = defineStore('balance', () => {
  const authStore = useAuthStore()

  /** Raw balance in cents (from auth store user object). */
  const balanceCents = computed(() => authStore.user?.balance_cents ?? 0)

  /** Currency code (hardcoded EUR for MVP, matches backend default). */
  const currency = computed(() => 'EUR')

  /**
   * Formatted balance string: "€0,00" for zero, "€15,00" for 1500 cents.
   * Uses allowZero=true so 0 balance shows as currency, not the free label (i18n:common.free).
   */
  const formattedBalance = computed(() =>
    formatMoney(balanceCents.value, currency.value, 'ru', true),
  )

  /**
   * Check if user has enough balance for a given amount in cents.
   */
  function hasEnough(amountCents: number): boolean {
    return balanceCents.value >= amountCents
  }

  /**
   * Refresh balance by re-fetching user profile from API.
   *
   * Called after purchase, cancel (refund), or topup to ensure
   * displayed balance matches server state.
   */
  async function refresh(): Promise<void> {
    await authStore.fetchMe()
  }

  return {
    balanceCents,
    currency,
    formattedBalance,
    hasEnough,
    refresh,
  }
})
