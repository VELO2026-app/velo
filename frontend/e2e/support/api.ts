/**
 * API mock for the smoke scenarios (FE-157 5A.2): every `/api/v1/**` request
 * of the page is answered here, no backend exists. Handlers are matched by
 * method and exact path; an unmatched request is answered with a 404 and
 * recorded, so a scenario can assert that the app asked for nothing the
 * scenario did not mean to serve.
 */
import type { Page, Route } from '@playwright/test'

/** What a handler answers: a JSON body, optionally with a status. */
export interface MockReply {
  status?: number
  body?: unknown
  /** Hold the answer back, to make an in-flight state observable. */
  delayMs?: number
}

/** A handler gets the parsed JSON request body (null when there is none). */
export type MockHandler = (request: { body: unknown; query: URLSearchParams }) => MockReply

/** A mocked API: register handlers, read what was asked. */
export interface MockApi {
  /** Serve `method path` with a fixed body or a function of the request. */
  on(method: string, path: string, reply: unknown | MockHandler): void
  /** Every `METHOD path` seen, in order, handled or not. */
  readonly calls: string[]
  /** The calls nothing was registered for. */
  readonly unhandled: string[]
  /** JSON bodies sent with `METHOD path`, in order. */
  bodies(method: string, path: string): unknown[]
}

/** Start answering `/api/v1/**` for the page. Call before the first goto. */
export async function mockApi(page: Page): Promise<MockApi> {
  const handlers = new Map<string, MockHandler>()
  const calls: string[] = []
  const unhandled: string[] = []
  const sent = new Map<string, unknown[]>()

  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.pathname}`
    calls.push(key)

    let body: unknown = null
    const raw = request.postData()
    if (raw) {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    sent.set(key, [...(sent.get(key) ?? []), body])

    const handler = handlers.get(key)
    if (!handler) {
      unhandled.push(key)
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: `e2e: no mock for ${key}` }),
      })
      return
    }
    const reply = handler({ body, query: url.searchParams })
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs))
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(reply.body ?? {}),
    })
  })

  return {
    on(method, path, reply) {
      const handler: MockHandler =
        typeof reply === 'function' ? (reply as MockHandler) : () => ({ body: reply })
      handlers.set(`${method.toUpperCase()} ${path}`, handler)
    },
    calls,
    unhandled,
    bodies: (method, path) => sent.get(`${method.toUpperCase()} ${path}`) ?? [],
  }
}
