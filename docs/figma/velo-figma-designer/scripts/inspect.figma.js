/**
 * F2C_INSPECT: READ-ONLY dump of one Figma node for Figma → code.
 * Runs inside Figma's plugin sandbox (figma-console `figma_execute`).
 *
 * Usage: pass this file's text followed by ONE extra line as `code`:
 *     return await F2C_INSPECT('3997:14106');
 *     return await F2C_INSPECT('3997:14106', { svg: true });      // + SVG markup (icons)
 *     return await F2C_INSPECT('1:2', { depth: 4, maxNodes: 300 });  // big screens: trim
 * Use timeout 30000 for screens.
 *
 * Never mutates the document: only reads properties, resolves variables and
 * calls exportAsync (an export does not change the file).
 *
 * Returns:
 *   root      id, name, type, size, page, section path, component/instance info
 *   kind      'icon' | 'illustration' | 'component' | 'screen' | 'frame' (a guess; the agent decides)
 *   tree      nodes with geometry relative to the root, layout, fills, strokes,
 *             radius, effects, text props; `vars` = bound variable names per field
 *   variables every bound variable once: name, collection, mode, value in the mode the root
 *             shows (resolvedVariableModes; else the explicit mode of the nearest node up the
 *             tree; else the collection default); since FE-234 the first mode of `velo` is core
 *   texts     every visible text: characters, font, size, line-height, style name
 *   instances every instance: main component name/key + component set + props
 *   colors    every raw (unbound) solid colour → count (hardcode suspects)
 *   svg       (opts.svg) exportAsync SVG_STRING, ids stripped, outlined text
 */
const F2C_INSPECT = async (nodeId, opts) => {
  const o = Object.assign({ depth: 8, maxNodes: 600, svg: false, svgMaxChars: 60000 }, opts || {});
  const root = await figma.getNodeByIdAsync(nodeId);
  if (!root) return { error: 'node not found: ' + nodeId + ' (wrong file connected? check figma_get_status)' };
  if (root.type === 'PAGE' || root.type === 'DOCUMENT') return { error: nodeId + ' is a ' + root.type + ': link a frame, not a page' };

  const r2 = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const RB = root.absoluteBoundingBox || { x: root.x, y: root.y };

  // ---- variables ---------------------------------------------------------------
  const varCache = {};
  const variables = {};
  // The mode the root shows: Figma's own answer (resolvedVariableModes: it also knows a mode an
  // instance takes from its main component); else the explicit mode of the nearest node up the
  // tree; else the collection default. Never the first mode by position.
  function modeShown(col) {
    const resolved = root.resolvedVariableModes && root.resolvedVariableModes[col.id];
    if (resolved) return resolved;
    for (let n = root; n; n = n.parent) {
      const m = n.explicitVariableModes && n.explicitVariableModes[col.id];
      if (m) return m;
    }
    return col.defaultModeId || col.modes[0].modeId;
  }
  async function varName(id) {
    if (!id) return null;
    if (varCache[id] !== undefined) return varCache[id];
    let name = null;
    try {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (v) {
        const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
        const shown = col ? modeShown(col) : null;
        const modeId = shown && shown in v.valuesByMode ? shown : Object.keys(v.valuesByMode)[0];
        let val = v.valuesByMode[modeId];
        // resolve one alias hop for the human-readable value
        if (val && val.type === 'VARIABLE_ALIAS') {
          const t = await figma.variables.getVariableByIdAsync(val.id);
          val = t ? '→ ' + t.name : val;
        }
        if (val && typeof val === 'object' && 'r' in val) val = hex(val) + (val.a !== undefined && val.a < 1 ? ' a=' + r2(val.a) : '');
        name = (col ? col.name + '/' : '') + v.name;
        const mode = col && col.modes.find((m) => m.modeId === modeId);
        variables[name] = { name: v.name, collection: col && col.name, mode: mode ? mode.name : null, type: v.resolvedType, value: val, remote: v.remote };
      }
    } catch (e) { name = 'unresolved:' + id; }
    varCache[id] = name;
    return name;
  }
  async function boundOf(node) {
    const bv = node.boundVariables || {};
    const out = {};
    for (const [field, ref] of Object.entries(bv)) {
      if (Array.isArray(ref)) {
        const names = [];
        for (const r of ref) names.push(await varName(r && r.id));
        if (names.some(Boolean)) out[field] = names.length === 1 ? names[0] : names;
      } else if (ref && ref.id) out[field] = await varName(ref.id);
    }
    return Object.keys(out).length ? out : undefined;
  }

  // ---- paints ------------------------------------------------------------------
  const rawColors = {};
  async function paints(arr, where) {
    if (!arr || arr === figma.mixed || !arr.length) return undefined;
    const res = [];
    for (const p of arr) {
      if (p.visible === false) continue;
      const v = p.boundVariables && p.boundVariables.color ? await varName(p.boundVariables.color.id) : null;
      if (p.type === 'SOLID') {
        const h = hex(p.color);
        if (!v) rawColors[h] = (rawColors[h] || 0) + 1;
        res.push(v ? { var: v, hex: h } : { hex: h, opacity: p.opacity !== 1 ? r2(p.opacity) : undefined });
      } else if (p.type === 'IMAGE') res.push({ image: p.imageHash, scaleMode: p.scaleMode });
      else res.push({ type: p.type, stops: (p.gradientStops || []).map((s) => hex(s.color) + '@' + r2(s.position)) });
    }
    return res.length ? res : undefined;
  }

  // ---- walk ----------------------------------------------------------------------
  const tree = [], texts = [], instances = [];
  let count = 0, truncated = false, vectors = 0, maxDepthSeen = 0;
  const styleName = async (id) => { if (!id || id === figma.mixed) return undefined; try { const s = await figma.getStyleByIdAsync(id); return s ? s.name : undefined; } catch (e) { return undefined; } };

  async function walk(n, d, path) {
    if (n.visible === false) return;
    if (count >= o.maxNodes) { truncated = true; return; }
    count++; maxDepthSeen = Math.max(maxDepthSeen, d);
    const bb = n.absoluteBoundingBox;
    const e = { id: n.id, d, name: n.name, type: n.type };
    if (bb) Object.assign(e, { x: r2(bb.x - RB.x), y: r2(bb.y - RB.y), w: r2(bb.width), h: r2(bb.height) });
    if (n.opacity !== undefined && n.opacity < 1) e.opacity = r2(n.opacity);
    if ('layoutMode' in n && n.layoutMode && n.layoutMode !== 'NONE') {
      e.layout = { mode: n.layoutMode, gap: n.itemSpacing, pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
        main: n.primaryAxisAlignItems, cross: n.counterAxisAlignItems, wrap: n.layoutWrap !== 'NO_WRAP' ? n.layoutWrap : undefined };
    }
    if ('layoutSizingHorizontal' in n && n.parent && n.parent.layoutMode && n.parent.layoutMode !== 'NONE') e.sizing = n.layoutSizingHorizontal + '/' + n.layoutSizingVertical;
    if ('cornerRadius' in n && n.cornerRadius) e.radius = n.cornerRadius === figma.mixed ? [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius] : n.cornerRadius;
    if ('fills' in n) e.fills = await paints(n.fills, n);
    if ('strokes' in n && n.strokes && n.strokes.length) { e.strokes = await paints(n.strokes, n); e.strokeWeight = n.strokeWeight === figma.mixed ? 'mixed' : n.strokeWeight; e.strokeAlign = n.strokeAlign; }
    if ('effects' in n && n.effects && n.effects.length) e.effects = n.effects.filter((x) => x.visible !== false).map((x) => ({ type: x.type, radius: x.radius, offset: x.offset, color: x.color && hex(x.color), a: x.color && r2(x.color.a), spread: x.spread }));
    const vars = await boundOf(n); if (vars) e.vars = vars;
    if (n.type === 'TEXT') {
      const t = { id: n.id, path, text: n.characters.slice(0, 400), font: n.fontName === figma.mixed ? 'mixed' : n.fontName.family + ' ' + n.fontName.style,
        size: n.fontSize === figma.mixed ? 'mixed' : n.fontSize, lineHeight: n.lineHeight === figma.mixed ? 'mixed' : (n.lineHeight.unit === 'AUTO' ? 'auto' : r2(n.lineHeight.value) + (n.lineHeight.unit === 'PERCENT' ? '%' : 'px')),
        letterSpacing: n.letterSpacing === figma.mixed ? 'mixed' : (n.letterSpacing.value ? r2(n.letterSpacing.value) + (n.letterSpacing.unit === 'PERCENT' ? '%' : 'px') : undefined),
        align: n.textAlignHorizontal, style: await styleName(n.textStyleId), autoResize: n.textAutoResize, truncate: n.textTruncation !== 'DISABLED' ? n.textTruncation : undefined };
      Object.assign(e, { text: t.text.slice(0, 80) });
      texts.push(t);
    }
    if (n.type === 'INSTANCE') {
      let mc = null; try { mc = await n.getMainComponentAsync(); } catch (err) { /* library missing */ }
      const set = mc && mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent : null;
      const inst = { id: n.id, path, name: n.name, component: mc ? mc.name : null, set: set ? set.name : null, key: mc ? mc.key : null, remote: mc ? mc.remote : null,
        props: n.componentProperties ? Object.fromEntries(Object.entries(n.componentProperties).map(([k, v]) => [k.replace(/#.*$/, ''), v.value])) : undefined };
      instances.push(inst);
      e.instanceOf = (set ? set.name + ' / ' : '') + (mc ? mc.name : '?');
    }
    if (/^(VECTOR|BOOLEAN_OPERATION|STAR|POLYGON|ELLIPSE|LINE)$/.test(n.type)) vectors++;
    tree.push(e);
    // instances are black boxes past their first level: their insides belong to the master
    if ('children' in n && d < o.depth && !(n.type === 'INSTANCE' && d > 0)) {
      for (const c of n.children) await walk(c, d + 1, path ? path + ' > ' + n.name : n.name);
    }
  }
  await walk(root, 0, '');

  // ---- root context ----------------------------------------------------------------
  const chain = []; let p = root.parent; let page = null;
  while (p) { if (p.type === 'PAGE') { page = p.name; break; } chain.unshift(p.type === 'SECTION' ? '§ ' + p.name : p.name); p = p.parent; }
  const info = { id: root.id, name: root.name, type: root.type, w: r2(root.width), h: r2(root.height), page, path: chain.join(' > ') };
  if (root.type === 'COMPONENT' || root.type === 'COMPONENT_SET') { info.key = root.key; info.description = root.description || undefined; }
  if (root.type === 'COMPONENT_SET') info.variants = root.children.map((c) => c.name);
  if (root.type === 'INSTANCE') { const mc = await root.getMainComponentAsync(); info.mainComponent = mc && mc.name; }

  const maxSide = Math.max(root.width, root.height);
  const hasText = texts.length > 0;
  const kind = maxSide <= 64 && !hasText ? 'icon'
    : (!hasText && vectors > 0 && tree.every((x) => x.type !== 'INSTANCE') && maxSide <= 600) ? 'illustration'
    : (root.type === 'COMPONENT' || root.type === 'COMPONENT_SET' || root.type === 'INSTANCE') ? 'component'
    : (root.width >= 360 && root.width <= 440 && root.height >= 600) ? 'screen' : 'frame';

  const out = { root: info, kind, counts: { nodes: count, vectors, texts: texts.length, instances: instances.length, depth: maxDepthSeen, truncated },
    variables, texts, instances, rawColors, tree };

  if (o.svg) {
    try {
      const s = await root.exportAsync({ format: 'SVG_STRING', svgIdAttribute: false, svgOutlineText: true, svgSimplifyStroke: true });
      out.svg = s.length > o.svgMaxChars ? s.slice(0, o.svgMaxChars) + '<!-- TRUNCATED ' + s.length + ' chars -->' : s;
      out.svgChars = s.length;
    } catch (e) { out.svgError = String(e); }
  }
  return out;
};
