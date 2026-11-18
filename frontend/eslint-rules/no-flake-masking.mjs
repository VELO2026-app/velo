// FE-203 rule 2: no masking of flaky tests (docs/testing.md, rules 9-10).
// A test that fails now and then gets retried, given more time or skipped:
// it turns green, the cause stays. Caught:
//   - `retry` (any value but a literal 0) in the options of it/test/describe,
//     in vi.setConfig(...) and in a vitest config file;
//   - a timeout above the vitest default (5000 ms, also set explicitly in
//     vitest.config.ts): `{ timeout: N }`, the numeric argument after the
//     test or hook function, testTimeout / hookTimeout / teardownTimeout in
//     vi.setConfig(...) and in a vitest config file. A value that is not a
//     literal cannot be checked and counts as raised;
//   - `.skip` / `.skipIf` on it/test/describe without a task reference
//     (FE-123, BE-45, ...) in a comment right above or on the same line.
import { RATCHET_SCHEMA, SHRINK_MESSAGE, createRatchet } from './ratchet.mjs'

/** The vitest default the suite keeps (vitest.config.ts testTimeout). */
const DEFAULT_TIMEOUT_MS = 5000

const TEST_APIS = new Set([
  'it',
  'test',
  'describe',
  'suite',
  'bench',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
])
const SKIPS = new Set(['skip', 'skipIf'])
const CONFIG_TIMEOUTS = new Set(['testTimeout', 'hookTimeout', 'teardownTimeout'])
const TASK_REF = /\b[A-Z]{2,}-\d+\b/
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

/** A timeout value that is provably within the default. */
function withinDefault(value) {
  return value.type === 'Literal' && typeof value.value === 'number'
    ? value.value <= DEFAULT_TIMEOUT_MS
    : false
}

function isZero(value) {
  return value.type === 'Literal' && value.value === 0
}

function isFunction(node) {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression'
}

const INSTEAD =
  'Find the race instead: wait for the operation or the event, or use vi.useFakeTimers().'

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid retries, raised timeouts and unexplained skips (FE-203).' },
    schema: RATCHET_SCHEMA,
    messages: {
      retry: `A retry turns a flaky test green and keeps the cause. ${INSTEAD}`,
      timeout:
        `Timeout raised above the ${DEFAULT_TIMEOUT_MS} ms default ({{value}}): ` +
        `more time hides a wait for the wrong thing. ${INSTEAD}`,
      skip:
        '.{{name}} without a task reference. Name the task in a comment right above ' +
        '(// FE-123: why), or fix the test, or delete it.',
      shrinkAllowlist: SHRINK_MESSAGE,
    },
  },
  create(context) {
    const ratchet = createRatchet(context, 'no-flake-masking')
    const source = context.sourceCode
    const isConfigFile = VITEST_CONFIG.test(context.filename.split('\\').join('/'))

    function checkOptions(obj, timeoutKeys) {
      for (const prop of obj.properties) {
        const key = keyName(prop)
        if (key === 'retry' && !isZero(prop.value)) {
          ratchet.add({ node: prop, messageId: 'retry' })
        } else if (key && timeoutKeys.has(key) && !withinDefault(prop.value)) {
          ratchet.add({
            node: prop,
            messageId: 'timeout',
            data: { value: source.getText(prop.value) },
          })
        }
      }
    }

    /** A task key in a comment right above the statement or on its line. */
    function hasTaskRef(node) {
      let stmt = node
      while (stmt.parent && !/Statement|Declaration$/.test(stmt.type)) stmt = stmt.parent
      const before = source.getCommentsBefore(stmt)
      const sameLine = source
        .getAllComments()
        .filter((c) => c.loc?.start.line === node.loc?.start.line)
      return [...before, ...sameLine].some((c) => TASK_REF.test(c.value))
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
          if (arg?.type === 'ObjectExpression') checkOptions(arg, CONFIG_TIMEOUTS)
          return
        }
        const root = chainRoot(callee)
        if (!root || !TEST_APIS.has(root)) return
        let afterFn = false
        for (const arg of node.arguments) {
          if (arg.type === 'ObjectExpression') {
            checkOptions(arg, new Set(['timeout']))
          } else if (isFunction(arg)) {
            afterFn = true
          } else if (afterFn && !withinDefault(arg)) {
            // it(name, fn, timeout) / beforeEach(fn, timeout)
            ratchet.add({
              node: arg,
              messageId: 'timeout',
              data: { value: source.getText(arg) },
            })
          }
        }
      },
      MemberExpression(node) {
        if (node.computed || node.property.type !== 'Identifier') return
        if (!SKIPS.has(node.property.name)) return
        const root = chainRoot(node.object)
        if (!root || !TEST_APIS.has(root) || hasTaskRef(node)) return
        ratchet.add({ node: node.property, messageId: 'skip', data: { name: node.property.name } })
      },
      Property(node) {
        if (!isConfigFile) return
        const key = keyName(node)
        if (key === 'retry' && !isZero(node.value)) {
          ratchet.add({ node, messageId: 'retry' })
        } else if (key && CONFIG_TIMEOUTS.has(key) && !withinDefault(node.value)) {
          ratchet.add({ node, messageId: 'timeout', data: { value: source.getText(node.value) } })
        }
      },
      'Program:exit': () => ratchet.exit(),
    }
  },
}
