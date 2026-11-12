// FE-157: zone catalogs load before their routes resolve. Pinned two ways:
// the REAL route table declares the catalog on every route that mounts a
// zone screen (directly or through a parent), and a navigation into a zone
// confirms only once the catalog is merged -- while a student's navigation
// never fetches it.
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router'
import { defineComponent, h } from 'vue'

import router from '@/router'
import { routeCatalogs } from '@/router/catalogs'

const Stub = defineComponent({ render: () => h('div') })

/** Every route record of a table with the catalogs it inherits. */
function* walk(
  records: readonly RouteRecordRaw[],
  inherited: readonly string[] = [],
): Generator<[RouteRecordRaw, string[]]> {
  for (const record of records) {
    const catalogs = [...inherited, ...(record.meta?.catalogs ?? [])]
    yield [record, catalogs]
    if (record.children) yield* walk(record.children, catalogs)
  }
}

/** A lazy route's loader source, which names the module it imports. */
function loaderSource(record: RouteRecordRaw): string {
  return (record.component as () => unknown).toString()
}

describe('the route table declares the zone catalogs its screens need', () => {
  const lazy = [...walk(router.options.routes)].filter(
    ([record]) => typeof record.component === 'function',
  )

  it('every lazy screen is readable as its module path', () => {
    // The check below reads the import target off the loader's source; a
    // loader it cannot read would pass that check silently.
    expect(lazy.length).toBeGreaterThan(80)
    for (const [record] of lazy) expect(loaderSource(record)).toMatch(/\/views\//)
  })

  it.each([
    ['master', /\/views\/master\/|\/views\/shells\/MasterShell\.vue/],
    ['admin', /\/views\/admin\/|\/views\/shells\/AdminShell\.vue/],
  ] as const)('%s screens and shell', (zone, screens) => {
    const zoneRecords = lazy.filter(([record]) => screens.test(loaderSource(record)))
    expect(zoneRecords.length).toBeGreaterThan(5)
    for (const [record, catalogs] of zoneRecords) {
      expect(catalogs, String(record.name ?? record.path)).toContain(zone)
    }
  })

  it('the master and admin shells are lazy; the user shell is not', () => {
    const byPath = (path: string) => router.options.routes.find((r) => r.path === path)
    expect(typeof byPath('/master')?.component).toBe('function')
    expect(typeof byPath('/admin')?.component).toBe('function')
    expect(typeof byPath('/user')?.component).toBe('object')
  })
})

describe('routeCatalogs', () => {
  it('collects the catalogs of every matched record, once each', () => {
    const resolved = router.resolve('/master/practices')
    expect(routeCatalogs(resolved)).toEqual(['master'])
    expect(routeCatalogs(router.resolve('/schools/join/t1'))).toEqual(['master'])
    expect(routeCatalogs(router.resolve('/admin/reports'))).toEqual(['admin'])
    expect(routeCatalogs(router.resolve('/user/dashboard'))).toEqual([])
  })
})

describe('navigation waits for the zone catalog', () => {
  const MASTER_KEY = 'masterScreens.masterOnboarding.welcome.text'
  const ADMIN_KEY = 'moderation.category'

  /** A memory router over FRESH i18n modules: test-setup.ts preloads every
   * zone catalog into the shared singleton. */
  async function setup() {
    vi.resetModules()
    const locales = await import('@/locales')
    const { installRouteCatalogs } = await import('@/router/catalogs')
    const testRouter = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/user', component: Stub },
        {
          path: '/master',
          component: () => Promise.resolve(Stub),
          meta: { catalogs: ['master'] },
          children: [{ path: 'dashboard', component: () => Promise.resolve(Stub) }],
        },
      ],
    })
    installRouteCatalogs(testRouter)
    const te = (key: string) => locales.default.global.te(key, 'ru')
    return { locales, testRouter, te }
  }

  it('a zone route confirms with its catalog merged; others stay unloaded', async () => {
    const { testRouter, te } = await setup()
    const atConfirm: boolean[] = []
    testRouter.afterEach(() => atConfirm.push(te(MASTER_KEY)))

    await testRouter.push('/user')
    expect(te(MASTER_KEY)).toBe(false)

    await testRouter.push('/master/dashboard')
    expect(atConfirm).toEqual([false, true])
    expect(te(ADMIN_KEY)).toBe(false)
  })

  it('a locale switch inside the zone brings the zone catalog of the new locale', async () => {
    const { locales, testRouter } = await setup()
    await testRouter.push('/master/dashboard')
    await locales.setLocale('uk')
    expect(locales.default.global.te(MASTER_KEY, 'uk')).toBe(true)
  })
})
