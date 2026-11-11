/**
 * Setup for the `node` Vitest project (pure `utils/` and `platform/` tests).
 *
 * The DOM setup (`test-setup.ts`) imports modules that read `window` at load
 * time (`platform/host.ts`), so it cannot run without a DOM. A test that needs
 * the API client, the query cache or Web Storage does not belong in the node
 * project: leave it in the `dom` one (see `vitest.config.ts`).
 */
import { config } from '@vue/test-utils'
import { createTestI18n } from '@/locales/testing'
import { ensureCatalogs, ZONE_CATALOGS } from '@/locales'

await ensureCatalogs(ZONE_CATALOGS)

config.global.plugins = [...config.global.plugins, createTestI18n()]
