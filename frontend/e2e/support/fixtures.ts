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
 * Safe-area insets a Telegram client reports (Bot API 8.0): `safe` is the
 * device's own (status bar, home indicator), `content` is what Telegram's
 * controls cover in fullscreen. CSS px.
 */
export interface TelegramInsets {
  safe: { top: number; bottom: number }
  content: { top: number }
}

/**
 * Telegram on an iPhone in fullscreen, as useSafeArea.ts measured it on a
 * device: status bar 44, Telegram's controls 46, home indicator 34.
 */
export const IPHONE_FULLSCREEN: TelegramInsets = {
  safe: { top: 44, bottom: 34 },
  content: { top: 46 },
}

/**
 * Make CSS env(safe-area-inset-*) carry the system part of `insets`
 * (Chromium only: a DevTools protocol override). The app's bottom
 * clearances (tab bars, composers, the layout's padding) read env().
 */
export async function emulateSafeArea(page: Page, insets: TelegramInsets): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: insets.safe.top, bottom: insets.safe.bottom, left: 0, right: 0 },
  })
}

/** Telegram on an iPhone in fullscreen (FE-240: the layout sweep's host). */
export const IPHONE_HOST: TelegramHost = { platform: 'ios', insets: IPHONE_FULLSCREEN }

/** The client a stubbed launch pretends to be (FE-240). */
export interface TelegramHost {
  platform: 'android' | 'ios'
  /** Fullscreen with these insets; absent -- launched from a chat, no insets. */
  insets?: TelegramInsets
}

/**
 * The body of the stubbed telegram-web-app.js: `window.Telegram.WebApp` with
 * no-op methods. With `host.insets` it also stands in for the native side of
 * the bridge @tma.js/sdk talks to (`window.TelegramWebviewProxy.postEvent`):
 * it answers the viewport and safe-area requests with those insets and
 * repeats `viewport_changed` on every resize, as a client does. Answers go
 * back the way the bridge listens: a `message` event from `window.parent`.
 */
export function telegramScript(
  initData: string,
  initDataUnsafe: Record<string, unknown>,
  host: TelegramHost = { platform: 'android' },
): string {
  const insets = host.insets
  const bridge = insets
    ? `
        const safe = { top: ${insets.safe.top}, bottom: ${insets.safe.bottom}, left: 0, right: 0 }
        const content = { top: ${insets.content.top}, bottom: 0, left: 0, right: 0 }
        const send = (eventType, eventData) => setTimeout(() => window.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ eventType, eventData }),
            source: window.parent,
          }),
        ))
        const viewport = () => ({
          height: window.innerHeight, width: window.innerWidth,
          is_expanded: true, is_state_stable: true,
        })
        const answers = {
          web_app_request_viewport: () => send('viewport_changed', viewport()),
          web_app_request_safe_area: () => send('safe_area_changed', safe),
          web_app_request_content_safe_area: () => send('content_safe_area_changed', content),
          web_app_request_fullscreen: () => send('fullscreen_changed', { is_fullscreen: true }),
        }
        window.TelegramWebviewProxy = { postEvent: (type) => answers[type]?.() }
        window.addEventListener('resize', () => send('viewport_changed', viewport()))
        webApp.isFullscreen = true
        webApp.safeAreaInset = safe
        webApp.contentSafeAreaInset = content`
    : ''
  return `(() => {
        const noop = () => {}
        const webApp = {
          initData: ${JSON.stringify(initData)},
          initDataUnsafe: ${JSON.stringify(initDataUnsafe)},
          colorScheme: 'light',
          platform: ${JSON.stringify(host.platform)},
          version: '8.0',
          ready: noop, expand: noop, close: noop,
          isVersionAtLeast: () => true,
          disableVerticalSwipes: noop,
          setHeaderColor: noop, setBackgroundColor: noop, openLink: noop,
          HapticFeedback: { impactOccurred: noop, notificationOccurred: noop },
          BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
          onEvent: noop, offEvent: noop,
        }${bridge}
        window.Telegram = { WebApp: webApp }
      })()`
}

/**
 * The launch parameters Telegram passes in the URL (`tgWebApp*`), as a
 * query string. `tgWebAppFullscreen` goes with insets: only fullscreen has
 * a content safe area.
 */
export function launchParams(initData: string, host: TelegramHost): string {
  return new URLSearchParams({
    tgWebAppData: initData,
    tgWebAppVersion: '8.0',
    tgWebAppPlatform: host.platform,
    ...(host.insets ? { tgWebAppFullscreen: '1' } : {}),
  }).toString()
}

/** Answer the Telegram script URL with `body` instead of contacting telegram.org. */
export async function routeTelegramScript(page: Page, body: string): Promise<void> {
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body }),
  )
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
  host: TelegramHost = { platform: 'android' },
): Promise<string> {
  const user = launch?.user ?? { id: TELEGRAM_USER_ID, first_name: 'Ada' }
  const initData =
    launch?.initData ??
    new URLSearchParams({
      user: JSON.stringify(user),
      auth_date: '1700000000',
      hash: 'e2e-stub',
      // @tma.js parses initData and requires the field (Bot API 8.0).
      signature: 'e2e-stub',
      ...(startParam ? { start_param: startParam } : {}),
    }).toString()

  await routeTelegramScript(
    page,
    telegramScript(initData, { user, ...(startParam ? { start_param: startParam } : {}) }, host),
  )
  return `/#${launchParams(initData, host)}`
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
