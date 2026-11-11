// =============================================================================
// VELO Frontend -- Colada queries across a reload (FE-157 4F)
// =============================================================================
//
// The pilot's answer to the ADR question "does persistedCache move to Colada
// as a plugin?": persistPlugin mirrors opted-in queries into the same
// per-account sessionStorage copy and hydrates them on the next start. A
// "reload" here is a second app over a fresh Pinia: the in-memory cache is
// gone, sessionStorage is not.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada, useQuery, type UseQueryReturn } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import { persistSlot } from '@/composables/queries/persist'
import { flushPersisted, readPersisted, setPersistOwner } from '@/composables/persistedCache'

const KEY = ['bookings', 'stats'] as const

let apps: App[] = []

/** Start the app once: a screen reading KEY, answered by `answer`. */
function start(
  answer: () => Promise<{ attended: number }>,
  persist = true,
): UseQueryReturn<{ attended: number }> {
  let query!: UseQueryReturn<{ attended: number }>
  const Screen = defineComponent({
    setup() {
      query = useQuery({ key: KEY, query: answer, meta: { persist } })
      return () => h('div')
    },
  })
  const app = createApp(Screen)
    .use(createPinia())
    .use(PiniaColada, { ...coladaOptions, plugins: coladaOptions.plugins })
  app.mount(document.createElement('div'))
  apps.push(app)
  return query
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The persisted copy of KEY, as the next start would read it. */
function saved(): unknown {
  flushPersisted()
  return readPersisted(persistSlot(JSON.stringify(KEY)))?.data
}

beforeEach(() => {
  setPersistOwner('user_1')
})

afterEach(() => {
  for (const app of apps) app.unmount()
  apps = []
})

describe('persistPlugin', () => {
  it('writes the answer of a persisted query', async () => {
    start(async () => ({ attended: 3 }))
    await flush()

    expect(saved()).toEqual({ attended: 3 })
  })

  it('the next start shows the copy at once, stale, and replaces it with the answer', async () => {
    start(async () => ({ attended: 3 }))
    await flush()
    flushPersisted()

    let answer!: (value: { attended: number }) => void
    const query = start(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    await flush()

    // Before the answer: the copy is on screen and a request is out.
    expect(query.data.value).toEqual({ attended: 3 })
    expect(query.asyncStatus.value).toBe('loading')
    answer({ attended: 4 })
    await flush()
    expect(query.data.value).toEqual({ attended: 4 })
    expect(saved()).toEqual({ attended: 4 })
  })

  it("never hydrates another account's copy", async () => {
    start(async () => ({ attended: 3 }))
    await flush()
    flushPersisted()

    setPersistOwner('user_2')
    const query = start(() => new Promise(() => {}))
    await flush()

    expect(query.data.value).toBeUndefined()
  })

  it('leaves a query without meta.persist in memory only', async () => {
    start(async () => ({ attended: 3 }), false)
    await flush()

    expect(saved()).toBeUndefined()
  })
})
