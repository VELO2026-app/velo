import { describe, expect, it } from 'vitest'
import { shellOnlyTransform, type PrecacheEntry } from './precache-shell'

const entry = (url: string): PrecacheEntry => ({ url, size: 1, revision: null })

const files: Record<string, string> = {
  'index.html':
    '<script type="module" src="/assets/index-A.js"></script><link href="/assets/app-C.css">',
  'assets/index-A.js': 'import"./instance-B.js";import("./app-D.js")',
  'assets/app-D.js':
    'import{x}from"./instance-B.js";import("./AdminShell-E.js");import{y}from"./shared-F.js"',
  'assets/shared-F.js': 'export const y=1',
}
const read = (url: string): string => files[url] ?? ''

describe('shellOnlyTransform', () => {
  const urls = [
    'index.html',
    'fonts/f.woff2',
    'assets/index-A.js',
    'assets/instance-B.js',
    'assets/app-C.css',
    'assets/app-D.js',
    'assets/shared-F.js',
    'assets/AdminShell-E.js',
    'assets/zzz-lazy.js',
  ]

  it('keeps non-assets entries and the startup closure, drops lazy chunks', () => {
    const { manifest } = shellOnlyTransform(read)(urls.map(entry))
    expect(manifest.map((e) => e.url).sort()).toEqual(
      [
        'index.html',
        'fonts/f.woff2',
        'assets/index-A.js',
        'assets/instance-B.js',
        'assets/app-C.css',
        'assets/app-D.js',
        'assets/shared-F.js',
      ].sort(),
    )
  })

  it('does not follow dynamic imports', () => {
    const { manifest } = shellOnlyTransform(read)(urls.map(entry))
    expect(manifest.map((e) => e.url)).not.toContain('assets/AdminShell-E.js')
  })

  it('keeps only the app chunk and its CSS when the files are unreadable', () => {
    const { manifest } = shellOnlyTransform(() => '')(urls.map(entry))
    expect(manifest.map((e) => e.url).sort()).toEqual(
      ['index.html', 'fonts/f.woff2', 'assets/app-C.css', 'assets/app-D.js'].sort(),
    )
  })
})
