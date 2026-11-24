/**
 * The accessibility sweep (FE-241): axe-core on every route of the sweep
 * table, under every role that opens it, on ONE skin per run. CI runs it
 * twice, on the build of each pinned brand package (.github/brand-skins.json,
 * fetched by .github/scripts/fetch-brand-skins.mjs): `A11Y_SKIN=gold` and
 * `A11Y_SKIN=goodo`. Rules: WCAG 2.1 A and AA plus heading order.
 *
 * Read-only like the sweep (it opens a screen, it never clicks). A violation
 * fails the test unless (a) it is the one contrast pair the package declared
 * in `contrastExceptions` and holds the 3:1 floor, or (b) ./allowlist.ts names
 * it with its reason and task.
 *
 * Environment: A11Y_SKIN (gold | goodo, required); A11Y_SKIN_DIR, the package
 * the build was made from (default public/skin, where apply-skin.mjs put it).
 */
import { AxeBuilder } from '@axe-core/playwright'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { readParams, tokenOf } from '../stack/state'
import { SESSION_TOKEN_KEY } from '../support/fixtures'
import { settle, trackApi } from '../support/settle'
import { expect, test } from '../support/test'
import { SWEEP, fillPath, type SweepRole } from '../sweep/routes'
import { A11Y_ALLOWLIST } from './allowlist'
import {
  EXTRA_RULES,
  WCAG_TAGS,
  declaredException,
  findingsOf,
  formatFindings,
  hexTokens,
  judge,
  rgbToHex,
  pairFromCss,
  type ContrastException,
  type HexToken,
  type ResolvedPair,
  type SkinName,
} from './findings'

const SKIN = process.env.A11Y_SKIN as SkinName | undefined
const SKIN_DIR = resolve(process.env.A11Y_SKIN_DIR ?? 'public/skin')

interface BrandRecord {
  /** Plain-hex color tokens of the package (tokens/*.tokens.json), to tell the build. */
  hexTokens: HexToken[]
  contrastExceptions?: ContrastException[]
}

/** The brand record and the hex tokens of the package at `dir`. */
function readBrand(dir: string): BrandRecord {
  const tokens = join(dir, 'tokens')
  let contrastExceptions: ContrastException[] | undefined
  const hex: HexToken[] = []
  for (const file of readdirSync(tokens).filter((f) => f.endsWith('.tokens.json'))) {
    const doc = JSON.parse(readFileSync(join(tokens, file), 'utf8')) as {
      $extensions?: { 'velo-skin'?: { contrastExceptions?: ContrastException[] } }
    }
    const brand = doc.$extensions?.['velo-skin']
    if (brand) contrastExceptions = brand.contrastExceptions ?? []
    hex.push(...hexTokens(doc))
  }
  if (!contrastExceptions) throw new Error(`no brand record in ${tokens}: not a skin package`)
  return { contrastExceptions, hexTokens: hex.slice(0, 8) }
}

/** What the page paints for each CSS color variable (computed `rgb(...)`). */
async function paintedColors(page: Page, names: string[]): Promise<Record<string, string>> {
  return page.evaluate((list) => {
    const out: Record<string, string> = {}
    for (const name of list) {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      document.body.append(probe)
      out[name] = getComputedStyle(probe).color
      probe.remove()
    }
    return out
  }, names)
}

/** The declared pair as this page paints it, or null when none is declared. */
async function resolveDeclaredPair(page: Page, brand: BrandRecord): Promise<ResolvedPair | null> {
  if (!declaredException(brand.contrastExceptions ?? [])) return null
  const painted = await paintedColors(page, ['--velo-text-secondary', '--velo-bg-card-solid'])
  const text = painted['--velo-text-secondary']
  const surface = painted['--velo-bg-card-solid']
  return pairFromCss(text ?? '', surface ?? '')
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test.describe(`a11y [${SKIN ?? 'no skin'}]`, () => {
  test.skip(!SKIN, 'A11Y_SKIN=gold|goodo picks the skin of the build under test')
  const skin = SKIN as SkinName
  const brand = SKIN ? readBrand(SKIN_DIR) : (null as never)

  for (const [name, entry] of Object.entries(SWEEP)) {
    if ('skip' in entry) continue
    for (const role of entry.roles) {
      test(`[${role}] ${entry.path}`, { tag: `@${name}` }, async ({ page, crashes }, testInfo) => {
        const path = fillPath(entry, readParams(testInfo.project.name))
        expect(path, `no value for a parameter of ${entry.path} in params.json`).not.toBeNull()
        for (const allowance of entry.allow?.(role) ?? []) crashes.allow(allowance)
        await signIn(page, role)
        const tracker = trackApi(page)

        await page.goto(path!)
        await settle(page, tracker)
        const lands = typeof entry.lands === 'function' ? entry.lands(role) : entry.lands
        await expect(page).toHaveURL(lands ?? new RegExp(`${escape(path!)}$`))

        // The build under test IS the package under test: a stale or wrong
        // build would pass for the wrong skin. The package's plain-hex tokens
        // must be what the page paints.
        const painted = await paintedColors(
          page,
          brand.hexTokens.map((t) => t.css),
        )
        expect(
          brand.hexTokens.map((t) => [t.css, rgbToHex(painted[t.css] ?? '')]),
          `the build is not the ${skin} package`,
        ).toEqual(brand.hexTokens.map((t) => [t.css, t.hex]))

        // Pass 1: the WCAG 2.1 A/AA tag set. Pass 2: the two rules the task
        // names that axe keeps outside that set (best-practice, experimental).
        const wcag = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze()
        const extra = await new AxeBuilder({ page }).withRules([...EXTRA_RULES]).analyze()
        const results = { violations: [...wcag.violations, ...extra.violations] }
        const declared = await resolveDeclaredPair(page, brand)
        const { open } = judge(findingsOf(results, declared), A11Y_ALLOWLIST, name, skin)
        expect(open, `axe on ${skin}:\n${formatFindings(open)}`).toEqual([])
      })
    }
  }
})

async function signIn(page: Page, role: SweepRole): Promise<void> {
  await page.addInitScript(
    ([key, token]) => localStorage.setItem(key!, token!),
    [SESSION_TOKEN_KEY, tokenOf(role)],
  )
}
