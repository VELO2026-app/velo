// FE-203 rule 2: no masking of flaky tests (docs/testing.md, rules 9-10).
// A test that fails now and then gets retried, given more time or skipped:
// it turns green, the cause stays. Caught:
//   - `retry` (any value but a literal 0) in the options of it/test/describe,
//     in vi.setConfig(...) and in a vitest config file;
//   - a timeout above the vitest default: 5000 ms for a test (`{ timeout }`,
//     the number after the test function, testTimeout), 10000 ms for a hook
//     (the number after the hook function, hookTimeout, teardownTimeout) --
//     both are vitest's own defaults, so the message never calls a default
//     "raised". A value that is not a literal cannot be checked and counts
//     as raised;
//   - a skip without a marker: `.skip` / `.skipIf` / `.runIf` on
//     it/test/describe, and the test context's skip (`ctx.skip()`,
//     `({ skip }) => skip()`), need `// skip: FE-123 <why>` right above or on
//     the same line. In the app oxlint's vitest/no-disabled-tests bans
//     `.skip` outright; the marker is what lets skipIf/runIf/ctx.skip (and
//     `.skip` in the kit) through.
import { RATCHET_SCHEMA, SHRINK_MESSAGE, createRatchet } from './ratchet.mjs'

/** vitest's default test timeout (also set explicitly in both configs). */
const TEST_DEFAULT_MS = 5000
/** vitest's default hook and teardown timeout. */
const HOOK_DEFAULT_MS = 10000

const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll'])
const TEST_APIS = new Set(['it', 'test', 'describe', 'suite', 'bench', ...HOOKS])
const SKIPS = new Set(['skip', 'skipIf', 'runIf'])
const CONFIG_LIMITS = new Map([
  ['testTimeout', TEST_DEFAULT_MS],
  ['hookTimeout', HOOK_DEFAULT_MS],
  ['teardownTimeout', HOOK_DEFAULT_MS],
])
const TEST_OPTION_LIMITS = new Map([['timeout', TEST_DEFAULT_MS]])
/** The skip marker: an explicit `skip:` and a key of one of our teams. */
export const SKIP_MARKER = /\bskip:\s*(?:FE|BE|PM|DSGN|DM|MEET)-\d+\b/
const VITEST_CONFIG = /(^|\/)vitest\.config\.[cm]?[jt]s$/

/** The identifier a test-API chain starts from: `it` in `it.each(t)(...)`. */
function chainRoot(node) {
  let n = node
  for (;;) {
    if (n.type === 'MemberExpression') n = n.object
    else if (n.type === 'CallExpression') n = n.callee
    else if (n.type === 'TaggedTemplateExpression') n = n.tag
    else return n.type === 'Identifier' ? n.name : null
  }
}

function keyName(prop) {
  if (prop.type !== 'Property' || prop.computed) return null
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal') return String(prop.key.value)
  return null
}

/** A timeout value that is provably within the limit. */
function withinLimit(value, limit) {
  return value.type === 'Literal' && typeof value.value === 'number' && value.value <= limit
}

function isZero(value) {
  return value.type === 'Literal' && value.value === 0
}

function isFunction(node) {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression'
}

const INSTEAD =
  'Find the race instead: wait for the operation or the event, or use vi.useFakeTimers().'

/** The first parameter's skip, if the function is a test or hook body. */
function contextSkipCalls(sourceCode, fn) {
  const param = fn.params[0]
  if (!param) return []
  let name = null
  let viaMember = false
  if (param.type === 'Identifier') {
    name = param.name
    viaMember = true
  } else if (param.type === 'ObjectPattern') {
    for (const prop of param.properties) {
      if (keyName(prop) !== 'skip') continue
      const v = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value
      if (v.type === 'Identifier') name = v.name
    }
  }
  if (!name) return []
  const variable = sourceCode.getDeclaredVariables(fn).find((v) => v.name === name)
  if (!variable) return []
  const found = []
  for (const ref of variable.references) {
    const id = ref.identifier
    const parent = id.parent
    if (viaMember) {
      if (
        parent?.type === 'MemberExpression' &&
        parent.object === id &&
        !parent.computed &&
        parent.property.type === 'Identifier' &&
        parent.property.name === 'skip' &&
        parent.parent?.type === 'CallExpression' &&
        parent.parent.callee === parent
      ) {
        found.push({ node: parent.property, name: `${name}.skip()` })
      }
    } else if (parent?.type === 'CallExpression' && parent.callee === id) {
      found.push({ node: id, name: `${name}()` })
    }
  }
  return found
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid retries, raised timeouts and unexplained skips (FE-203).' },
    schema: RATCHET_SCHEMA,
    messages: {
      retry: `A retry turns a flaky test green and keeps the cause. ${INSTEAD}`,
      timeout:
        'Timeout raised above the {{limit}} ms vitest default ({{value}}): ' +
        `more time hides a wait for the wrong thing. ${INSTEAD}`,
      skip:
        '{{name}} without a skip marker. Put the task right above or on the same line: ' +
        '// skip: FE-123 <why> -- or fix the test, or delete it. (In the app, oxlint ' +
        'vitest/no-disabled-tests bans .skip outright; the marker covers skipIf, runIf ' +
        'and the context skip.)',
      shrinkAllowlist: SHRINK_MESSAGE,
    },
  },
  create(context) {
    const ratchet = createRatchet(context, 'no-flake-masking')
    const source = context.sourceCode
    const isConfigFile = VITEST_CONFIG.test(context.filename.split('\\').join('/'))

    function reportTimeout(node, value, limit) {
      ratchet.add({
        node,
        messageId: 'timeout',
        data: { value: source.getText(value), limit: String(limit) },
      })
    }

    function checkProperty(prop, limits) {
      const key = keyName(prop)
      if (key === 'retry' && !isZero(prop.value)) {
        ratchet.add({ node: prop, messageId: 'retry' })
        return
      }
      const limit = key ? limits.get(key) : undefined
      if (limit !== undefined && !withinLimit(prop.value, limit)) {
        reportTimeout(prop, prop.value, limit)
      }
    }

    function checkOptions(obj, limits) {
      for (const prop of obj.properties) checkProperty(prop, limits)
    }

    /** A skip marker in a comment right above the statement or on its line. */
    function hasSkipMarker(node) {
      let stmt = node
      while (stmt.parent && !/Statement|Declaration$/.test(stmt.type)) stmt = stmt.parent
      const before = source.getCommentsBefore(stmt)
      const sameLine = source
        .getAllComments()
        .filter((c) => c.loc?.start.line === node.loc?.start.line)
      return [...before, ...sameLine].some((c) => SKIP_MARKER.test(c.value))
    }

    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'vi' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'setConfig'
        ) {
          const arg = node.arguments[0]
          if (arg?.type === 'ObjectExpression') checkOptions(arg, CONFIG_LIMITS)
          return
        }
        const root = chainRoot(callee)
        if (!root || !TEST_APIS.has(root)) return
        const limit = HOOKS.has(root) ? HOOK_DEFAULT_MS : TEST_DEFAULT_MS
        let afterFn = false
        for (const arg of node.arguments) {
          if (arg.type === 'ObjectExpression') {
            checkOptions(arg, TEST_OPTION_LIMITS)
          } else if (isFunction(arg)) {
            afterFn = true
            for (const call of contextSkipCalls(source, arg)) {
              if (!hasSkipMarker(call.node)) {
                ratchet.add({ node: call.node, messageId: 'skip', data: { name: call.name } })
              }
            }
          } else if (afterFn && !withinLimit(arg, limit)) {
            // it(name, fn, timeout) / beforeEach(fn, timeout)
            reportTimeout(arg, arg, limit)
          }
        }
      },
      MemberExpression(node) {
        if (node.computed || node.property.type !== 'Identifier') return
        if (!SKIPS.has(node.property.name)) return
        const root = chainRoot(node.object)
        if (!root || !TEST_APIS.has(root) || hasSkipMarker(node)) return
        ratchet.add({
          node: node.property,
          messageId: 'skip',
          data: { name: `${root}.${node.property.name}` },
        })
      },
      Property(node) {
        if (isConfigFile) checkProperty(node, CONFIG_LIMITS)
      },
      'Program:exit': () => ratchet.exit(),
    }
  },
}
