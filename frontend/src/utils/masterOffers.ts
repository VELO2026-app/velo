import type { CuratorGroupMemberItem } from '@/api/types'

export function masterOfferLabel(
  state: CuratorGroupMemberItem['master_offer'],
): string | undefined {
  if (state === 'awaiting_verification') return 'Ожидает проверки мастера'
  if (state === 'awaiting_answer') return 'Ожидает ответа участника'
  return undefined
}
