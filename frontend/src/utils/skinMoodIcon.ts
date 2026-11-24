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
// Goodo glow does), so the root is `overflow: visible` and a mood card laid
// out for `size` px holds the same box as with a core face.
// =============================================================================

import { defineComponent, h, useId, type Component, type VNode } from 'vue'
import type { MoodSvgNode } from '../../scripts/lib/skin-package.mjs'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/** The ink of the lines: `currentColor` in the file resolves to this. */
const INK = 'var(--velo-primary-dark)'

/** Attribute values that point at an element of the file: `url(#id)`. */
const URL_REF = /url\(#([^)]+)\)/g

/**
 * Draws one node of a tree. Ids and the references to them get a per-instance
 * suffix, so two icons on a screen never share a gradient (the file's ids
 * are only unique inside the file; the same trick the core faces play with
 * `useId()`).
 */
function drawNode(node: MoodSvgNode, uid: string): VNode {
  const attrs: Record<string, string> = {}
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    attrs[name] =
      name === 'id' ? `${value}-${uid}` : value.replace(URL_REF, (_, id) => `url(#${id}-${uid})`)
  }
  return h(
    node.tag,
    attrs,
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
        const root = drawNode(tree, uid)
        const { props: rootProps, children } = root
        return h(
          'svg',
          {
            ...rootProps,
            xmlns: SVG_NAMESPACE,
            width: props.size,
            height: props.size,
            style: { overflow: 'visible', color: INK },
          },
          children as VNode[],
        )
      }
    },
  })
}
