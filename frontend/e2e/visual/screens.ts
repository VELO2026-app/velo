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
  /** Key of SWEEP. */
  name: string
  role: SweepRole
  /**
   * The instance the screen is shot as, when not the one with every option on
   * (FE-275): `goodo` answers the app's /config.json with the Goodo options
   * (no payments). The path and the HAR are the screen's own: it asks the API
   * for a part of what the full instance asks for.
   */
  instance?: 'goodo'
}

/** The screenshot's file name (and the test's name): the screen, and its instance. */
export function shotOf(screen: VisualScreen): string {
  return screen.instance ? `${screen.name}@${screen.instance}` : screen.name
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
  // FE-275: where a switched-off option's address lands.
  { name: 'section-unavailable', role: S },
  { name: 'master-dashboard', role: M },
  { name: 'master-practices', role: M },
  { name: 'master-practice-new', role: M },
  { name: 'master-practice-detail', role: M },
  { name: 'master-analytics', role: M },
  { name: 'master-students', role: M },
  { name: 'master-profile', role: M },
  // FE-275 / FE-272: the web console (the admin zone at /admin), every screen, in the laptop window of its sweep
  // row (webViewport) -- on both skins, as the rest.
  { name: 'console-dashboard', role: A },
  { name: 'console-masters', role: A },
  { name: 'console-masters-detail', role: A },
  { name: 'console-users', role: A },
  { name: 'console-schools', role: A },
  { name: 'console-practices', role: A },
  { name: 'console-practices-detail', role: A },
  { name: 'console-catalog', role: A },
  { name: 'console-moderation', role: A },
  { name: 'console-support', role: A },
  { name: 'console-finance', role: A },
  { name: 'console-analytics', role: A },
  { name: 'console-mail', role: A },
  { name: 'console-settings', role: A },
  // FE-275: the console of the Goodo instance (no payments): no revenue tile,
  // no payout column.
  { name: 'console-dashboard', role: A, instance: 'goodo' },
  { name: 'console-masters', role: A, instance: 'goodo' },
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

/** Viewport of a shot, unless the screen's sweep row names a window of its own. */
export const VIEWPORT = { width: 390, height: 844 }

/** The window a screen is shot (and recorded) in. */
export function viewportOf(screen: VisualScreen): { width: number; height: number } {
  return rowOf(screen).webViewport ?? VIEWPORT
}
