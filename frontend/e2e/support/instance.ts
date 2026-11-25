/**
 * The instance configs the e2e opens the app under (FE-275). The deploy
 * machine renders `/config.json` from the instance's options at container
 * start (src/platform/launch.ts reads it before the app); a run answers that
 * request itself, so one build is judged as another instance.
 */
import type { Page } from '@playwright/test'

/**
 * The options of the Goodo instance as goodo-dev carries them (OPTION_* of
 * ~/work/velo-dev/goodo/goodo.env, the owner's call): no payments, no mcp, no
 * llm; schools, zoom and telegram on.
 */
export const GOODO_INSTANCE_CONFIG = {
  options: {
    payments: 'false',
    schools: 'true',
    mcp: 'false',
    zoom: 'true',
    telegram: 'true',
    llm: 'false',
  },
} as const

/** Answer the app's `/config.json` with `config` (call before goto). */
export async function serveInstanceConfig(
  page: Page,
  config: typeof GOODO_INSTANCE_CONFIG,
): Promise<void> {
  await page.route('**/config.json', (route) => route.fulfill({ json: config }))
}
