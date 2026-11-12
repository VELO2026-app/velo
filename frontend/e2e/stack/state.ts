/**
 * The sweep's shared state (FE-161): who the sweep is (the seeded people of
 * frontend/e2e/stack/seed/e2e.json), where the backend is, and the two
 * files the setup project leaves for the sweep under `e2e/.state/`
 * (gitignored): the session token of each role and the ids the
 * parameterized routes need.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ParamKey, SweepRole } from '../sweep/routes'
import type { TelegramUser } from './auth'

/** The backend the setup calls directly (the browser goes through the frontend's /api proxy). */
export const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:8000'

/** The seeded accounts the sweep runs as, and the helpers the setup needs. */
export const PEOPLE = {
  student: { id: 607011, first_name: 'Ada' },
  master: { id: 607001, first_name: 'Mira' },
  admin: { id: 607031, first_name: 'Root' },
  // Students for the screens ada cannot show in their normal state.
  cara: { id: 607013, first_name: 'Cara' },
  ben: { id: 607012, first_name: 'Ben' },
} as const satisfies Record<string, TelegramUser>

export type Person = keyof typeof PEOPLE

const STATE_DIR = resolve(import.meta.dirname, '../.state')
const TOKENS = resolve(STATE_DIR, 'tokens.json')
const PARAMS = resolve(STATE_DIR, 'params.json')

/** Session tokens by person. */
export type Tokens = Partial<Record<Person, string>>

/** Route-parameter values by key (PARAM_KEYS, e2e/sweep/routes.ts). */
export type Params = Partial<Record<ParamKey, string>>

function read<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function write(file: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

export const readTokens = (): Tokens => read<Tokens>(TOKENS, {})
export const writeTokens = (tokens: Tokens): void => write(TOKENS, tokens)
export const readParams = (): Params => read<Params>(PARAMS, {})
export const writeParams = (params: Params): void => write(PARAMS, params)

/** The token of a sweep role; throws when the setup has not run. */
export function tokenOf(role: SweepRole): string {
  const token = readTokens()[role]
  if (!token) throw new Error(`e2e: no session for ${role} -- the sweep-setup project did not run`)
  return token
}
