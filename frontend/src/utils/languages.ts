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
// locale lists the same native names, e.g. Russian under its own endonym
// alongside 'English'); the vocabulary lives in the locales/ru/languages.json
// seed for the same reason taxonomy.json does.
// =============================================================================

// ?raw + JSON.parse: VueI18nPlugin precompiles every plain locales/**/*.json
// import into message ASTs; this seed is DATA (endonym list), so its leaves
// must stay plain strings.
import languagesSeedRaw from '@/locales/ru/languages.json?raw'

const languagesSeed = JSON.parse(languagesSeedRaw) as { languages?: { list?: string[] } }
const [firstLanguage, secondLanguage] = languagesSeed.languages?.list ?? []
if (firstLanguage === undefined || secondLanguage === undefined) {
  throw new Error('languages seed must list at least two languages')
}
/** The practice languages a master can choose, as stored endonyms. */
export const LANGUAGES: readonly [string, string] = [firstLanguage, secondLanguage]
