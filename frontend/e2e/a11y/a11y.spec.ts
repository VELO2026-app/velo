/**
 * The accessibility sweep (FE-241): axe-core on every route of the sweep
 * table, under every role that opens it, on ONE skin per run. CI runs it as
 * two cells (.github/workflows/e2e-a11y.yml), each on the build of one pinned
 * brand package (.github/brand-skins.json, fetched by
 * .github/scripts/fetch-brand-skins.mjs): `A11Y_SKIN=gold` and `goodo`.
 * Rules: WCAG 2.1 A and AA plus heading order and label in name.
 *
 * Read-only like the sweep (it opens a screen, it never clicks). A violation
 * fails the test unless (a) it is the one contrast pair the package declared
 * in `contrastExceptions` and holds the 3:1 floor, or (b) ./allowlist.ts names
 * it with its reason and task. Every test attaches what it saw (`a11y.json`);
 * ./report.ts turns them into the run's summary and fails on an allowlist entry
 * that covered nothing.
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
  REPORT_ATTACHMENT,
  WCAG_TAGS,
  colorTokens,
  declaredException,
  findingsOf,
  formatFindings,
  judge,
  pairFromCss,
  sameColor,
  type ColorToken,
  type ContrastException,
  type ResolvedPair,
  type RouteReport,
  type SkinName,
} from './findings'

const SKIN_DIR = resolve(process.env.A11Y_SKIN_DIR ?? 'public/skin')

/** The skin of this run: null when unset, an error for a value that is no skin. */
function skinFromEnv(value: string | undefined): SkinName | null {
  if (value === undefined || value === '') return null
  if (value === 'gold' || value === 'goodo') return value
  throw new Error(`A11Y_SKIN=${value}: expected gold or goodo`)
}

interface Brand {
  contrastExceptions: ContrastException[]
  /** Color tokens of the package: what the page must paint. */
  colors: ColorToken[]
}

/** The brand record and the color tokens of the package at `dir`. */
function readBrand(dir: string): Brand {
  const tokens = join(dir, 'tokens')
  let contrastExceptions: ContrastException[] | null = null
  const colors: ColorToken[] = []
  for (const file of readdirSync(tokens).filter((f) => f.endsWith('.tokens.json'))) {
    const doc = JSON.parse(readFileSync(join(tokens, file), 'utf8')) as {
      $extensions?: { 'velo-skin'?: { contrastExceptions?: ContrastException[] } }
    }
    const record = doc.$extensions?.['velo-skin']
    if (record) contrastExceptions = record.contrastExceptions ?? []
    colors.push(...colorTokens(doc))
  }
  if (!contrastExceptions) throw new Error(`no brand record in ${tokens}: not a skin package`)
  // A package without one color token could not tell its build from another's.
  if (colors.length === 0) throw new Error(`no color tokens in ${tokens}`)
  return { contrastExceptions, colors }
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
async function resolveDeclaredPair(page: Page, brand: Brand): Promise<ResolvedPair | null> {
  if (!declaredException(brand.contrastExceptions)) return null
  const painted = await paintedColors(page, ['--velo-text-secondary', '--velo-bg-card-solid'])
  return pairFromCss(painted['--velo-text-secondary'] ?? '', painted['--velo-bg-card-solid'] ?? '')
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function signIn(page: Page, role: SweepRole): Promise<void> {
  await page.addInitScript(
    ([key, token]) => localStorage.setItem(key!, token!),
    [SESSION_TOKEN_KEY, tokenOf(role)],
  )
}

function registerRoutes(skin: SkinName, brand: Brand): void {
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
        // build would pass for the wrong skin. Every color token of the
        // package must paint as the package says.
        const painted = await paintedColors(
          page,
          brand.colors.map((t) => t.css),
        )
        const wrong = brand.colors.filter((t) => !sameColor(t.value, painted[t.css] ?? ''))
        expect(
          wrong.map((t) => `${t.css}: package ${t.value}, page ${painted[t.css]}`),
          `the build is not the ${skin} package`,
        ).toEqual([])

        // Pass 1: the WCAG 2.1 A/AA tag set. Pass 2: the two rules the task
        // names that axe keeps outside that set (best-practice, experimental).
        const wcag = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze()
        const extra = await new AxeBuilder({ page }).withRules([...EXTRA_RULES]).analyze()
        const declared = await resolveDeclaredPair(page, brand)
        const { findings, waived } = findingsOf(
          { violations: [...wcag.violations, ...extra.violations] },
          declared,
        )
        const { open, covered } = judge(findings, A11Y_ALLOWLIST, name, skin)

        const report: RouteReport = {
          route: name,
          role,
          skin,
          open,
          covered: [...covered],
          waived: waived.length,
        }
        await testInfo.attach(REPORT_ATTACHMENT, {
          body: JSON.stringify(report),
          contentType: 'application/json',
        })
        expect(open, `axe on ${skin}:\n${formatFindings(open)}`).toEqual([])
      })
    }
  }
}

const skin = skinFromEnv(process.env.A11Y_SKIN)
if (skin === null) {
  // Not a skip: a run that judged nothing must not read as a pass.
  test('A11Y_SKIN names the skin of the build under test', () => {
    throw new Error('set A11Y_SKIN=gold or A11Y_SKIN=goodo (and A11Y_SKIN_DIR, the package)')
  })
} else {
  test.describe(`a11y [${skin}]`, () => registerRoutes(skin, readBrand(SKIN_DIR)))
}
