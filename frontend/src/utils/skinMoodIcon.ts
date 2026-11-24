// =============================================================================
// VELO Frontend -- the skin's mood icon, drawn from its tree (FE-273)
// =============================================================================
//
// A skin package may carry the five mood icons (assets/mood/<key>.svg, contract
// 2.3). The build parses each file into a tree of a closed SVG vocabulary
// (scripts/lib/skin-package.mjs parseMoodSvg: elements and attributes from a
// list, nothing else survives) and serves the trees as virtual:skin-mood.
// This module turns one tree into a Vue component with the same `size` prop
// as the core faces (components/icons/IconMoodScale*.vue), so every place
// that reads utils/ratingIcons.ts draws either without knowing which.
//
// WHY INLINE and not <img src>: an image does not inherit the page's colors,
// so `currentColor` in the file would turn out black. Drawn inline, the lines
// take `color` of the root <svg>: the token --velo-primary-dark, the same ink
// the core faces draw their lines with.
//
// The icon's viewBox is its NOMINAL box: the art may run outside it (the
// Goodo glow does, by 37 %), so from GLOW_CLIP_BELOW px up the root is
// `overflow: visible` and a mood card laid out for `size` px holds the same
// box as with a core face. Below it the places are rows of text and pills,
// where that overflow runs into the digits and words next to the icon: the art
// is held to a disc of the icon's box, the footprint of a core face.
// =============================================================================

import { defineComponent, h, useId, type Component, type VNode } from 'vue'
import type { MoodSvgNode } from '../../scripts/lib/skin-package.mjs'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/** The ink of the lines: `currentColor` in the file resolves to this. */
const INK = 'var(--velo-primary-dark)'

/** Below this size (px) the art is held to a disc of the icon's box. The
 *  smallest places (badges 14 and 16, rows 22) sit beside text; a card, an
 *  avatar or the slider (36 and up) have room for the glow. */
const GLOW_CLIP_BELOW = 24

/** Attribute values that point at an element of the file: `url(#id)`. */
const URL_REF = /url\(#([^)]+)\)/g

/**
 * Draws one node of a tree. Ids and the references to them get a per-instance
 * suffix, so two icons on a screen never share a gradient (the file's ids
 * are only unique inside the file; the same trick the core faces play with
 * `useId()`).
 *
 * @param node - The tree node.
 * @param uid - The instance suffix.
 * @param extra - Props of this node over the file's (the root: size, style).
 */
function drawNode(node: MoodSvgNode, uid: string, extra: Record<string, unknown> = {}): VNode {
  const attrs: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    attrs[name] =
      name === 'id' ? `${value}-${uid}` : value.replace(URL_REF, (_, id) => `url(#${id}-${uid})`)
  }
  return h(
    node.tag,
    { ...attrs, ...extra },
    (node.children ?? []).map((child) => drawNode(child, uid)),
  )
}

/**
 * The component of one mood icon of the skin.
 *
 * @param tree - A parsed icon: the root `svg` node (virtual:skin-mood).
 */
export function createSkinMoodIcon(tree: MoodSvgNode): Component {
  return defineComponent({
    name: 'SkinMoodIcon',
    props: { size: { type: [Number, String], default: 40 } },
    setup(props) {
      const uid = useId()
      return () => {
        const small = Number(props.size) < GLOW_CLIP_BELOW
        return drawNode(tree, uid, {
          xmlns: SVG_NAMESPACE,
          width: props.size,
          height: props.size,
          style: small
            ? { overflow: 'hidden', clipPath: 'circle(50%)', color: INK }
            : { overflow: 'visible', color: INK },
        })
      }
    },
  })
}
