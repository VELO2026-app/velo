/**
 * HANDOFF_CHECK: READ-ONLY check that a frame or a handoff section is ready
 * for the front-end agent (docs/figma-protocol.md §5). Runs in the Figma plugin
 * sandbox through figma-console `figma_execute`:
 *     <this file> + one line:  return await HANDOFF_CHECK('<nodeId>');
 * Root = a `Handoff / …` SECTION (full check, after the move) or one screen frame
 * (before the move: H-01 is skipped, the `Новое` note is looked up in the frame
 * AND in its parent section). Never changes the file.
 *
 * Rules (H-xx). error = the front agent cannot take the frame without asking;
 * warn = fix if you can, or explain in the `Новое` note.
 *   H-01 error  section name `Handoff / <ISSUE-KEY> / <Title>` (section root only)
 *   H-02 error  screen frame name `<Title> / <State> / 402`, width 402
 *   H-03 error  generic layer names (Frame 12, Group 3, Rectangle 84, Vector …)
 *   H-04 error  groups (allowed only as `Art / <name>` vector art)
 *   H-05 error  product text: font Marmelad, text style velo/fs-*
 *   H-06 error  solid fill/stroke without a variable; WARN only when the hex is on a
 *               `Новое` note line that links a token request FE-NNN whose status is
 *               approved or done (opts.tokenRequests, protocol §10)
 *   H-07 warn   frame with 2+ children and no Auto Layout (except the layers in ABS_OK)
 *   H-08 error  gap / padding (any side) / radius > 0 without a variable; WARN under
 *               the same approved-request rule as H-06
 *   H-09 error  hidden layers
 *   H-10 error  instance of a component that is not in the Kit (missing or remote/unknown main)
 *   H-11 error  raw values or unknown components without a `Новое` note
 *   H-12 error  new icon: COMPONENT `icon/<name>`, square, one colour
 *
 * opts.tokenRequests = { 'FE-231': 'approved' | 'done' | 'pending' | 'canceled' } — the status of
 * each token request (Linear FE issue, label `token`). The sandbox cannot reach Linear, so the
 * assistant reads the statuses and passes them in. A request that is missing from the map counts
 * as unknown, so it does NOT approve anything. Todo / In Progress / In Review, or an «одобрено»
 * comment from the owner = 'approved'; Done = 'done'; Backlog = 'pending'.
 * Layers inside the note (`Новое`, `Note …`) are not checked.
 */
const HANDOFF_CHECK = async (nodeId, opts) => {
  const o = Object.assign({ limit: 6, width: 402, kitPages: /^(Фронт|front)/i, tokenRequests: {} }, opts || {});
  const root = await figma.getNodeByIdAsync(nodeId);
  if (!root) return { error: 'node not found: ' + nodeId };

  const GENERIC = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Text|Component|Instance|Union|Polygon|Star|Boolean|Subtract|Intersect|Exclude|Image|image|Slice) ?[\d ]*$/;
  // the same list as protocol §5 H-07
  const ABS_OK = /^(Background|TabBar|Overlay|Art \/|Badge|Dot|Note|Новое)/;
  const NOTE = /^(Новое|Note)/;
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

  // ---- where we are: section root, or a frame (maybe inside a section) ------------
  const section = root.type === 'SECTION' ? root : (root.parent && root.parent.type === 'SECTION' ? root.parent : null);
  const sectionRoot = root.type === 'SECTION';
  let issue = null;
  if (section) {
    const m = SECTION.exec(section.name);
    issue = section.getPluginData('f2c:issue') || (m && m[1]) || null;
    if (sectionRoot && !m) E('H-01', section, { want: 'Handoff / FE-123 / Title' });
    if (sectionRoot && !section.getPluginData('f2c:issue')) W('H-01', section, { note: 'pluginData f2c:issue empty (DESIGNER.toHandoff writes it)' });
  }

  // ---- the `Новое` note: in the root, or in the parent section ------------------------
  const noteNodes = [];
  for (const scope of [root, section]) {
    if (!scope || !scope.findAll) continue;
    for (const n of scope.findAll((x) => NOTE.test(x.name))) if (!noteNodes.includes(n)) noteNodes.push(n);
  }
  const hasNote = noteNodes.length > 0;
  // A raw value is approved only by a token request: a note line with `FE-NNN` whose status
  // (opts.tokenRequests) is approved or done. «одобрено» text in the note approves nothing.
  const OK_STATUS = /^(approved|done)$/;
  const approvedHex = new Set(), approvedPx = new Set(), requests = {};
  for (const note of noteNodes) {
    const texts = note.type === 'TEXT' ? [note] : note.findAll((x) => x.type === 'TEXT');
    for (const t of texts) for (const line of t.characters.split('\n')) {
      if (/^\s*Задача\s*:/i.test(line)) continue; // the screen's own task, not a token request
      const keys = line.match(/\b[A-Z]+-\d+\b/g) || [];
      if (!keys.length) continue;
      const hexes = (line.match(/#[0-9a-fA-F]{6}\b/g) || []).map((h) => h.toLowerCase());
      const pxs = (line.match(/\b\d+(\.\d+)?\s*px\b/g) || []).map(parseFloat);
      if (!hexes.length && !pxs.length) continue;
      const states = keys.map((k) => o.tokenRequests[k] || 'unknown');
      for (const k of keys) requests[k] = o.tokenRequests[k] || 'unknown';
      if (!states.some((st) => OK_STATUS.test(st))) continue;
      hexes.forEach((h) => approvedHex.add(h));
      pxs.forEach((p) => approvedPx.add(p));
    }
  }

  const inNote = (n) => { let p = n; while (p) { if (NOTE.test(p.name)) return true; if (p === root) break; p = p.parent; } return false; };
  const bound = (paint) => !!(paint.boundVariables && paint.boundVariables.color);

  function checkScreenFrame(n) {
    if (!STATE_FRAME.test(n.name)) { E('H-02', n, { want: 'Title / State / 402' }); return; }
    stats.screens++;
    if (Math.round(n.width) !== o.width) E('H-02', n, { width: n.width });
  }

  async function visit(n, depth) {
    stats.nodes++;
    if (n.visible === false) { E('H-09', n); return; }
    if (inNote(n)) return;
    if (GENERIC.test(n.name)) E('H-03', n, { type: n.type });
    if (n.type === 'GROUP' && !/^Art \//.test(n.name)) E('H-04', n);
    if (n.type === 'FRAME' || n.type === 'COMPONENT') stats.frames++;
    // a screen frame = the root frame itself, or a frame directly in the section root
    if (n.type === 'FRAME' && ((n === root && !sectionRoot) || (sectionRoot && n.parent === root))) checkScreenFrame(n);
    if (n.type === 'COMPONENT' && /^icon\//.test(n.name)) {
      const colors = new Set();
      n.findAll((c) => 'fills' in c).forEach((c) => [...(c.fills || []), ...(c.strokes || [])].forEach((p) => p.type === 'SOLID' && p.visible !== false && colors.add(hex(p.color))));
      if (Math.abs(n.width - n.height) > 0.5 || colors.size > 1) E('H-12', n, { w: n.width, h: n.height, colors: [...colors] });
      return; // icon art is checked as an icon, not as layout
    }
    if (/^Art \//.test(n.name)) return;
    for (const key of ['fills', 'strokes']) {
      const arr = n[key];
      if (!arr || arr === figma.mixed) continue;
      for (const p of arr) {
        if (p.visible === false || p.type !== 'SOLID' || bound(p)) continue;
        const h = hex(p.color);
        rawColors[h] = (rawColors[h] || 0) + 1; rawValues++;
        if (approvedHex.has(h)) W('H-06', n, { [key]: h, approved: true });
        else E('H-06', n, { [key]: h });
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
      if (n.layoutMode === 'NONE' && n.children && n.children.length >= 2 && !ABS_OK.test(n.name) && !STATE_FRAME.test(n.name)) W('H-07', n, { children: n.children.length });
      const bv = n.boundVariables || {};
      const raw = (f, v) => {
        rawValues++;
        if (approvedPx.has(v)) W('H-08', n, { [f]: v, approved: true });
        else E('H-08', n, { [f]: v });
      };
      if (n.layoutMode !== 'NONE') {
        for (const f of ['itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
          if (n[f] > 0 && !bv[f]) { raw(f, n[f]); break; }
        }
      }
      if (typeof n.cornerRadius === 'number' && n.cornerRadius > 0 && !bv.topLeftRadius && !bv.cornerRadius) raw('radius', n.cornerRadius);
    }
    if (n.type === 'INSTANCE') {
      stats.instances++;
      let mc = null; try { mc = await n.getMainComponentAsync(); } catch (e) { /* missing library */ }
      let p = mc && mc.parent; while (p && p.type !== 'PAGE') p = p.parent;
      const page = p && p.name;
      const name = mc ? ((mc.parent && mc.parent.type === 'COMPONENT_SET') ? mc.parent.name : mc.name) : '?';
      mains[name] = (mains[name] || 0) + 1;
      if (!mc || mc.remote || !page || !o.kitPages.test(page)) { unknownMains++; E('H-10', n, { component: name, page }); }
      return; // instance internals belong to the master
    }
    if ('children' in n) for (const c of n.children) await visit(c, depth + 1);
  }
  if (sectionRoot) for (const c of root.children) await visit(c, 1);
  else await visit(root, 0);
  if ((rawValues > 0 || unknownMains > 0) && !hasNote) E('H-11', section || root, { rawValues, unknownMains });

  const nErr = Object.values(errors).reduce((a, b) => a + b, 0);
  return {
    node: { id: root.id, name: root.name, type: root.type, issue, section: section && section.id },
    ready: nErr === 0,
    errors, warnings: warns, stats,
    fonts, rawColors, components: mains, hasNote,
    approvedByRequest: { colors: [...approvedHex], px: [...approvedPx] },
    tokenRequests: requests,
    examples,
  };
};
