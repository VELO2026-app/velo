// The one write that carries an Idempotency-Key (FE-232). The header name is
// written HERE and nowhere else: chats, diary and support all send through
// this function. It is a literal, not a constant: the CORS guard of the
// backend (backend/tests/test_cors_frontend_headers.py) reads literal header
// names in src/api/ and refuses a computed key.
import { api } from '@/api/client'

/**
 * POST with an `Idempotency-Key`: the backend answers a repeat of the same
 * key with the first result, so one logical write can never land twice.
 *
 * @param path - Where to POST; ids inside it go through the `path` tag.
 * @param body - What the endpoint receives, as JSON.
 * @param idempotencyKey - One key per logical write; a retry passes it again.
 */
export function postIdempotent<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
  return api.post<T>(path, body, { 'Idempotency-Key': idempotencyKey })
}
