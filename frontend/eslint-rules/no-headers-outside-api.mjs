// FE-232: request headers and fetch() live in src/api/ only.
// The CORS guard of the backend (backend/tests/test_cors_frontend_headers.py)
// reads src/api/** and nothing else. A header set in a store, a composable or
// a component passes that guard unseen and then fails the browser's preflight.
// Caught outside src/api/ (the config scopes the rule, tests excluded):
//   - fetch: any reference to the global `fetch`, called or not (`fetch()`,
//     `fetch.call(...)`, `const f = fetch`), and `fetch` on a global host --
//     `window`, `globalThis`, `self`, `global` -- in dot or literal-bracket
//     form (`window['fetch']`), called or not. A local named `fetch` (a
//     parameter, a variable) is not the global one;
//   - `api.post(path, body, headers)` -- a third argument;
//   - `api.request(method, path, options)` whose options is not an object
//     literal, or has a spread, a computed key or a `headers` key;
//   - a spread among the arguments of `api.post` / `api.request`
//     (`api.post(...args)`): the position of the headers is not visible;
//   - `api.post` / `api.request` used as a value, not called on the spot:
//     `const p = api.post`, `api.post.call(...)`, `.bind`, `.apply`,
//     `{ post } = api`, `api['post']` is read like `api.post`;
//   - `api` imported under another name, and the client imported as a
//     namespace (`import * as client from '@/api/client'`, `import('...')`):
//     `client.api.post(...)` would hide the call.
// A write with an Idempotency-Key goes through postIdempotent
// (api/idempotent.ts).
//
// Known gaps (syntax only, no data flow): `api` passed around as a whole
// value (`useClient(api)`), a computed key that is not a literal
// (`api[name](...)`), a re-export of the client from another module,
// XMLHttpRequest, `new Request`, navigator.sendBeacon.

const FETCH_HOSTS = new Set(['window', 'globalThis', 'self', 'global'])
const HEADER_METHODS = new Set(['post', 'request'])

/** Whether `name` is declared in a scope of the file (a parameter, a local). */
function isDeclared(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(name)
    if (v && v.defs.length > 0) return true
  }
  return false
}

/** The property name of a member: `.name` or a literal `['name']`; else null. */
function propertyName(member) {
  const p = member.property
  if (!member.computed) return p.type === 'Identifier' ? p.name : null
  return p.type === 'Literal' && typeof p.value === 'string' ? p.value : null
}

/** `api.<name>` as a member expression: the method name, else null. */
function apiMethod(node) {
  if (node.type !== 'MemberExpression') return null
  if (node.object.type !== 'Identifier' || node.object.name !== 'api') return null
  return propertyName(node)
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

/** Nodes whose `key` names a member without referring to a variable. */
const KEYED = new Set([
  'Property',
  'PropertyDefinition',
  'MethodDefinition',
  'AccessorProperty',
  'TSPropertySignature',
  'TSMethodSignature',
  'TSAbstractPropertyDefinition',
  'TSAbstractMethodDefinition',
  'TSEnumMember',
])

/** Whether the Identifier is a name, not a reference to the variable. */
function isNameOnly(node) {
  const parent = node.parent
  // `typeof fetch` in a type: a type, not a call channel.
  if (parent.type === 'TSTypeQuery') return true
  if (parent.type === 'MemberExpression') return parent.property === node && !parent.computed
  // A field `fetch` in an object, a class, an interface or a type literal.
  // A shorthand `{ fetch }` has the key and the value as two nodes of one
  // text: the value is the reference, the key is skipped (one report).
  if (parent.type === 'Property' && parent.shorthand) return parent.value !== node
  if (KEYED.has(parent.type)) return parent.key === node && !parent.computed
  return false
}

const CLIENT_MODULE = /(?:^|\/)api\/client(?:\.ts)?$/

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      fetch: 'fetch belongs in src/api/ (FE-232): add a function there and call it.',
      postHeaders:
        'Headers on api.post belong in src/api/ (FE-232): wrap the call in a function there.',
      requestHeaders:
        'Headers in api.request options belong in src/api/ (FE-232): wrap the call in a function there.',
      spread:
        'A spread in the arguments of api.post / api.request hides the headers (FE-232): pass them one by one, in src/api/.',
      alias:
        'api.post / api.request must be called on the spot (FE-232): an alias hides the headers from the CORS guard.',
      rename:
        'Import api under its own name (FE-232): the rules and the CORS guard look for `api`.',
      namespace:
        'Import `api` by name from the client (FE-232): a namespace import hides api.post / api.request.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    return {
      Identifier(node) {
        if (node.name !== 'fetch' || isNameOnly(node)) return
        if (isDeclared(sourceCode.getScope(node), 'fetch')) return
        context.report({ node, messageId: 'fetch' })
      },
      MemberExpression(node) {
        if (
          node.object.type === 'Identifier' &&
          FETCH_HOSTS.has(node.object.name) &&
          propertyName(node) === 'fetch'
        ) {
          context.report({ node, messageId: 'fetch' })
          return
        }
        const method = apiMethod(node)
        if (method === null || !HEADER_METHODS.has(method)) return
        const parent = node.parent
        if (parent.type === 'CallExpression' && parent.callee === node) return
        context.report({ node, messageId: 'alias' })
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || node.init?.type !== 'Identifier') return
        if (node.init.name !== 'api') return
        const takes = node.id.properties.some(
          (p) =>
            p.type === 'RestElement' ||
            (p.type === 'Property' &&
              ((!p.computed && p.key.type === 'Identifier' && HEADER_METHODS.has(p.key.name)) ||
                p.computed ||
                (p.key.type === 'Literal' && HEADER_METHODS.has(String(p.key.value))))),
        )
        if (takes) context.report({ node, messageId: 'alias' })
      },
      ImportDeclaration(node) {
        if (!CLIENT_MODULE.test(String(node.source.value))) return
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier') {
            context.report({ node: spec, messageId: 'namespace' })
          }
        }
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && CLIENT_MODULE.test(String(node.source.value))) {
          context.report({ node, messageId: 'namespace' })
        }
      },
      ImportSpecifier(node) {
        if (
          node.imported.type === 'Identifier' &&
          node.imported.name === 'api' &&
          node.local.name !== 'api'
        ) {
          context.report({ node, messageId: 'rename' })
        }
      },
      CallExpression(node) {
        const method = apiMethod(node.callee)
        if (method === null || !HEADER_METHODS.has(method)) return
        if (node.arguments.some((a) => a.type === 'SpreadElement')) {
          context.report({ node, messageId: 'spread' })
        } else if (method === 'post' && node.arguments.length >= 3) {
          context.report({ node, messageId: 'postHeaders' })
        } else if (method === 'request' && mayCarryHeaders(node.arguments[2])) {
          context.report({ node, messageId: 'requestHeaders' })
        }
      },
    }
  },
}
