/**
 * A tiny API client for the sweep setup (FE-161): JSON in, JSON out, as one
 * of the seeded people. Throws with the status and the body's first 300
 * characters on any non-2xx answer, unless the status is in `ok`.
 */
import { API_URL, type Person, type Tokens } from './state'

export interface Call {
  body?: unknown
  /** Statuses besides 2xx the caller handles itself (an "already exists" 409...). */
  ok?: number[]
  headers?: Record<string, string>
}

export type Api = <T = unknown>(method: string, path: string, call?: Call) => Promise<T>

/** An API bound to `person`'s session. */
export function apiAs(tokens: Tokens, person: Person): Api {
  return async <T>(method: string, path: string, call: Call = {}): Promise<T> => {
    const token = tokens[person]
    if (!token) throw new Error(`e2e setup: ${person} is not logged in`)
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...call.headers,
        ...(call.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    })
    const text = await response.text()
    if (!response.ok && !call.ok?.includes(response.status)) {
      throw new Error(
        `e2e setup: ${person} ${method} ${path} -> ${response.status} ${text.slice(0, 300)}`,
      )
    }
    return (text ? JSON.parse(text) : null) as T
  }
}

/** The status of `GET path` as `person` -- for "does this still exist" checks. */
export async function statusOf(tokens: Tokens, person: Person, path: string): Promise<number> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${tokens[person] ?? ''}` },
  })
  await response.arrayBuffer()
  return response.status
}

/** True when `token` still opens a session. */
export async function sessionAlive(token: string): Promise<boolean> {
  const response = await fetch(`${API_URL}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return response.ok
}
