import type { PracticeAnalyticsResponse } from '@/api/types'
import { MOOD_SCALE_KEYS, type MoodScaleKey } from '@/utils/moodScale'

// BE-78: the server counts the zones (ScoreZoneCounts, BE-77) -- this
// module only reads them. No client copy of the 1..10 boundaries exists.
export type MoodCounts = Record<MoodScaleKey, number>

export function moodTotal(counts: MoodCounts): number {
  return MOOD_SCALE_KEYS.reduce((total, key) => total + counts[key], 0)
}

// Moved to @/utils/format (DistributionCard owns the strip rendering now);
// re-exported so the existing imports (and the pinned tests) keep working.
export { formatPercent } from '@/utils/format'

// BE-78 (2): what a tap on a person opens -- the owner's table, in ONE place.
// The server names the reader (viewer_role, from its one rights check) and
// who the person is to the school (is_school_student); this only maps.
//   leader        -> the student dossier (their own CRM; it admits anyone
//                    with a booking on this master's practices -- every
//                    attendee has one)
//   curator       -> the school student profile, which requires STUDENT
//                    membership now; anyone else (a guest, a school master,
//                    a former student) -> no tap at all
//   school_master -> a direct message (POST /chats/students, open by design)
export type PersonTarget =
  | { kind: 'route'; to: { name: string; params: Record<string, string> } }
  | { kind: 'chat'; studentId: string; name: string }
  | null

export interface AnalyticsPerson {
  user_id: string
  name: string
  is_school_student: boolean
}

export function personTarget(
  summary: Pick<PracticeAnalyticsResponse, 'viewer_role' | 'curator_group_id'>,
  person: AnalyticsPerson,
): PersonTarget {
  switch (summary.viewer_role) {
    case 'leader':
      return {
        kind: 'route',
        to: { name: 'master-student-profile', params: { id: person.user_id } },
      }
    case 'curator':
      return person.is_school_student && summary.curator_group_id
        ? {
            kind: 'route',
            to: {
              name: 'master-curator-group-student',
              params: { groupId: summary.curator_group_id, userId: person.user_id },
            },
          }
        : null
    case 'school_master':
      return { kind: 'chat', studentId: person.user_id, name: person.name }
    default:
      return null
  }
}
