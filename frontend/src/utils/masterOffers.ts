import i18n from '@/locales'
import type { CuratorGroupMemberItem } from '@/api/types'

const { t } = i18n.global

export function masterOfferLabel(
  state: CuratorGroupMemberItem['master_offer'],
): string | undefined {
  if (state === 'awaiting_verification') return t('practice.offer.awaiting_verification')
  if (state === 'awaiting_answer') return t('practice.offer.awaiting_answer')
  return undefined
}
