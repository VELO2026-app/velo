// FE-232: request headers and fetch() live in src/api/ only.
// The CORS guard of the backend (backend/tests/test_cors_frontend_headers.py)
// reads src/api/** and nothing else. A header set in a store, a composable or
// a component passes that guard unseen and then fails the browser's preflight.
// Caught outside src/api/ (the config scopes the rule, tests excluded):
//   - a call of fetch(), also window.fetch / globalThis.fetch / self.fetch;
//   - `api.post(path, body, headers)` -- a third argument;
//   - `api.request(method, path, options)` whose options is not an object
//     literal, or has a spread, a computed key or a `headers` key.
// A write with an Idempotency-Key goes through postIdempotent (api/idempotent.ts).
//
// Known gaps (syntax only, no data flow): `api` under another name or passed
// around as a value; `const { post } = api`; XMLHttpRequest, `new Request`,
// navigator.sendBeacon.

const FETCH_HOSTS = new Set(['window', 'globalThis', 'self', 'global'])

/** Whether `name` is declared in a scope of the file (a parameter, a local). */
function isDeclared(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(name)
    if (v && v.defs.length > 0) return true
  }
  return false
}

/** The global `fetch` or `<host>.fetch` -- not a local that happens to be named so. */
function isFetch(callee, scope) {
  if (callee.type === 'Identifier') return callee.name === 'fetch' && !isDeclared(scope, 'fetch')
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    FETCH_HOSTS.has(callee.object.name) &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'fetch'
  )
}

/** Whether the options argument may carry headers. */
function mayCarryHeaders(arg) {
  if (!arg) return false
  if (arg.type !== 'ObjectExpression') return true
  return arg.properties.some(
    (p) =>
      p.type !== 'Property' ||
      p.computed ||
      (p.key.type === 'Identifier' ? p.key.name : p.key.value) === 'headers',
  )
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      fetch: 'fetch() belongs in src/api/ (FE-232): add a function there and call it.',
      postHeaders:
        'Headers on api.post belong in src/api/ (FE-232): wrap the call in a function there.',
      requestHeaders:
        'Headers in api.request options belong in src/api/ (FE-232): wrap the call in a function there.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (isFetch(callee, context.sourceCode.getScope(node))) {
          context.report({ node, messageId: 'fetch' })
          return
        }
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.object.type !== 'Identifier' ||
          callee.object.name !== 'api' ||
          callee.property.type !== 'Identifier'
        ) {
          return
        }
        const method = callee.property.name
        if (method === 'post' && node.arguments.length >= 3) {
          context.report({ node, messageId: 'postHeaders' })
        } else if (method === 'request' && mayCarryHeaders(node.arguments[2])) {
          context.report({ node, messageId: 'requestHeaders' })
        }
      },
    }
  },
}
