// =============================================================================
// VELO Frontend -- the texts package check (FE-133, protocol v1.7 §4.5-4.7)
// =============================================================================
// The `texts` slot of primer.yaml carries an instance's wording over the
// product's base catalogs. The package is DATA from a partner repository
// (untrusted): this module is the check the machine runs before it switches
// to a package (`validate:` of the slot, apply: runtime) -- as
// `validate-texts <dir>` in the frontend's image (nginx/validate.js, the njs
// CLI of the nginx image), the same shape as primer-blank's.
//
// THE PACKAGE (contract "1.x" of the VELO texts slot):
//
//   primer-package.yaml    block form: `schema: 1`, `contract: "1.0"` -- the
//                          contract is a quoted POINT "X.Y" (a range lives
//                          only in the product's slot)
//   ui/<lang>.json         OVERRIDES only, in the format of the base catalogs
//                          (src/locales/<lang>/*.json merged root-wise):
//                          nested objects, string leaves, arrays of strings
//                          where the base has them. <lang> must be one of the
//                          product's languages
//   comms/**               overrides of the comms profile. NOT read here --
//                          `validate --profile` of comms checks it (contract 3
//                          item 27); this product only keeps it to plain files
//   README.md, LICENSE     read past
//
// Nothing else: any other file, a symlink, an executable file is refused (a
// package is data).
//
// THE PRODUCT'S BASE. The product's languages and its messages are the files
// of BUILT_IN_DIR: <lang>.json, the base catalogs of the language merged
// root-wise (scripts/export-base-texts.mjs writes them at build; the image
// carries them). An override must have the shape of the message it replaces:
// a string for a string, a group for a group, an array of the same length for
// an array -- the runtime would drop it otherwise (locales/overlayShape.ts).
// A key the base does not have is a WARNING, never a refusal: a package
// outlives key renames between product releases. The root key `brand` is
// refused: the brand is a skin property (tz-whitelabel §1), never wording.
//
// THE SUBSET. This file runs under njs (the nginx image) AND Node (the unit
// suite, the build), so it is written in what both share, after primer-blank's
// package.js: no for..of, spread, destructuring, default parameters, classes
// or regex flag u; `import fs from 'fs'`; one default export.
// =============================================================================

import fs from 'fs'

/** The major of the texts contract this product reads (`>=1,<2`). */
const CONTRACT_MAJOR = 1
const MANIFEST = 'primer-package.yaml'
/** The base catalogs in the image: <lang>.json, written at build. */
const BUILT_IN_DIR = '/usr/local/lib/primer/texts'

// Files and directories of a package, at most: a check reads each, so a
// package of many files would hold the machine's check.
const MAX_ENTRIES = 512
const UI_MAX_BYTES = 1024 * 1024
const TEXT_MAX_CHARS = 2000
const MAX_DEPTH = 8

const TOP_FILES = [/^primer-package\.yaml$/, /^README\.md$/, /^LICENSE$/]
const LANGUAGE_FILE = /^ui\/([a-z]{2,3})\.json$/
const COMMS_FILE = /^comms\/([A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']
const MARKUP = /<[A-Za-z/!?]/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

function report(problems, file, where, text) {
  problems.push(where ? file + ': ' + where + ': ' + text : file + ': ' + text)
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** A BOM (a Windows editor) is not content. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** The message of a caught value (njs and Node both throw Error objects). */
function errorMessage(e) {
  return String(/** @type {{ message?: string }} */ (e).message)
}

function isDir(path) {
  try {
    return fs.statSync(path).isDirectory()
  } catch (e) {
    const code = /** @type {{ code?: string }} */ (e).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false
    }
    throw e
  }
}

// Every regular file of the package, relative to its root; a symlink, an
// executable file or anything that is neither a file nor a directory is a
// problem. ".git" at the root is the worktree's link, not the package's, and
// OS litter is read past.
function walk(root, rel, files, problems, seen) {
  const path = rel ? root + '/' + rel : root
  const entries = fs.readdirSync(path, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  entries.forEach((entry) => {
    const name = rel ? rel + '/' + entry.name : entry.name
    if (seen.over || (!rel && entry.name === '.git')) {
      return
    }
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db' || entry.name === 'desktop.ini') {
      return
    }
    seen.count += 1
    if (seen.count > MAX_ENTRIES) {
      seen.over = true
      report(
        problems,
        name,
        '',
        'past ' + MAX_ENTRIES + ' files and directories: a package is smaller',
      )
      return
    }
    if (entry.isSymbolicLink()) {
      report(problems, name, '', 'a symlink: a package holds files only')
    } else if (entry.isDirectory()) {
      walk(root, name, files, problems, seen)
    } else if (entry.isFile()) {
      if (fs.statSync(root + '/' + name).mode & 0o111) {
        report(problems, name, '', 'executable: a package holds no code')
      }
      files.push(name)
    } else {
      report(problems, name, '', 'not a regular file')
    }
  })
}

function packageFiles(dir, problems) {
  const files = []
  if (!isDir(dir)) {
    report(problems, dir, '', 'not a directory')
    return files
  }
  walk(dir, '', files, problems, { count: 0, over: false })
  files.forEach((file) => {
    const ok =
      TOP_FILES.some((pattern) => pattern.test(file)) ||
      LANGUAGE_FILE.test(file) ||
      COMMS_FILE.test(file)
    if (!ok) {
      report(
        problems,
        file,
        '',
        'not a file of the texts format (primer-package.yaml, ui/<lang>.json, comms/...)',
      )
    }
  })
  return files
}

/**
 * primer-package.yaml, block form: `key: value` lines, `#` comments.
 *
 * @returns {{ error?: string, fields?: Record<string, string> }}
 */
function parseManifest(text) {
  /** @type {Record<string, string>} */
  const out = {}
  const lines = stripBom(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
      .replace(/\s+#.*$/, '')
      .replace(/^#.*$/, '')
      .replace(/\s+$/, '')
    if (line.replace(/\s+/g, '') === '') continue
    const m = line.match(/^([a-z_]+):\s*(.*)$/)
    if (!m)
      return { error: 'cannot read the line "' + lines[i].trim() + '" (block form: key: value)' }
    out[m[1]] = m[2].trim()
  }
  return { fields: out }
}

function checkManifest(dir, files, problems) {
  if (files.indexOf(MANIFEST) < 0) {
    report(problems, MANIFEST, '', 'missing')
    return
  }
  const parsed = parseManifest(fs.readFileSync(dir + '/' + MANIFEST, 'utf8'))
  if (parsed.error) {
    report(problems, MANIFEST, '', parsed.error)
    return
  }
  const fields = parsed.fields || {}
  const schema = fields.schema
  const contract = fields.contract
  if (schema !== '1') {
    report(problems, MANIFEST, '', 'schema must be 1, got ' + (schema || 'nothing'))
  }
  const point = String(contract || '').match(/^"(\d+)\.(\d+)"$/)
  if (!point) {
    report(
      problems,
      MANIFEST,
      '',
      'contract must be a quoted point "X.Y" (a range belongs to the product\'s slot), got ' +
        (contract || 'nothing'),
    )
  } else if (Number(point[1]) !== CONTRACT_MAJOR) {
    report(
      problems,
      MANIFEST,
      '',
      'contract "' +
        point[1] +
        '.' +
        point[2] +
        '": this product reads contract ' +
        CONTRACT_MAJOR +
        '.x',
    )
  }
}

/** The product's languages: <lang>.json files of the base directory, sorted. */
function productLanguages(builtIn, problems) {
  const languages = isDir(builtIn)
    ? fs
        .readdirSync(builtIn)
        .filter((name) => /^[a-z]{2,3}\.json$/.test(name))
        .map((name) => name.replace(/\.json$/, ''))
        .sort()
    : []
  if (languages.length === 0) {
    report(problems, builtIn, '', "the product's base texts are not here")
  }
  return languages
}

function kindOf(value) {
  if (Array.isArray(value)) return 'array'
  if (isObject(value)) return 'group'
  return 'message'
}

/** One string of an override: size, no markup, no control characters. */
function checkString(file, where, value, problems) {
  if (value.length > TEXT_MAX_CHARS) {
    report(problems, file, where, 'longer than ' + TEXT_MAX_CHARS + ' characters')
  } else if (MARKUP.test(value)) {
    report(problems, file, where, 'has markup: texts are plain')
  } else if (CONTROL.test(value)) {
    report(problems, file, where, 'has a control character')
  }
}

/**
 * Walk an override node against the base node it lands on (undefined = a key
 * the base does not have). Problems are failures; dead keys go to `warnings`.
 */
function checkNode(file, path, value, base, problems, warnings, dead) {
  const where = path.join('.')
  if (path.length > MAX_DEPTH) {
    report(problems, file, where, 'nested deeper than ' + MAX_DEPTH + ' levels')
    return
  }
  const kind = kindOf(value)
  if (base === undefined) {
    // One warning per dead subtree, at its root.
    if (!dead) warnings.push(file + ': ' + where + ': not in the base texts (a dead key)')
  } else if (kindOf(base) !== kind) {
    report(problems, file, where, 'a ' + kind + ' where the base has a ' + kindOf(base))
    return
  }
  if (kind === 'message') {
    if (typeof value !== 'string') {
      report(problems, file, where, 'a text is a string, not ' + typeof value)
    } else {
      checkString(file, where, value, problems)
    }
  } else if (kind === 'array') {
    if (base !== undefined && base.length !== value.length) {
      report(
        problems,
        file,
        where,
        'a list of ' + value.length + ' where the base has ' + base.length,
      )
      return
    }
    value.forEach((item, index) => {
      if (typeof item !== 'string') {
        report(problems, file, where + '.' + index, 'a text is a string, not ' + typeof item)
      } else {
        checkString(file, where + '.' + index, item, problems)
      }
    })
  } else {
    Object.keys(value).forEach((key) => {
      const here = path.concat([key])
      if (
        key === '' ||
        key.indexOf('.') >= 0 ||
        FORBIDDEN_KEYS.indexOf(key) >= 0 ||
        CONTROL.test(key)
      ) {
        report(
          problems,
          file,
          here.join('.'),
          'a key is non-empty, has no dot and is not ' + FORBIDDEN_KEYS.join(', '),
        )
      } else if (path.length === 0 && key === 'brand') {
        report(problems, file, key, 'the brand is a skin property, not wording')
      } else {
        const known =
          base !== undefined && Object.prototype.hasOwnProperty.call(base, key)
            ? base[key]
            : undefined
        checkNode(file, here, value[key], known, problems, warnings, base === undefined)
      }
    })
  }
}

function readJson(path, problems, file) {
  let text
  try {
    if (fs.statSync(path).size > UI_MAX_BYTES) {
      report(problems, file, '', 'larger than ' + UI_MAX_BYTES + ' bytes')
      return null
    }
    text = fs.readFileSync(path, 'utf8')
  } catch (e) {
    report(problems, file, '', 'cannot be read: ' + errorMessage(e))
    return null
  }
  try {
    return JSON.parse(stripBom(text))
  } catch (e) {
    report(problems, file, '', 'not valid JSON: ' + errorMessage(e))
    return null
  }
}

/**
 * Check the texts package at `dir` against the base texts in `builtIn`
 * (BUILT_IN_DIR when not given).
 *
 * @returns {{ problems: string[], warnings: string[] }} problems refuse the
 *   package; warnings are dead keys
 */
function checkTexts(dir, builtIn) {
  const problems = []
  const warnings = []
  const baseDir = builtIn === undefined ? BUILT_IN_DIR : builtIn
  const languages = productLanguages(baseDir, problems)
  const files = packageFiles(dir, problems)
  if (files.length === 0 && problems.length > 0) {
    return { problems: problems, warnings: warnings }
  }
  checkManifest(dir, files, problems)
  files
    .filter((file) => LANGUAGE_FILE.test(file))
    .forEach((file) => {
      const language = /** @type {RegExpExecArray} */ (LANGUAGE_FILE.exec(file))[1]
      if (languages.indexOf(language) < 0) {
        report(
          problems,
          file,
          '',
          'language ' + language + " is not one of the product's: " + languages.join(', '),
        )
        return
      }
      const doc = readJson(dir + '/' + file, problems, file)
      if (doc === null) return
      if (!isObject(doc)) {
        report(problems, file, '', 'a file of overrides is a JSON object')
        return
      }
      const base = readJson(baseDir + '/' + language + '.json', problems, language + '.json (base)')
      if (base === null) return
      checkNode(file, [], doc, base, problems, warnings, false)
    })
  return { problems: problems, warnings: warnings }
}

export default { checkTexts, parseManifest, BUILT_IN_DIR, CONTRACT_MAJOR }
