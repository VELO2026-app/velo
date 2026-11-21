/**
 * COMPARE_FRAMES: READ-ONLY "what changed" between a design frame and the
 * screen on the «Фронт» page (or any two frames). figma-console `figma_execute`:
 *     <this file> + one line:  return await COMPARE_FRAMES('<design id>', '<front id>');
 * Never changes the file. Compares content, not pixels:
 *   size, texts (added / removed), kit components used (counts), variables used,
 *   raw colours, fonts, top-level blocks of `Content` (order and names).
 * Pixels: take two figma_take_screenshot PNGs (same scale) and look at them side by side.
 * `frontSheet.intact` (protocol §9.7): false = the «Фронт» sheet was changed after its capture
 * (by hand or by a kit update): say so instead of comparing with it as the code.
 */
/**
 * Structure fingerprint of a «Фронт» sheet, version 2 (protocol §9.7). The front agent writes it
 * (docs/figma/front/front-lib.figma.js); this copy only checks it. KEEP IDENTICAL to c2fSeal there
 * (frontend/scripts/lib/front-lib-figma.test.mjs compares the two).
 */
function c2fSeal(root) {
  let h = 0x811c9dc5; let n = 0;
  const add = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } };
  const hex = (c) => [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const paint = (p) => {
    if (p.type === 'IMAGE') return 'img:' + p.imageHash + ':' + p.scaleMode;
    if (p.type !== 'SOLID') return p.type;
    if (p.boundVariables && p.boundVariables.color) return 'v:' + p.boundVariables.color.id;
    return hex(p.color) + '/' + (p.opacity === undefined ? 1 : Math.round(p.opacity * 1000) / 1000);
  };
  const paints = (arr) => (arr === figma.mixed ? 'mixed' : (arr || []).filter((p) => p.visible !== false).map(paint).join(','));
  const effects = (arr) => (arr === figma.mixed ? 'mixed' : (arr || []).filter((e) => e.visible !== false).map((e) => e.type + ':' + Math.round(e.radius || 0)).join(','));
  const font = (x) => (x.type !== 'TEXT' ? '' : x.fontName === figma.mixed ? 'mixed' : x.fontName.family + ' ' + x.fontName.style + ' ' + (x.fontSize === figma.mixed ? 'mixed' : x.fontSize));
  const walk = (x, depth) => {
    n++;
    const geo = depth === 0 ? [0, 0] : [Math.round(x.x || 0), Math.round(x.y || 0)];
    let text = x.type === 'TEXT' ? x.characters : '';
    if (x.type === 'INSTANCE') text = x.findAll((t) => t.type === 'TEXT').map((t) => t.characters).join('\u0001');
    add([depth, x.type, x.name, x.visible === false ? 0 : 1, x.opacity === undefined ? 1 : Math.round(x.opacity * 100),
      Math.round(x.width || 0), Math.round(x.height || 0), geo[0], geo[1],
      'fills' in x ? paints(x.fills) : '', 'strokes' in x ? paints(x.strokes) + '@' + (x.strokeWeight === figma.mixed ? 'mixed' : x.strokeWeight || 0) : '',
      'effects' in x ? effects(x.effects) : '', font(x), text].join('|') + '\n');
    if (x.type !== 'INSTANCE' && 'children' in x) for (const c of x.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return 'v2:' + n + ':' + h.toString(16).padStart(8, '0');
}

const COMPARE_FRAMES = async (aId, bId, opts) => {
  const o = Object.assign({ limit: 40 }, opts || {});
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const varName = {};
  async function vname(id) {
    if (varName[id] !== undefined) return varName[id];
    try { const v = await figma.variables.getVariableByIdAsync(id); varName[id] = v ? v.name : id; } catch (e) { varName[id] = id; }
    return varName[id];
  }
  async function summary(id) {
    const root = await figma.getNodeByIdAsync(id);
    if (!root) return { error: 'not found ' + id };
    const s = { id, name: root.name, w: Math.round(root.width), h: Math.round(root.height), texts: [], comps: {}, vars: new Set(), raw: new Set(), fonts: new Set(), blocks: [] };
    const content = root.findOne && root.findOne((n) => n.name === 'Content');
    if (content && content.children) s.blocks = content.children.map((c) => c.name);
    else if (root.children) s.blocks = root.children.map((c) => c.name);
    async function walk(n) {
      if (n.visible === false) return;
      if (n.type === 'TEXT') { s.texts.push(n.characters.trim().replace(/\s+/g, ' ').slice(0, 80)); if (n.fontName !== figma.mixed) s.fonts.add(n.fontName.family); }
      for (const key of ['fills', 'strokes']) {
        const arr = n[key]; if (!arr || arr === figma.mixed) continue;
        for (const p of arr) { if (p.visible === false || p.type !== 'SOLID') continue; if (p.boundVariables && p.boundVariables.color) s.vars.add(await vname(p.boundVariables.color.id)); else s.raw.add(hex(p.color)); }
      }
      if (n.type === 'INSTANCE') {
        let mc = null; try { mc = await n.getMainComponentAsync(); } catch (e) { /* missing */ }
        const name = mc ? ((mc.parent && mc.parent.type === 'COMPONENT_SET') ? mc.parent.name : mc.name) : '?';
        s.comps[name] = (s.comps[name] || 0) + 1;
        return;
      }
      if ('children' in n) for (const c of n.children) await walk(c);
    }
    await walk(root);
    return s;
  }
  async function frontSheet(id) {
    // the sheet section that holds the seal: the node itself or its nearest ancestor with c2f:seal
    let s = await figma.getNodeByIdAsync(id);
    while (s && s.type !== 'PAGE' && !s.getPluginData('c2f:seal')) s = s.parent;
    if (!s || s.type === 'PAGE') return { seal: null, intact: null, commit: null, captured: null };
    const seal = s.getPluginData('c2f:seal');
    return { id: s.id, name: s.name, seal, intact: seal === c2fSeal(s), commit: s.getPluginData('c2f:commit') || null, captured: s.getPluginData('c2f:captured') || null };
  }
  const A = await summary(aId), B = await summary(bId);
  if (A.error || B.error) return { error: A.error || B.error };
  const minus = (x, y) => [...x].filter((v) => !y.has(v));
  const tA = new Set(A.texts), tB = new Set(B.texts);
  const comps = {};
  for (const k of new Set([...Object.keys(A.comps), ...Object.keys(B.comps)])) if ((A.comps[k] || 0) !== (B.comps[k] || 0)) comps[k] = { design: A.comps[k] || 0, front: B.comps[k] || 0 };
  return {
    design: { id: A.id, name: A.name, size: A.w + '×' + A.h }, front: { id: B.id, name: B.name, size: B.w + '×' + B.h },
    sameWidth: A.w === B.w,
    blocks: { design: A.blocks, front: B.blocks },
    textsAdded: minus(tA, tB).slice(0, o.limit), textsRemoved: minus(tB, tA).slice(0, o.limit),
    componentsChanged: comps,
    variablesAdded: minus(A.vars, B.vars), variablesRemoved: minus(B.vars, A.vars),
    rawColorsInDesign: [...A.raw], fontsInDesign: [...A.fonts],
    frontSheet: await frontSheet(bId), // intact false = changed after the capture; null = no seal yet
  };
};
