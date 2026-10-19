// =============================================================================
// VELO Frontend -- Practice languages (shared source, E16)
// =============================================================================
//
// The flat set of languages a master can run practices in. Single source of
// truth for the application wizard (MasterApplyView step 2) and the profile
// editor (EditProfileView, master variant). Plain human-readable strings,
// stored on the master profile as data.profile.languages (mirrors methods).
//
// tz-i18n: the entries are ENDONYMS -- storage canon, not UI copy (every
// locale lists the same 'Русский' / 'English'); the vocabulary lives in the
// locales/ru/languages.json seed for the same reason taxonomy.json does.
// =============================================================================

import languagesSeed from '@/locales/ru/languages.json'

const seedList = (languagesSeed as { languages?: { list?: string[] } }).languages!.list!
export const LANGUAGES: readonly [string, string] = [seedList[0]!, seedList[1]!]
