// =============================================================================
// VELO Frontend -- error-reporter unit tests (FE-157 stage 3)
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { ApiResponseError } from '@/api/client'
import {
  installGlobalErrorHandlers,
  reportError,
  setErrorTransport,
  type ClientErrorEvent,
} from './error-reporter'

describe('reportError', () => {
  const events: ClientErrorEvent[] = []

  beforeEach(() => {
    events.length = 0
    setErrorTransport((e) => events.push(e))
  })
  afterEach(() => setErrorTransport(null))

  it('the default transport prints to the console in every mode (R2, until BE-203)', () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('PROD', true)
    setErrorTransport(null)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      reportError(new Error('boom'), { source: 'vue' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0]?.[0])).toContain('boom')
    } finally {
      spy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('passes a normalized event to the transport', () => {
    reportError(new TypeError('boom'), { source: 'vue', info: 'setup function' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      name: 'TypeError',
      message: 'boom',
      source: 'vue',
      info: 'setup function',
    })
    expect(events[0]!.stack).toContain('boom')
  })

  it('reports only the pathname, never query or hash', () => {
    window.history.replaceState({}, '', '/practice/5?tgWebAppData=secret#frag')
    reportError(new Error('x'), { source: 'window' })
    expect(events[0]!.path).toBe('/practice/5')
    window.history.replaceState({}, '', '/')
  })

  it('wraps a non-Error rejection reason', () => {
    reportError('plain string', { source: 'unhandledrejection' })
    expect(events[0]).toMatchObject({ name: 'string', message: 'plain string' })
  })

  it('ignores expected 4xx API errors but reports 5xx ones', () => {
    reportError(new ApiResponseError(404, 'nf', 'not_found'), { source: 'vue' })
    reportError(new ApiResponseError(422, 'bad', 'validation_error'), { source: 'vue' })
    expect(events).toHaveLength(0)
    reportError(new ApiResponseError(500, 'oops', 'internal_error'), { source: 'vue' })
    expect(events).toHaveLength(1)
  })

  it('survives a throwing transport', () => {
    setErrorTransport(() => {
      throw new Error('transport down')
    })
    expect(() => reportError(new Error('x'), { source: 'vue' })).not.toThrow()
  })

  it('does not recurse when the transport reports again', () => {
    const inner = vi.fn(() => reportError(new Error('again'), { source: 'vue' }))
    setErrorTransport(inner)
    reportError(new Error('x'), { source: 'vue' })
    expect(inner).toHaveBeenCalledTimes(1)
  })
})

describe('installGlobalErrorHandlers', () => {
  const events: ClientErrorEvent[] = []
  let uninstall: () => void
  let app: ReturnType<typeof createApp>
  let routerErrorHandler: (e: unknown) => void

  beforeEach(() => {
    events.length = 0
    setErrorTransport((e) => events.push(e))
    app = createApp({ render: () => null })
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    vi.spyOn(router, 'onError').mockImplementation((cb) => {
      routerErrorHandler = cb as (e: unknown) => void
      return () => {}
    })
    uninstall = installGlobalErrorHandlers(app, router)
  })
  afterEach(() => {
    uninstall()
    setErrorTransport(null)
  })

  it('routes the Vue error handler with its info', () => {
    app.config.errorHandler!(new Error('vue'), null, 'render function')
    expect(events[0]).toMatchObject({ source: 'vue', info: 'render function', message: 'vue' })
  })

  it('routes router navigation errors', () => {
    routerErrorHandler(new Error('nav'))
    expect(events[0]).toMatchObject({ source: 'router', message: 'nav' })
  })

  it('routes window error events', () => {
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('win'), message: 'win' }))
    expect(events[0]).toMatchObject({ source: 'window', message: 'win' })
  })

  it('routes unhandled rejections', () => {
    const ev = new Event('unhandledrejection') as Event & { reason: unknown }
    ev.reason = new Error('rej')
    window.dispatchEvent(ev)
    expect(events[0]).toMatchObject({ source: 'unhandledrejection', message: 'rej' })
  })

  it('stops listening after uninstall', () => {
    uninstall()
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('late') }))
    expect(events).toHaveLength(0)
  })
})
