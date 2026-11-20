/**
 * COMPARE_FRAMES: READ-ONLY "what changed" between a design frame and the
 * screen on the «Фронт» page (or any two frames). figma-console `figma_execute`:
 *     <this file> + one line:  return await COMPARE_FRAMES('<design id>', '<front id>');
 * Never changes the file. Compares content, not pixels:
 *   size, texts (added / removed), kit components used (counts), variables used,
 *   raw colours, fonts, top-level blocks of `Content` (order and names).
 * Pixels: take two figma_take_screenshot PNGs (same scale) and look at them side by side.
 */
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
    frontSeal: (await figma.getNodeByIdAsync(bId)).getPluginData('c2f:seal') || null,
    frontCommit: (await figma.getNodeByIdAsync(bId)).getPluginData('c2f:commit') || null,
  };
};
