/**
 * @velo/ui -- inputKind
 *
 * Maps a field `kind` to the native attributes that steer the mobile soft
 * keyboard: which layout opens (`inputmode`), what the action key says
 * (`enterkeyhint`), what the browser may fill in (`autocomplete`) and whether
 * it capitalises or autocorrects what is typed.
 *
 * Idea adapted from the input-hints helper of vercel-labs/ui (Apache-2.0,
 * https://github.com/vercel-labs/ui); the table below is VELO's own.
 */

export type InputKind = 'text' | 'name' | 'email' | 'tel' | 'search' | 'numeric' | 'url' | 'message'

type KindAttrs = Readonly<Record<string, string>>

const KIND_ATTRS: Readonly<Record<InputKind, KindAttrs>> = {
  text: {},
  name: {
    autocomplete: 'name',
    autocapitalize: 'words',
    enterkeyhint: 'next',
  },
  email: {
    inputmode: 'email',
    autocomplete: 'email',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'next',
  },
  tel: {
    inputmode: 'tel',
    autocomplete: 'tel',
    enterkeyhint: 'next',
  },
  search: {
    inputmode: 'search',
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
  },
  numeric: {
    inputmode: 'numeric',
    autocomplete: 'off',
    enterkeyhint: 'done',
  },
  url: {
    inputmode: 'url',
    autocomplete: 'url',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
  },
  // Multi-line free text: Enter inserts a line break, sentences start capitalised.
  message: {
    autocomplete: 'off',
    autocapitalize: 'sentences',
    enterkeyhint: 'enter',
  },
}

/**
 * Native attributes for a field kind. An undefined kind yields nothing, so a
 * field without `kind` renders exactly as before. Spread this BEFORE `$attrs`
 * so a caller's own attribute wins.
 */
export function inputKindAttrs(kind: InputKind | undefined): KindAttrs {
  return kind ? KIND_ATTRS[kind] : {}
}
