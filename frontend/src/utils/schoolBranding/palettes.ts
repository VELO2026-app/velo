/*
  VELO Frontend -- schoolBranding/palettes (tz-curator.md §5.1/§5.3)

  Шесть кураторских палитр × шесть ролей. Порт прототипа -- имена и hex
  не трогать: они входят в golden-SVG.
*/

export interface Palette {
  name: string
  bg: string
  deep: string
  mid: string
  soft: string
  accent: string
  faint: string
}

export const PALETTES: Palette[] = [
  {
    name: 'эвкалипт',
    bg: '#f6f2e8',
    deep: '#3f6f6a',
    mid: '#7fa99f',
    soft: '#b9d1c9',
    accent: '#c99a63',
    faint: '#eae3d2',
  },
  {
    name: 'пыльная лазурь',
    bg: '#f2f1ec',
    deep: '#44658a',
    mid: '#7d9db4',
    soft: '#bccfda',
    accent: '#c4925f',
    faint: '#e4e2d9',
  },
  {
    name: 'лаванда',
    bg: '#f5f2ee',
    deep: '#615c8a',
    mid: '#9d97ba',
    soft: '#cfcbdd',
    accent: '#bd8f63',
    faint: '#e8e4de',
  },
  {
    name: 'шалфей',
    bg: '#f4f3ea',
    deep: '#54694f',
    mid: '#8ba382',
    soft: '#c2cfba',
    accent: '#c69a5c',
    faint: '#e7e5d7',
  },
  {
    name: 'терракота',
    bg: '#f7f1e9',
    deep: '#8f5b40',
    mid: '#c09477',
    soft: '#e0c6b2',
    accent: '#6d8268',
    faint: '#ede2d4',
  },
  {
    name: 'лотос и туман',
    bg: '#f3f2f0',
    deep: '#52616b',
    mid: '#93a0a5',
    soft: '#c9d1d4',
    accent: '#b98f68',
    faint: '#e5e3e0',
  },
]
