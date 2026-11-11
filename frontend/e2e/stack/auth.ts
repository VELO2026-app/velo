/**
 * Real Telegram login against the e2e stack (FE-161): sign WebApp initData the
 * way Telegram does (HMAC-SHA256, key = HMAC("WebAppData", bot token)) and
 * trade it for a session at `POST /api/v1/auth/telegram`.
 *
 * The bot token is the stack's own: `TELEGRAM_BOT_TOKEN` from the environment
 * (CI sets a fake one, `e2e:fake` -- the backend checks the signature with the
 * same token), else `backend/.env` of the local stand. It is never printed.
 */
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** A Telegram user as initData carries it. */
export interface TelegramUser {
  id: number
  first_name: string
  language_code?: string
}

const BACKEND_ENV = resolve(import.meta.dirname, '../../../backend/.env')

/** The bot token of the stack; throws when there is none. */
export function botToken(): string {
  const fromEnv = process.env.TELEGRAM_BOT_TOKEN
  if (fromEnv) return fromEnv
  if (existsSync(BACKEND_ENV)) {
    for (const line of readFileSync(BACKEND_ENV, 'utf8').split('\n')) {
      const m = /^TELEGRAM_BOT_TOKEN=(.*)$/.exec(line.trim())
      if (m?.[1]) return m[1].trim()
    }
  }
  throw new Error(
    'e2e: no bot token -- set TELEGRAM_BOT_TOKEN to the token the backend runs with (CI: e2e:fake)',
  )
}

/** Signed initData for `user`, valid now. */
export function signInitData(user: TelegramUser, token = botToken()): string {
  const params: Record<string, string> = {
    user: JSON.stringify({ language_code: 'en', ...user }),
    auth_date: String(Math.floor(Date.now() / 1000)),
    // Unique per call: the backend refuses a replayed initData.
    query_id: `e2e${process.hrtime.bigint()}`,
  }
  const checkString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const hash = createHmac('sha256', secret).update(checkString).digest('hex')
  return new URLSearchParams({ ...params, hash }).toString()
}

/** Log `user` in; returns the session token. */
export async function login(apiBase: string, user: TelegramUser): Promise<string> {
  const response = await fetch(`${apiBase}/api/v1/auth/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ init_data: signInitData(user) }),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(
      `e2e: login of telegram_id ${user.id} failed: ${response.status} ${detail}` +
        (response.status === 429 ? ' (rate limit: 5 logins per id per minute)' : ''),
    )
  }
  const body = (await response.json()) as { session_token: string }
  return body.session_token
}
