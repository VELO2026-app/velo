// FE-203 rule 1: no fixed pauses in tests (docs/testing.md, rule 10).
// A test that sleeps N ms is waiting for something it does not name: the
// wait is too long on a fast machine and too short on a loaded CI runner.
// Caught:
//   - setTimeout / setInterval with a delay other than a literal 0 inside a
//     `new Promise(...)` executor -- the `await new Promise((r) =>
//     setTimeout(r, 500))` idiom, a sleep(ms) helper, a mock that settles
//     after a delay. A literal 0 (one macrotask) is a flush, not a pause;
//   - `setTimeout` / `setInterval` imported by name from node:timers/promises
//     (`await setTimeout(500)`).
//
// Known gaps (syntax only, no data flow; left for a follow-up, not caught):
//   - an aliased or destructured timer (`const t = setTimeout`,
//     `const { setTimeout: t } = globalThis`);
//   - a namespace or default import of node:timers/promises
//     (`import * as timers`, `timers.setTimeout(500)`);
//   - `scheduler.wait(ms)` and `promisify(setTimeout)`;
//   - a sleep helper defined outside *.test.ts and imported by the test;
//   - `vi.waitFor` / `expect.poll` with a raised `{ timeout }` (they poll a
//     condition, so they are bounded waits, but the bound is not checked);
//   - no-flake-masking: a skip marker in a comment at the END of a multi-line
//     `it.skip(...)` (only comments above or on the first line count).
import { RATCHET_SCHEMA, SHRINK_MESSAGE, createRatchet } from './ratchet.mjs'

const TIMERS = new Set(['setTimeout', 'setInterval'])
const TIMER_HOSTS = new Set(['window', 'globalThis', 'self', 'global'])

/** `setTimeout` or `window.setTimeout` (and the other global hosts). */
function timerName(callee) {
  if (callee.type === 'Identifier' && TIMERS.has(callee.name)) return callee.name
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    TIMER_HOSTS.has(callee.object.name) &&
    callee.property.type === 'Identifier' &&
    TIMERS.has(callee.property.name)
  ) {
    return callee.property.name
  }
  return null
}

/** A delay that is provably zero: omitted, or the literal 0. */
function isZeroDelay(arg) {
  return !arg || (arg.type === 'Literal' && arg.value === 0)
}

/** Whether the node sits inside the executor of a `new Promise(...)`. */
function insidePromiseExecutor(node) {
  for (let n = node.parent; n; n = n.parent) {
    const fn = n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression'
    if (
      fn &&
      n.parent?.type === 'NewExpression' &&
      n.parent.callee.type === 'Identifier' &&
      n.parent.callee.name === 'Promise' &&
      n.parent.arguments[0] === n
    ) {
      return true
    }
  }
  return false
}

const INSTEAD =
  'Wait for the thing itself: the awaited operation, an event (transitionend, an emit), ' +
  'or vi.useFakeTimers() + await vi.advanceTimersByTimeAsync(ms). For a mock that must ' +
  'stay pending, return a promise the test releases itself: ' +
  'let release; new Promise((r) => { release = r }), then release() when the test is ready.'

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid fixed pauses in tests (FE-203, docs/testing.md rule 10).' },
    schema: RATCHET_SCHEMA,
    messages: {
      sleep: `Fixed pause: {{timer}} with a {{delay}} delay inside a Promise. ${INSTEAD}`,
      promisesTimer: `Fixed pause: {{timer}} from {{source}}. ${INSTEAD}`,
      shrinkAllowlist: SHRINK_MESSAGE,
    },
  },
  create(context) {
    const ratchet = createRatchet(context, 'no-fixed-sleep')
    const source = context.sourceCode
    return {
      CallExpression(node) {
        const timer = timerName(node.callee)
        if (!timer || isZeroDelay(node.arguments[1])) return
        if (!insidePromiseExecutor(node)) return
        ratchet.add({
          node,
          messageId: 'sleep',
          data: { timer, delay: source.getText(node.arguments[1]) },
        })
      },
      ImportDeclaration(node) {
        const from = node.source.value
        if (from !== 'timers/promises' && from !== 'node:timers/promises') return
        for (const spec of node.specifiers) {
          if (spec.type !== 'ImportSpecifier') continue
          const name = spec.imported.type === 'Identifier' ? spec.imported.name : ''
          if (!TIMERS.has(name)) continue
          ratchet.add({
            node: spec,
            messageId: 'promisesTimer',
            data: { timer: name, source: from },
          })
        }
      },
      'Program:exit': () => ratchet.exit(),
    }
  },
}
