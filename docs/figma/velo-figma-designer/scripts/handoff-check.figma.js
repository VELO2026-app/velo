/**
 * HANDOFF_CHECK: READ-ONLY check that a frame or a handoff section is ready
 * for the front-end agent (docs/figma-protocol.md, section "Требования к кадру").
 * Runs in the Figma plugin sandbox through figma-console `figma_execute`:
 *     <this file> + one line:  return await HANDOFF_CHECK('<nodeId>');
 * Never changes the file. Output stays small: counts per rule + first examples.
 *
 * Rules (H-xx). error = the front agent cannot take the frame without asking;
 * warn = fix if you can, or explain in the "Новое" note.
 *   H-01 error  section name `Handoff / <ISSUE-KEY> / <Title>`, pluginData f2c:issue set
 *   H-02 error  screen frame name `<Title> / <State> / 402`, width 402
 *   H-03 error  generic layer names (Frame 12, Group 3, Rectangle 84, Vector …)
 *   H-04 error  groups (allowed only as `Art / <name>` vector art)
 *   H-05 error  product text: font Marmelad, text style velo/fs-* (Inter only inside `Note`)
 *   H-06 error  solid fill/stroke without a variable (raw colour)
 *   H-07 warn   frame with 2+ children and no Auto Layout (not Background/TabBar/Overlay/Art/Badge)
 *   H-08 warn   gap/padding/radius > 0 without a variable
 *   H-09 error  hidden layers
 *   H-10 error  instance of a component that is not in the Kit (missing or remote/unknown main)
 *   H-11 error  raw values or unknown components without a `Новое` note frame in the section
 *   H-12 error  new icon: COMPONENT `icon/<name>`, square, one colour
 */
const HANDOFF_CHECK = async (nodeId, opts) => {
  const o = Object.assign({ limit: 6, width: 402, kitPages: /^(Фронт|front)/i }, opts || {});
  const root = await figma.getNodeByIdAsync(nodeId);
  if (!root) return { error: 'node not found: ' + nodeId };

  const GENERIC = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Text|Component|Instance|Union|Polygon|Star|Boolean|Subtract|Intersect|Exclude|Image|image|Slice) ?[\d ]*$/;
  const ABS_OK = /^(Background|TabBar|Overlay|Art \/|Badge|Dot|Note|Новое)/;
  const STATE_FRAME = /^.+ \/ .+ \/ \d+$/;
  const SECTION = /^Handoff \/ ([A-Z]+-\d+) \/ .+$/;
  const errors = {}, warns = {}, examples = {};
  const add = (bag, rule, node, extra) => {
    bag[rule] = (bag[rule] || 0) + 1;
    const arr = examples[rule] || (examples[rule] = []);
    if (arr.length < o.limit) arr.push(Object.assign({ id: node.id, name: node.name }, extra || {}));
  };
  const E = (r, n, x) => add(errors, r, n, x), W = (r, n, x) => add(warns, r, n, x);
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const stats = { frames: 0, screens: 0, texts: 0, instances: 0, nodes: 0 };
  const rawColors = {}, fonts = {}, mains = {};
  let rawValues = 0, unknownMains = 0;

  // ---- section-level checks ---------------------------------------------------
  const section = root.type === 'SECTION' ? root : null;
  let issue = null;
  if (section) {
    const m = SECTION.exec(section.name);
    issue = section.getPluginData('f2c:issue') || (m && m[1]) || null;
    if (!m) E('H-01', section, { want: 'Handoff / FE-123 / Title' });
    if (!section.getPluginData('f2c:issue')) W('H-01', section, { note: 'pluginData f2c:issue empty (the agent writes it)' });
  }
  const hasNote = !!(section || root).findOne && !!(section || root).findOne((n) => /^(Новое|Note \/ Новое)/.test(n.name));

  const inNote = (n) => { let p = n; while (p && p !== root) { if (/^(Note|Новое)/.test(p.name)) return true; p = p.parent; } return false; };
  const bound = (paint) => !!(paint.boundVariables && paint.boundVariables.color);

  async function visit(n, depth) {
    stats.nodes++;
    if (n.visible === false) { E('H-09', n); return; }
    const note = inNote(n);
    if (GENERIC.test(n.name) && !note) E('H-03', n, { type: n.type });
    if (n.type === 'GROUP' && !/^Art \//.test(n.name) && !note) E('H-04', n);
    if (n.type === 'FRAME' || n.type === 'COMPONENT') stats.frames++;
    if (n.type === 'FRAME' && n.parent === section) {
      if (!STATE_FRAME.test(n.name) && !/^(Новое|Note)/.test(n.name) && !/^icon\//.test(n.name)) E('H-02', n, { want: 'Title / State / 402' });
      if (STATE_FRAME.test(n.name)) { stats.screens++; if (Math.round(n.width) !== o.width) E('H-02', n, { width: n.width }); }
    }
    if (n.type === 'COMPONENT' && /^icon\//.test(n.name)) {
      const colors = new Set();
      n.findAll((c) => 'fills' in c).forEach((c) => [...(c.fills || []), ...(c.strokes || [])].forEach((p) => p.type === 'SOLID' && p.visible !== false && colors.add(hex(p.color))));
      if (Math.abs(n.width - n.height) > 0.5 || colors.size > 1) E('H-12', n, { w: n.width, h: n.height, colors: [...colors] });
      return; // icon art is checked as an icon, not as layout
    }
    if (/^Art \//.test(n.name)) return;
    if (!note) {
      for (const key of ['fills', 'strokes']) {
        const arr = n[key];
        if (!arr || arr === figma.mixed) continue;
        for (const p of arr) {
          if (p.visible === false || p.type !== 'SOLID') continue;
          if (!bound(p)) { const h = hex(p.color); rawColors[h] = (rawColors[h] || 0) + 1; rawValues++; E('H-06', n, { [key]: h }); }
        }
      }
      if (n.type === 'TEXT') {
        stats.texts++;
        const fam = n.fontName === figma.mixed ? 'mixed' : n.fontName.family;
        fonts[fam] = (fonts[fam] || 0) + 1;
        let style = null;
        if (n.textStyleId && n.textStyleId !== figma.mixed) { const s = await figma.getStyleByIdAsync(n.textStyleId); style = s && s.name; }
        if (fam !== 'Marmelad' || !style || !/^velo\/fs-/.test(style)) E('H-05', n, { font: fam, style });
      }
      if ('layoutMode' in n && n.type !== 'INSTANCE') {
        if (n.layoutMode === 'NONE' && n.children && n.children.length >= 2 && !ABS_OK.test(n.name) && !STATE_FRAME.test(n.name) && n !== section) W('H-07', n, { children: n.children.length });
        const bv = n.boundVariables || {};
        if (n.layoutMode !== 'NONE') {
          const spacing = [['itemSpacing', n.itemSpacing], ['paddingTop', n.paddingTop], ['paddingLeft', n.paddingLeft]];
          for (const [f, v] of spacing) if (v > 0 && !bv[f]) { W('H-08', n, { [f]: v }); rawValues++; break; }
        }
        if (typeof n.cornerRadius === 'number' && n.cornerRadius > 0 && !bv.topLeftRadius && !bv.cornerRadius) { W('H-08', n, { radius: n.cornerRadius }); rawValues++; }
      }
    }
    if (n.type === 'INSTANCE') {
      stats.instances++;
      let mc = null; try { mc = await n.getMainComponentAsync(); } catch (e) { /* missing library */ }
      let page = null; let p = mc && mc.parent; while (p && p.type !== 'PAGE') p = p.parent; page = p && p.name;
      const name = mc ? ((mc.parent && mc.parent.type === 'COMPONENT_SET') ? mc.parent.name : mc.name) : '?';
      mains[name] = (mains[name] || 0) + 1;
      if (!mc || mc.remote || !page || !o.kitPages.test(page)) { unknownMains++; E('H-10', n, { component: name, page }); }
      return; // instance internals belong to the master
    }
    if ('children' in n) for (const c of n.children) await visit(c, depth + 1);
  }
  if (root.type === 'SECTION') for (const c of root.children) await visit(c, 1);
  else await visit(root, 0);
  if ((rawValues > 0 || unknownMains > 0) && !hasNote) E('H-11', section || root, { rawValues, unknownMains });

  const nErr = Object.values(errors).reduce((a, b) => a + b, 0);
  return {
    node: { id: root.id, name: root.name, type: root.type, issue },
    ready: nErr === 0,
    errors, warnings: warns, stats,
    fonts, rawColors, components: mains, hasNote,
    examples,
  };
};
