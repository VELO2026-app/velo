/**
 * Data and host fixtures for the smoke scenarios (FE-157 5A.2). Shapes follow
 * `src/api/generated.ts` (UserResponse, PracticeResponse, ...) -- the mock
 * answers what the real backend would, nothing app-specific.
 */
import type { Page } from '@playwright/test'
import type { MockApi } from './api'

/** localStorage key of the standalone session token (platform/session-token.ts). */
export const SESSION_TOKEN_KEY = 'velo_token'

/** A fixed token the mocked `/users/me` accepts. */
export const SESSION_TOKEN = 'e2e-session-token'

/** Telegram user id the stub launches the app with. */
export const TELEGRAM_USER_ID = 424242

/** The browser clock of the date-sensitive scenarios (see freezeClock). */
export const NOW = new Date('2026-11-10T08:00:00Z')

/** A practice start on the frozen day, `hour` o'clock UTC. */
export function atHour(hour: number): string {
  const start = new Date(NOW)
  start.setUTCHours(hour, 0, 0, 0)
  return start.toISOString()
}

/**
 * Pin Date.now() to NOW (timers keep running): the calendar opens on today,
 * and a practice scheduled for later today stays in the future whenever the
 * suite runs.
 */
export async function freezeClock(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW)
}

/** UserResponse of an account; `overrides` replaces any field. */
export function makeUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    telegram_id: TELEGRAM_USER_ID,
    role: 'user',
    first_name: 'Ada',
    last_name: 'Tester',
    avatar_url: null,
    timezone: 'UTC',
    language: 'en',
    is_active: true,
    balance_cents: 0,
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
    master_application: null,
    onboarding_completed: true,
    master_onboarding_completed: true,
    phone: null,
    bio: null,
    email: null,
    birth_date: null,
    goals: [],
    goals_custom: null,
    role_switch: null,
    ...overrides,
  }
}

/** PracticeResponse of a free group practice, today 10:00 UTC (see NOW). */
export function makePractice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    master_id: '00000000-0000-4000-8000-0000000000b1',
    master_name: 'Mira Master',
    master_avatar_url: null,
    master_methods: [],
    practice_type: 'group',
    status: 'scheduled',
    title: 'Morning Breathwork',
    description: 'A calm start of the day.',
    what_to_prepare: null,
    contraindications: null,
    scheduled_at: atHour(10),
    duration_minutes: 60,
    timezone: 'UTC',
    max_participants: 12,
    current_participants: 3,
    parent_practice_id: null,
    is_free: true,
    price_cents: 0,
    currency: 'USD',
    direction: null,
    style: null,
    difficulty: null,
    audience_kind: 'public',
    audience_group_names: [],
    school_id: null,
    school_name: null,
    recurrence_days: null,
    total_sessions: null,
    completed_sessions: null,
    is_booked: false,
    is_paid: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: null,
    zoom_public_link: null,
    zoom_meeting_status: null,
    ...overrides,
  }
}

/** A paginated list envelope as the backend returns it. */
export function paged<T>(items: T[]): Record<string, unknown> {
  return { items, total: items.length, limit: 20, offset: 0 }
}

/** Seed the standalone session token before the app starts. */
export async function seedSession(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, token]) => localStorage.setItem(key as string, token as string),
    [SESSION_TOKEN_KEY, SESSION_TOKEN],
  )
}

/** A real launch for stubTelegram(): signed initData and the user it carries. */
export interface TelegramLaunch {
  initData: string
  user: { id: number; first_name: string }
}

/**
 * Launch the page the way Telegram does: the launch parameters in the URL
 * hash (so platform/launch.ts loads the SDK script), and that script itself
 * -- telegram.org is never contacted -- answered with a `window.Telegram.WebApp`
 * stub. `initData` is non-empty, which is what platform/index.ts keys on.
 *
 * On the mocks the initData is a fake (`hash=e2e-stub`); the sweep passes a
 * really signed one (`launch`, e2e/stack/auth.ts) that the backend accepts.
 *
 * @returns the path+hash to `goto`
 */
export async function stubTelegram(
  page: Page,
  startParam?: string,
  launch?: TelegramLaunch,
): Promise<string> {
  const user = launch?.user ?? { id: TELEGRAM_USER_ID, first_name: 'Ada' }
  const initData =
    launch?.initData ??
    new URLSearchParams({
      user: JSON.stringify(user),
      auth_date: '1700000000',
      hash: 'e2e-stub',
      ...(startParam ? { start_param: startParam } : {}),
    }).toString()

  await page.route('https://telegram.org/js/telegram-web-app.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `(() => {
        const noop = () => {}
        window.Telegram = { WebApp: {
          initData: ${JSON.stringify(initData)},
          initDataUnsafe: { user: ${JSON.stringify(user)}${
            startParam ? `, start_param: ${JSON.stringify(startParam)}` : ''
          } },
          colorScheme: 'light',
          platform: 'android',
          version: '8.0',
          ready: noop, expand: noop, close: noop,
          isVersionAtLeast: () => true,
          disableVerticalSwipes: noop,
          setHeaderColor: noop, setBackgroundColor: noop, openLink: noop,
          HapticFeedback: { impactOccurred: noop, notificationOccurred: noop },
          BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
          onEvent: noop, offEvent: noop,
        } }
      })()`,
    }),
  )

  const params = new URLSearchParams({
    tgWebAppData: initData,
    tgWebAppVersion: '8.0',
    tgWebAppPlatform: 'android',
  })
  return `/#${params.toString()}`
}

/**
 * The calls every signed-in screen makes around its own content (profile,
 * unread badge, schools, stats, upcoming list) -- answered with an empty
 * but valid account. A scenario registers its own handler to override one.
 */
export function mockSignedIn(api: MockApi, user: Record<string, unknown> = makeUser()): void {
  api.on('GET', '/api/v1/users/me', user)
  api.on('GET', '/api/v1/schools/mine', { items: [] })
  api.on('GET', '/api/v1/bookings/me/upcoming', [])
  api.on('GET', '/api/v1/bookings/me/stats', {
    practices_attended: 0,
    hours_attended: 0,
    has_unread_messages: false,
  })
  api.on('GET', '/api/v1/practices', paged([]))
  api.on('GET', '/api/v1/taxonomy', { directions: [] })
  api.on('GET', '/api/v1/diary/feed', { items: [], next_cursor: null })
  api.on('GET', '/api/v1/notifications', { items: [], next_cursor: null, unread: 0 })
}
