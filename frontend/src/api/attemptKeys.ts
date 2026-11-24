// One keeper of an Idempotency-Key per send attempt (FE-232; the appeal
// keeper of FE-104 and the admin reply keeper are this one function).
import { newIdempotencyKey } from '@/api/chats'
import { ApiResponseError } from '@/api/client'

/**
 * The statuses with which the backend REFUSES a write: nothing was processed,
 * so the next attempt is a new write.
 *
 * @remarks
 * Not 409: it can mean "the same key is still being processed", and a retry
 * must then carry the same key. Not 5xx and not a lost connection: the
 * backend may have taken the write.
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422])

/** Whether the error is the backend's refusal of a write (see REFUSAL_STATUSES). */
export function isRefusal(error: unknown): boolean {
  return error instanceof ApiResponseError && REFUSAL_STATUSES.has(error.status)
}

/** A keeper of the key of the CURRENT send attempt. */
export interface AttemptKeys {
  /** The key of the attempt named by `parts`: the same while the parts stay the same. */
  keyFor: (...parts: string[]) => string
  /**
   * End the attempt: call it with no argument when the write landed, with the
   * caught error when it failed. The key is dropped when the write landed or
   * was refused; it stays for any other failure.
   */
  settle: (error?: unknown) => void
}

/**
 * Creates a keeper: one attempt, one key.
 *
 * @remarks
 * `keyFor` returns the same key while its parts (a topic and a text, a
 * thread and a text) stay the same, so a retry of a failed or unanswered
 * send is one write. A changed part mints a new key, so an edited text is
 * never answered with the old write (the backend returns what a key already
 * names). Only the LAST attempt is kept. Every sender calls `settle` the same
 * way: after the write, and in the catch with the error. One keeper per form
 * or screen instance.
 *
 * @param mint - The key source; the default is a uuid.
 */
export function createAttemptKeys(mint: () => string = newIdempotencyKey): AttemptKeys {
  let key: string | null = null
  let attempt = ''
  return {
    keyFor(...parts) {
      const next = JSON.stringify(parts)
      if (key === null || next !== attempt) {
        key = mint()
        attempt = next
      }
      return key
    },
    settle(error) {
      if (error !== undefined && !isRefusal(error)) return
      key = null
      attempt = ''
    },
  }
}
