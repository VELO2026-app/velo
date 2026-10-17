#!/usr/bin/env node
// tz-i18n (ONE-SHOT): split the monolithic ru.json into per-domain catalogs
// (locales/ru/<domain>.json), per the community pattern for feature-split
// message files. locales/index.ts merges them at startup; per-domain files
// are the seam for phase-4 lazy chunks.
//
// Domain -> top-level namespaces of the current ru.json:
//   common    -> common
//   ui        -> ui
//   auth      -> auth
//   practice  -> practice, booking, bookingCancel, practiceCancel,
//                calendarCard, filters, audience, useTemplate
//   diary     -> diary, reflection
//   master    -> views.master, masterCard, methodPicker
//   admin     -> views.admin, admin, moderation, payout
//   schools   -> school, transfer, tags, curatorGroup, distribution
//   chat      -> chat, composer, voice
//   profile   -> timezone, mood
//   errors    -> errors, transcription, storeErrors, report
//   taxonomy  -> display
//   views     -> views.user, views.auth (screen buckets mid-migration)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'

const RU = 'src/locales/ru.json'
const ru = JSON.parse(readFileSync(RU, 'utf8'))

const DOMAIN_OF = {
  common: 'common',
  ui: 'ui',
  auth: 'auth',
  practice: 'practice',
  booking: 'practice',
  bookingCancel: 'practice',
  practiceCancel: 'practice',
  calendarCard: 'practice',
  filters: 'practice',
  audience: 'practice',
  useTemplate: 'practice',
  diary: 'diary',
  reflection: 'diary',
  'views.master': 'master',
  masterCard: 'master',
  methodPicker: 'master',
  'views.admin': 'admin',
  admin: 'admin',
  moderation: 'admin',
  payout: 'admin',
  school: 'schools',
  transfer: 'schools',
  tags: 'schools',
  curatorGroup: 'schools',
  distribution: 'schools',
  chat: 'chat',
  composer: 'chat',
  voice: 'chat',
  timePicker: 'practice',
  timezone: 'profile',
  mood: 'profile',
  errors: 'errors',
  transcription: 'errors',
  storeErrors: 'errors',
  report: 'errors',
  display: 'taxonomy',
  views: 'views',
  'views.user': 'views',
  'views.auth': 'views',
  tabs: 'common',
  roleSwitch: 'profile',
  shared: 'shared',
}

const domains = {}
for (const [ns, value] of Object.entries(ru)) {
  const domain = DOMAIN_OF[ns]
  if (!domain) {
    console.error(`UNMAPPED namespace: ${ns}`)
    process.exit(2)
  }
  domains[domain] = domains[domain] || {}
  if (ns === 'views') {
    for (const [role, screens] of Object.entries(value)) {
      domains[domain][role] = { ...(domains[domain][role] ?? {}), ...screens }
    }
  } else if (ns.startsWith('views.')) {
    const screen = ns.split('.')[1]
    domains[domain][screen] = { ...(domains[domain][screen] ?? {}), ...value }
  } else {
    domains[domain][ns] = value
  }
}

mkdirSync('src/locales/ru', { recursive: true })
for (const [domain, value] of Object.entries(domains)) {
  writeFileSync(`src/locales/ru/${domain}.json`, JSON.stringify(value, null, 2) + '\n')
  console.log(`${domain}.json: ${Object.keys(value).length} top entries`)
}
rmSync(RU)
console.log('ru.json removed -- locales/index.ts now composes the domain files')
