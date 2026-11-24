import { describe, expect, it } from 'vitest'
import {
  buildProfilePatch,
  type ProfileDrafts,
  type ProfileField,
} from '@/components/console/people/masterProfilePatch'

const drafts = (over: Partial<ProfileDrafts> = {}): ProfileDrafts => ({
  text: '',
  first: '',
  last: '',
  languages: [],
  certifications: [],
  ...over,
})

describe('buildProfilePatch', () => {
  it('sends only the edited field, trimmed', () => {
    expect(buildProfilePatch('display_name', drafts({ text: '  Mira K  ' }))).toEqual({
      patch: { display_name: 'Mira K' },
    })
  })

  it('requires a display name', () => {
    expect(buildProfilePatch('display_name', drafts({ text: '   ' }))).toEqual({
      problem: 'displayNameRequired',
    })
  })

  it.each(['bio', 'email', 'phone'] as const satisfies readonly ProfileField[])(
    'clears %s with null when the draft is empty and keeps a filled one',
    (field) => {
      expect(buildProfilePatch(field, drafts({ text: ' ' }))).toEqual({ patch: { [field]: null } })
      expect(buildProfilePatch(field, drafts({ text: ' x ' }))).toEqual({ patch: { [field]: 'x' } })
    },
  )

  it.each([
    ['0', 0],
    ['50', 50],
    ['7', 7],
  ])('accepts experience %s', (text, years) => {
    expect(buildProfilePatch('experience_years', drafts({ text }))).toEqual({
      patch: { experience_years: years },
    })
  })

  it.each(['-1', '51', '2.5', 'abc'])('rejects experience %s', (text) => {
    expect(buildProfilePatch('experience_years', drafts({ text }))).toEqual({
      problem: 'experienceRange',
    })
  })

  it('sends the account name as two fields, empty parts as null', () => {
    expect(buildProfilePatch('account_name', drafts({ first: ' Ann ', last: ' ' }))).toEqual({
      patch: { first_name: 'Ann', last_name: null },
    })
  })

  it('sends a copy of the chip lists', () => {
    const languages = ['ru', 'en']
    const result = buildProfilePatch('languages', drafts({ languages }))
    expect(result).toEqual({ patch: { languages: ['ru', 'en'] } })
    expect('patch' in result && result.patch.languages).not.toBe(languages)
    expect(buildProfilePatch('certifications', drafts({ certifications: ['A'] }))).toEqual({
      patch: { certifications: ['A'] },
    })
  })
})
