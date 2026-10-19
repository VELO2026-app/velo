/*
  VELO Frontend -- schoolBranding/defaultMonogram

  The fallback school initial («Ш» for «Школа») when no letter is available:
  catalog data (schools.json -> branding.defaultMonogram), not a code literal.
*/

import schoolsSeed from '@/locales/ru/schools.json'

export function defaultMonogram(): string {
  return (
    (schoolsSeed as { branding?: { defaultMonogram?: string } }).branding?.defaultMonogram ?? 'S'
  )
}
