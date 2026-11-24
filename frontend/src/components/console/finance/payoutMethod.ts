// =============================================================================
// VELO Frontend -- the payout method of a withdrawal, as the console shows it
// =============================================================================
//
// The admin decides on a payout without seeing the whole account: a bank
// account is masked down to its last four characters (and, for an IBAN, the
// country and check digits). The same wording as the mobile admin's payout
// screens; only the IBAN line is new (the console design shows it).
// =============================================================================

import { t } from '@/locales'

/** A payout method as the withdrawal carries it (`payout_details`). */
export interface PayoutMethod {
  method: string
  details?: Record<string, unknown> | undefined
}

const MASK = '••••'

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A bank account number or an IBAN without its spaces. */
function compact(value: unknown): string {
  return text(value).replace(/\s+/g, '')
}

/**
 * One line that names where the money goes, without exposing the account:
 * "IBAN DE89 •••• 3000", "Bank •••• 0412", an e-mail or a handle.
 *
 * @param payout - the withdrawal's payout details
 * @returns the line; the method key itself for a method the console does not know
 */
export function payoutMethodLabel(payout: PayoutMethod): string {
  const details = payout.details ?? {}
  if (payout.method === 'bank_transfer') {
    const iban = compact(details.iban)
    // An IBAN of 8 characters or fewer would be shown whole by head + tail.
    if (iban) {
      return iban.length > 8
        ? `IBAN ${iban.slice(0, 4)} ${MASK} ${iban.slice(-4)}`
        : `IBAN ${MASK} ${iban.slice(-4)}`
    }
    const bank = text(details.bank_name) || t('console.finance.withdrawals.bank')
    const account = compact(details.account)
    return account ? `${bank} ${MASK} ${account.slice(-4)}` : bank
  }
  if (payout.method === 'paypal') return text(details.email) || 'PayPal'
  if (payout.method === 'revolut') return text(details.tag) || text(details.phone) || 'Revolut'
  return payout.method
}

/**
 * The name on the payout account, the only name the payout request carries
 * (BE-226: the master's own name is not in the answer yet).
 *
 * @returns the account holder, or an empty string
 */
export function payoutHolder(payout: PayoutMethod): string {
  return text(payout.details?.account_holder)
}
