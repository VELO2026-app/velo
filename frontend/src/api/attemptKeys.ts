// One keeper of an Idempotency-Key per send attempt (FE-232; the appeal
// keeper of FE-104 and the admin reply keeper are this one function).
import { newIdempotencyKey } from '@/api/chats'

/** A keeper of the key of the CURRENT send attempt. */
export interface AttemptKeys {
  /** The key of the attempt named by `parts`: the same while the parts stay the same. */
  keyFor: (...parts: string[]) => string
  /** Drop the key: the next `keyFor` mints a new one. */
  release: () => void
}

/**
 * Creates a keeper: one attempt, one key.
 *
 * @remarks
 * `keyFor` returns the same key while its parts (a topic and a text, a
 * thread and a text) stay the same, so a retry of a failed or unanswered
 * send is one write. A changed part mints a new key, so an edited text is
 * never answered with the old write (the backend returns what a key already
 * names). Only the LAST attempt is kept. The caller calls `release` when the
 * attempt is over -- the write landed, or the backend refused it (4xx: not
 * processed, so a retry after the cause is fixed is a new write). One keeper
 * per form or screen instance.
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
    release() {
      key = null
      attempt = ''
    },
  }
}
