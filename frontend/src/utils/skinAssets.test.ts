// =============================================================================
// VELO Frontend -- templates reach skin images through runtime URLs (FE-230)
// =============================================================================
// A static root-relative src in a template ("/onboarding/x.svg") is compiled
// into a module import when public/ holds no such file -- and the core keeps
// no brand files in public/: the skin package brings them after the bundle.
// The build then fails (the FE-229 review reproduced it). Templates bind the
// URL instead (utils/skinAssets.ts SKIN_IMAGE); this suite keeps them there.
// =============================================================================

import { describe, expect, it } from 'vitest'

const sfcs = import.meta.glob<string>(['/src/**/*.vue', '../../../packages/velo-ui/src/**/*.vue'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Static (unbound) URL attributes of a template that start at the site root. */
function staticRootPaths(sfc: string): string[] {
  const template = sfc.match(/<template>[\s\S]*<\/template>/)?.[0] ?? ''
  const noComments = template.replace(/<!--[\s\S]*?-->/g, '')
  return [...noComments.matchAll(/(?<![:\w.-])(src|srcset|href|poster)="(\/(?!\/)[^"]*)"/g)].map(
    (m) => `${m[1]}="${m[2]}"`,
  )
}

describe('skin images in templates', () => {
  it('the check flags a static root path and passes a bound one', () => {
    expect(staticRootPaths('<template><img src="/onboarding/a.svg" /></template>')).toEqual([
      'src="/onboarding/a.svg"',
    ])
    expect(staticRootPaths('<template><img :src="SKIN_IMAGE.a" /></template>')).toEqual([])
  })

  it('no template carries a static root-relative URL', () => {
    expect(Object.keys(sfcs).length).toBeGreaterThan(100)
    const hits = Object.entries(sfcs).flatMap(([path, sfc]) =>
      staticRootPaths(sfc).map((hit) => `${path}: ${hit}`),
    )
    expect(hits).toEqual([])
  })
})
