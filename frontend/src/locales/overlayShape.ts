// =============================================================================
// VELO Frontend -- the shape of an instance overlay (FE-133)
// =============================================================================
// An overlay from a partner's `texts` package is untrusted data. validate-texts
// refuses a package whose shape differs from the base catalogs, but the
// runtime does not lean on that check (the file may be mounted unchecked, or
// the base may have changed since): mergeLocaleMessage replaces a whole group
// by a lone string, and a group where the base has a message breaks it, so
// every node of the overlay is checked against the catalog it lands on.
// =============================================================================

/** Messages nest this deep at most; a deeper overlay node is dropped. */
export const MAX_OVERLAY_DEPTH = 8

/** Keys an overlay never sets: object plumbing, and the brand (a skin property). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type Kind = 'group' | 'array' | 'message'

function hasOwn(node: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(node, key)
}

/**
 * Whether a node of the BASE catalog is a message the build's plugin already
 * compiled into a syntax tree (`{ t: 0, b: ... }`, the JIT form of the
 * bundle): an object, yet a message. The same test as vue-i18n's own
 * `isMessageAST`: own keys only, and a set `t` wins over `type`.
 */
function isCompiledMessage(node: object): boolean {
  const { t, type } = node as { t?: unknown; type?: unknown }
  const nodeType = hasOwn(node, 't') && t != null ? t : hasOwn(node, 'type') ? type : undefined
  return nodeType === 0 && (hasOwn(node, 'b') || hasOwn(node, 'body'))
}

/**
 * The kind of a node. A compiled message exists only in the base: the same
 * object inside an OVERLAY is untrusted data, not a message. It stays a
 * group, so the depth and key checks cut it like any other group.
 */
function kindOf(value: unknown, isBase = false): Kind {
  if (Array.isArray(value)) return 'array'
  if (value !== null && typeof value === 'object') {
    return isBase && isCompiledMessage(value) ? 'message' : 'group'
  }
  return 'message'
}

/**
 * The part of `overlay` that fits `base`: same kind at every node, arrays of
 * the same length, no forbidden key, nothing deeper than MAX_OVERLAY_DEPTH. A
 * key the base does not have passes (a dead key is harmless; the validator
 * warns). The root `brand` key is dropped: the brand comes from the skin.
 */
export function conformOverlay(
  overlay: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  return conformGroup(overlay, base, 0)
}

function conformGroup(
  overlay: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (depth >= MAX_OVERLAY_DEPTH) return out
  for (const [key, value] of Object.entries(overlay)) {
    if (FORBIDDEN_KEYS.has(key) || (depth === 0 && key === 'brand')) continue
    const known = base && hasOwn(base, key) ? base[key] : undefined
    const kept = conformNode(value, known, depth + 1)
    if (kept !== undefined) out[key] = kept
  }
  return out
}

function conformNode(value: unknown, known: unknown, depth: number): unknown {
  const kind = kindOf(value)
  if (known !== undefined && kindOf(known, true) !== kind) return undefined
  if (kind === 'group')
    return conformGroup(
      value as Record<string, unknown>,
      known as Record<string, unknown> | undefined,
      depth,
    )
  if (kind === 'array') {
    const list = value as unknown[]
    if (known !== undefined && (known as unknown[]).length !== list.length) return undefined
    return list.every((item) => kindOf(item) === 'message') ? list : undefined
  }
  return value
}
