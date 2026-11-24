// =============================================================================
// VELO Frontend -- payoutMethodLabel / payoutHolder tests (FE-267)
// =============================================================================
//
// What the admin reads before approving a payout: where the money goes,
// without the whole account number on screen.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { payoutHolder, payoutMethodLabel } from '@/components/console/finance/payoutMethod'

describe('payoutMethodLabel', () => {
  it.each([
    {
      name: 'an IBAN keeps its country and check digits and the last four characters',
      payout: { method: 'bank_transfer', details: { iban: 'DE89 3704 0044 0532 0130 00' } },
      label: 'IBAN DE89 •••• 3000',
    },
    {
      name: 'a very short IBAN shows its tail only, never the whole account',
      payout: { method: 'bank_transfer', details: { iban: 'DE89 1234' } },
      label: 'IBAN •••• 1234',
    },
    {
      name: 'a plain account is named by its bank and the last four digits',
      payout: {
        method: 'bank_transfer',
        details: { bank_name: 'Sparkasse', account: '8830 0412 0412' },
      },
      label: 'Sparkasse •••• 0412',
    },
    {
      name: 'a bank transfer with no account shows the bank, then a generic word',
      payout: { method: 'bank_transfer', details: { bank_name: 'Sparkasse' } },
      label: 'Sparkasse',
    },
    {
      name: 'a bank transfer with nothing known says "Bank"',
      payout: { method: 'bank_transfer' },
      label: 'Банк',
    },
    {
      name: 'PayPal shows the e-mail',
      payout: { method: 'paypal', details: { email: 'oleg@example.com' } },
      label: 'oleg@example.com',
    },
    {
      name: 'PayPal without an e-mail shows its name',
      payout: { method: 'paypal', details: {} },
      label: 'PayPal',
    },
    {
      name: 'Revolut shows the tag, else the phone, else its name',
      payout: { method: 'revolut', details: { phone: '+49 151 000' } },
      label: '+49 151 000',
    },
    {
      name: 'a method the console does not know shows its key',
      payout: { method: 'crypto', details: { address: 'x' } },
      label: 'crypto',
    },
  ])('$name', ({ payout, label }) => {
    expect(payoutMethodLabel(payout)).toBe(label)
  })
})

describe('payoutHolder', () => {
  it('is the name on the payout account', () => {
    expect(
      payoutHolder({ method: 'bank_transfer', details: { account_holder: ' Игорь Петров ' } }),
    ).toBe('Игорь Петров')
  })

  it('is empty when the details carry no name', () => {
    expect(payoutHolder({ method: 'paypal', details: { email: 'a@b.c' } })).toBe('')
    expect(payoutHolder({ method: 'paypal' })).toBe('')
  })
})
