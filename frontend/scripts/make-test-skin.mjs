// =============================================================================
// VELO Frontend -- a synthetic skin package for the CI build matrix (FE-131)
// =============================================================================
// velo carries no skins (partner brands live in their own repositories), yet
// the skin path of the BUILD -- assets/ spilled onto /icons, /bg and
// /onboarding, the dist/skin/ prune, @font-face and the font preload, the
// brand grep of a skin cell -- must be exercised on every PR. This writes a
// throwaway package: the core's neutral assets made byte-distinct, a
// deliberately contrasting palette (every value differs from the core, so the
// matrix's "tokens reach dist / never leak into the core build" checks bite),
// a background and a self-hosted font file. Not a brand; nothing is committed.
// The e2e builds in CI carry it too (FE-230: the core has no look to test).
//
// Usage: node scripts/make-test-skin.mjs <out-dir> [--logo] [--support-email] [--mood-icons]
//                (out-dir must not exist)
//        --logo           ship the logo set too (the core's, made distinct)
//                         -- the matrix builds one skin with it and one
//                         without (FE-230)
//        --support-email  put a supportEmail in the brand record (contract
//                         2.2, FE-251) -- the matrix builds one skin with an
//                         address and one without
//        --mood-icons     ship the mood icon set (assets/mood/, contract 2.3,
//                         FE-273): five tiny distinct icons -- the matrix
//                         looks for them in the skin's bundle, never in the
//                         core's
// CI:    node frontend/scripts/make-test-skin.mjs "$RUNNER_TEMP/ci-skin"
//        node frontend/scripts/make-test-skin.mjs "$RUNNER_TEMP/ci-skin-logo" --logo --support-email --mood-icons
//        pnpm -C frontend build:matrix --no-restore --skin "$RUNNER_TEMP/ci-skin" --skin "$RUNNER_TEMP/ci-skin-logo"
//        node frontend/scripts/make-test-skin.mjs frontend/public/skin   (e2e)
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  BRAND_EXTENSION,
  LOGO_ASSETS,
  MANDATORY_ASSETS,
  MOOD_KEYS,
  SKIN_CONTRACT,
  loadSkinPackage,
  readGoldenTokens,
} from './lib/skin-package.mjs'

const args = process.argv.slice(2)
const out = args.find((a) => !a.startsWith('--'))
const FLAGS = ['--logo', '--support-email', '--mood-icons']
const withLogo = args.includes('--logo')
const withSupportEmail = args.includes('--support-email')
const withMoodIcons = args.includes('--mood-icons')
if (!out || args.some((a) => a.startsWith('--') && !FLAGS.includes(a))) {
  console.error(
    'usage: node scripts/make-test-skin.mjs <out-dir> [--logo] [--support-email] [--mood-icons]',
  )
  process.exit(1)
}
const dir = resolve(out)
if (existsSync(dir)) {
  console.error(`make-test-skin: ${dir} exists -- the package is written into a fresh directory`)
  process.exit(1)
}
const frontendDir = resolve(import.meta.dirname, '..')
const publicDir = join(frontendDir, 'public')

mkdirSync(join(dir, 'tokens'), { recursive: true })
mkdirSync(join(dir, 'assets', 'bg'), { recursive: true })
mkdirSync(join(dir, 'assets', 'fonts'), { recursive: true })
// The core's assets made byte-distinct from the core's files -- otherwise the
// matrix could not tell "the build spilled the skin's asset" from "the
// core's one stayed": an SVG gets a comment, a PNG trailing bytes after IEND
// (decoders ignore them; the validator reads IHDR only).
const MARK = '\n<!-- ci-skin -->\n'
const distinct = (from, to) => {
  const body = readFileSync(from)
  writeFileSync(to, Buffer.concat([body, Buffer.from(from.endsWith('.svg') ? MARK : 'ci-skin')]))
}
// The app icons; the logo set only with --logo (contract 2.1). Without it the
// e2e builds and one matrix cell run the logo fallback -- VeloLogo shows
// favicon.svg (FE-230); the --logo cell runs the package's own logo set
// through the spill onto /icons/ and the matrix's byte check.
for (const name of [...MANDATORY_ASSETS, ...(withLogo ? LOGO_ASSETS : [])])
  distinct(join(publicDir, 'icons', name), join(dir, 'assets', name))
// The mood icon set (contract 2.3): a glow and a line mark each, the path
// data distinct per key -- the matrix finds it in the skin's bundle and must
// never find it in the core's. The mark is currentColor, like a real set.
if (withMoodIcons) {
  mkdirSync(join(dir, 'assets', 'mood'), { recursive: true })
  MOOD_KEYS.forEach((key, i) => {
    writeFileSync(
      join(dir, 'assets', 'mood', `${key}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="4 4 32 32" fill="none">
<defs><radialGradient id="glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(20 20) scale(20)"><stop stop-color="#14213D"/><stop offset="1" stop-color="#14213D" stop-opacity="0"/></radialGradient></defs>
<circle cx="20" cy="20" r="20" fill="url(#glow)"/>
<path d="M${10 + i} 12h${4 + i}v${6 + i}h-${4 + i}z" fill="currentColor"/>
</svg>
`,
    )
  })
}
// The core ships no photo (FE-230): a 1x1 lossless WebP stands in. The build
// re-points --velo-app-bg-image at it, so the skin cell exercises the WebP path.
writeFileSync(
  join(dir, 'assets', 'bg', 'background.webp'),
  Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'),
)
// A WOFF2 signature is all the engine checks; the e2e browser falls back to
// the next family of --font-body when the face does not decode.
writeFileSync(join(dir, 'assets', 'fonts', 'ci-sans-400.woff2'), 'wOF2')
// A license file, so the skin cell checks that dist/skin/ carries it.
writeFileSync(join(dir, 'LICENSE'), 'CI-only synthetic skin package. No rights granted.\n')

writeFileSync(
  join(dir, 'primer-package.yaml'),
  `# CI-only synthetic skin (scripts/make-test-skin.mjs) -- not a brand.\nschema: 1\ncontract: "${SKIN_CONTRACT}"\n`,
)
writeFileSync(
  join(dir, 'tokens', 'brand.tokens.json'),
  JSON.stringify(
    {
      $extensions: {
        [BRAND_EXTENSION]: {
          displayName: 'CI Skin',
          shortName: 'CI Skin',
          themeColor: '#14213D',
          backgroundColor: '#FFFFFF',
          fonts: [{ family: 'CI Sans', file: 'assets/fonts/ci-sans-400.woff2', weight: 400 }],
          ...(withSupportEmail ? { supportEmail: 'support@ci-skin.example' } : {}),
        },
      },
    },
    null,
    2,
  ) + '\n',
)
writeFileSync(
  join(dir, 'tokens', 'skin.tokens.json'),
  JSON.stringify(
    {
      velo: {
        primary: { $value: '#14213d', dark: { $value: '#0b1426' } },
        tg: { header: { $value: '#14213d' } },
        text: { primary: { $value: '#000000' }, secondary: { $value: 'rgba(0, 0, 0, 0.7)' } },
        border: { $value: '#14213d' },
        nav: { active: { bg: { $value: 'rgba(252, 163, 17, 0.25)' } } },
        // Motion: dur.fast is one of the tokens the core re-sets under
        // prefers-reduced-motion, dur.pulse is not. e2e/skin.spec.ts reads
        // both: the skin reaches the page, and reduced motion still wins
        // (FE-230).
        dur: { fast: { $value: '999ms' }, pulse: { $value: '777ms' } },
      },
      bare: { 'font-body': { $value: ['CI Sans', 'Noto Sans', 'sans-serif'] } },
    },
    null,
    2,
  ) + '\n',
)

const pkg = loadSkinPackage(dir, readGoldenTokens(frontendDir))
if (pkg.problems.length > 0) {
  console.error(`make-test-skin: the synthetic package is invalid:\n  ${pkg.problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`make-test-skin: ${pkg.decls.length} token(s), ${pkg.files.length} file(s) -> ${dir}`)
