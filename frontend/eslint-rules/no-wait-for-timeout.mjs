// FE-211: no fixed pauses in the Playwright suite (docs/testing.md, rule 10).
// `page.waitForTimeout(ms)` is Playwright's own sleep: it waits for nothing
// it names, so it is too short on a loaded runner and too long on a fast one
// (Playwright's docs: it "should only be used for debugging").
// Caught: any `<x>.waitForTimeout(...)` call -- a page, a frame, a fixture --
// whatever the argument, since the method has no other use. Runs on every
// e2e/ file, helpers included: unlike a timer in a Promise (no-fixed-sleep,
// which runs on the specs only), it has no legitimate harness use.
//
// Known gaps (syntax only, no data flow; not caught):
//   - a detached method (`const { waitForTimeout } = page`,
//     `const wait = page.waitForTimeout.bind(page)`);
//   - a computed name that is not a string literal (`page[name](500)`).
import { RATCHET_SCHEMA, SHRINK_MESSAGE, createRatchet } from './ratchet.mjs'

const METHOD = 'waitForTimeout'

/** Whether the callee is `<x>.waitForTimeout` or `<x>['waitForTimeout']`. */
function isWaitForTimeout(callee) {
  if (callee.type !== 'MemberExpression') return false
  const { property } = callee
  if (!callee.computed) return property.type === 'Identifier' && property.name === METHOD
  return property.type === 'Literal' && property.value === METHOD
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid waitForTimeout in the e2e suite (FE-211, docs/testing.md rule 10).',
    },
    schema: RATCHET_SCHEMA,
    messages: {
      pause:
        'Fixed pause: waitForTimeout. Wait for the thing itself: a web-first assertion ' +
        '(await expect(locator).toBeVisible()), page.waitForRequest / waitForResponse, ' +
        'settle() from e2e/support/settle.ts for a quiet API, or page.clock.install() + ' +
        'page.clock.runFor(ms) to fire the app timers.',
      shrinkAllowlist: SHRINK_MESSAGE,
    },
  },
  create(context) {
    const ratchet = createRatchet(context, 'no-wait-for-timeout')
    return {
      CallExpression(node) {
        if (isWaitForTimeout(node.callee)) ratchet.add({ node, messageId: 'pause' })
      },
      'Program:exit': () => ratchet.exit(),
    }
  },
}
