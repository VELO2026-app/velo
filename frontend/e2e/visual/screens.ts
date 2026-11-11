/**
 * The screens the visual comparison (FE-162) shoots: a short list of key
 * screens, each a row of the sweep table (../sweep/routes.ts) opened under
 * one role. The path and its parameters come from that table, so a route
 * that moves is followed here and the list cannot drift from the router.
 *
 * Light theme only: the app has no dark theme to compare (the Telegram host
 * `colorScheme` is read by `platform.getTheme()` but nothing styles by it,
 * src/platform/types.ts). When one appears, add a `theme` field here and
 * pass it to the Telegram stub -- the shot name already carries a slot for it.
 */
import { SWEEP, type SweepRole, type SweepVisit } from '../sweep/routes'

export interface VisualScreen {
  /** Key of SWEEP; also the screenshot's file name. */
  name: string
  role: SweepRole
}

const S = 'student'
const M = 'master'
const A = 'admin'

export const SCREENS: VisualScreen[] = [
  { name: 'user-dashboard', role: S },
  { name: 'user-calendar', role: S },
  { name: 'practice-detail', role: S },
  { name: 'user-bookings', role: S },
  { name: 'user-diary', role: S },
  { name: 'user-profile', role: S },
  { name: 'user-school', role: S },
  { name: 'user-topup', role: S },
  { name: 'not-found', role: S },
  { name: 'master-dashboard', role: M },
  { name: 'master-practices', role: M },
  { name: 'master-practice-new', role: M },
  { name: 'master-practice-detail', role: M },
  { name: 'master-analytics', role: M },
  { name: 'master-students', role: M },
  { name: 'master-profile', role: M },
  { name: 'admin-dashboard', role: A },
  { name: 'admin-masters', role: A },
  { name: 'admin-reports', role: A },
]

/** The sweep row of a screen; throws on a name the table does not have. */
export function rowOf(screen: VisualScreen): SweepVisit {
  const row = SWEEP[screen.name]
  if (!row || 'skip' in row || !row.roles.includes(screen.role)) {
    throw new Error(`visual: ${screen.name} is not a sweep visit for ${screen.role}`)
  }
  return row
}

/** The roles that have at least one screen: one HAR each. */
export const ROLES: SweepRole[] = [...new Set(SCREENS.map((s) => s.role))]

/** Viewport of every shot. */
export const VIEWPORT = { width: 390, height: 844 }
