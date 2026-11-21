/* fss-lib.figma.js — FSS v1 builders (figma-standard.md §2-§4, §8, §9) for the VELO mirror pages.
 * The source of truth is this file in the repo (FE-224; it was the skill's scripts/figma-lib.js v4).
 *
 * Plain script, no export. Paste, in this order, into one `figma_execute`:
 *   docs/figma/front/front-lib.figma.js, then this file, then the call. Take both from the branch you
 *   work against: `git -C ~/work/velo show origin/deploy-machine:docs/figma/front/<file>`.
 *   const FSS = makeFSS();
 *   const FRONT = makeFront({ thread: '<bb thread id>', task: 'FE-NNN' });
 *   return await FRONT.write(['Фронт · Экраны'], 'resnap user.dashboard', async () => {
 *     await FSS.ensureTemplates();                // once per page, idempotent
 *     const r = await FSS.sheet({ key:'screen:user.dashboard', route:'user.dashboard', title:'Dashboard',
 *       source:'frontend/src/views/user/UserDashboardView.vue', states:[{ state:'Default', width:402, height:874 }],
 *       replace: '<id of the existing sheet>' });   // rebuild in place: same node id, same position
 *     return Object.assign(r, await FRONT.stamp(r.id, { commit: '<sha>', committedAt: '<git %cI>' }));
 *   });
 *
 * Every builder that changes the file throws outside FRONT.write and refuses a target OR a source
 * node (adopt, masterNode, body, masters) outside the locked pages. setMeta refuses the keys only
 * FRONT.stamp writes (commit, captured, committed, evidence, seal). Only a COMPLETED sheet() or
 * componentSheet() marks a sheet rebuilt (FRONT.stamp then needs no evidence); sheet({ replace })
 * checks the template, the variables and the text styles before it clears the old content. FRONT.write refuses to run when this
 * file is missing its version or is older than FSS_LIB_MIN in front-lib.figma.js.
 *
 * What it guarantees: idempotent (find-or-create by pluginData c2f:key), every builder
 * returns node ids, chrome text = Inter via doc/* styles, chrome fills/gaps/padding/radius
 * bound to doc/* and legacy space/* variables (no raw hex), required c2f metadata written.
 *
 * Needs in the file: collection `doc` (doc/sheet-bg, tile-bg, chrome-text, chrome-muted, divider
 * + FLOAT sheet-pad, state-gap, spec-gap, header-h, spec-w, tile-pad, tile-radius, tile-gap),
 * doc/row-bg COLOR, collection `legacy` (space/*, radius/full), velo radius/radius-12, text styles doc/title|section|caption|body (Inter).
 *
 * "Template / Screen Sheet" from the standard is this builder: a SECTION cannot be a component.
 * Real template components (created by ensureTemplates): `Template / Status Badge`,
 * `Template / Sheet Header`. Component tiles are built by tile()/componentSheet().
 *
 * figma-console quirk: a long call can die with "Connection replaced by same file reconnection"
 * when several figma-console-mcp servers run at once. Keep one server; split long builds.
 */

/** Numeric (yyyymmddnn): compared as a number, never as a string. */
const FSS_LIB_VERSION = 2026112101;

function makeFSS() {
  if (typeof FRONT_LIB_VERSION === 'undefined' || typeof FSS_LIB_MIN === 'undefined' || FSS_LIB_VERSION < FSS_LIB_MIN) {
    throw new Error('FSS: paste docs/figma/front/front-lib.figma.js (repo, origin/deploy-machine) before fss-lib.figma.js');
  }
  const NS = 'c2f:';
  const STATUSES = ['draft', 'built', 'verified', 'ready-for-dev', 'deprecated'];
  const DIFF_RE = /^(PASS|FAIL|LIMIT)( .+)?$/; // diff.py result; "unmeasured" is not a valid value
  let _v = null, _s = null;

  // ---- discovery --------------------------------------------------------------
  async function V(name, col = 'doc') {
    if (!_v) {
      _v = {};
      for (const v of await figma.variables.getLocalVariablesAsync()) {
        const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
        _v[c.name + ':' + v.name] = v;
      }
    }
    const v = _v[col + ':' + name];
    if (!v) throw new Error('FSS: variable not found ' + col + ':' + name);
    return v;
  }
  async function S(name) {
    if (!_s) _s = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s]));
    if (!_s[name]) throw new Error('FSS: text style not found ' + name);
    return _s[name];
  }
  async function num(name) { const v = await V(name); return v.valuesByMode[Object.keys(v.valuesByMode)[0]]; }

  // ---- metadata (§8) ------------------------------------------------------------
  function setMeta(node, meta) {
    c2fNeedGuard(node);
    for (const k of Object.keys(meta)) if (C2F_RESERVED.includes(k)) throw new Error('FSS: c2f:' + k + ' is written only by FRONT.stamp');
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined || v === null) continue;
      if (k === 'status' && !STATUSES.includes(v)) throw new Error('FSS: bad status ' + v);
      if (k === 'diff' && !DIFF_RE.test(v)) throw new Error('FSS: diff must be PASS|FAIL|LIMIT[ detail], got ' + v);
      node.setPluginData(NS + k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    return node;
  }
  function findByKey(key, root = figma.currentPage) { return root.findOne((n) => n.getPluginData(NS + 'key') === key); }
  function missingMeta(node) { return ['source', 'state', 'viewport', 'diff', 'status'].filter((k) => !node.getPluginData(NS + k)); }

  // ---- bound primitives -----------------------------------------------------------
  async function fillVar(node, name, col = 'doc') {
    node.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', await V(name, col))];
  }
  async function bind(node, field, name, col = 'doc') { node.setBoundVariable(field, await V(name, col)); }
  async function bindAll(node, fields, name, col = 'doc') { for (const f of fields) await bind(node, f, name, col); }
  const PAD = ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'];
  const RAD = ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'];

  async function text(parent, name, chars, style = 'doc/body', muted = false) {
    c2fNeedGuard(parent);
    const st = await S(style);
    await figma.loadFontAsync(st.fontName);
    const t = figma.createText();
    t.name = name; // role in lowercase (§5)
    await t.setTextStyleIdAsync(st.id);
    t.characters = String(chars);
    await fillVar(t, muted ? 'doc/chrome-muted' : 'doc/chrome-text');
    parent.appendChild(t);
    return t;
  }
  function autoFrame(name, dir = 'VERTICAL') {
    const f = figma.createFrame();
    f.name = name; f.fills = []; f.clipsContent = false;
    f.layoutMode = dir; f.primaryAxisSizingMode = 'AUTO'; f.counterAxisSizingMode = 'AUTO';
    return f;
  }
  function propKey(inst, prefix) { return Object.keys(inst.componentProperties).find((k) => k.startsWith(prefix + '#')); }

  // ---- template components (§10) ----------------------------------------------------
  async function ensureTemplates(page = figma.currentPage) {
    c2fNeedGuard(page);
    let sec = findByKey('templates', page);
    if (sec) return { existed: true, section: sec.id };
    let y = 0; for (const n of page.children) y = Math.max(y, n.y + n.height); y += 400;
    sec = figma.createSection(); sec.name = 'Templates'; sec.x = 0; sec.y = y;
    await fillVar(sec, 'doc/sheet-bg'); sec.strokes = []; setMeta(sec, { key: 'templates' });

    // Status Badge
    const badge = figma.createComponent(); badge.name = 'Template / Status Badge';
    badge.layoutMode = 'HORIZONTAL'; badge.primaryAxisSizingMode = 'AUTO'; badge.counterAxisSizingMode = 'AUTO'; badge.counterAxisAlignItems = 'CENTER';
    badge.fills = []; await bindAll(badge, ['paddingLeft', 'paddingRight'], 'space/3', 'legacy'); await bindAll(badge, ['paddingTop', 'paddingBottom'], 'space/1', 'legacy');
    await bindAll(badge, RAD, 'radius/full', 'legacy'); await fillVar(badge, 'doc/divider');
    const bt = await text(badge, 'status', 'draft', 'doc/caption');
    const kS = badge.addComponentProperty('Status', 'TEXT', 'draft'); bt.componentPropertyReferences = { characters: kS };
    sec.appendChild(badge); badge.x = 64; badge.y = 64; setMeta(badge, { key: 'template:status-badge' });
    badge.description = 'Code: n/a (sheet chrome)\nProps: Status = draft|built|verified|ready-for-dev|deprecated\nMap: figma-standard.md §10';

    // Sheet Header
    const head = figma.createComponent(); head.name = 'Template / Sheet Header';
    head.layoutMode = 'HORIZONTAL'; head.primaryAxisSizingMode = 'AUTO'; head.counterAxisSizingMode = 'AUTO'; head.counterAxisAlignItems = 'CENTER'; head.fills = [];
    await bind(head, 'itemSpacing', 'doc/state-gap');
    const titles = autoFrame('Titles'); head.appendChild(titles);
    const tt = await text(titles, 'title', 'Title', 'doc/title'); const tr = await text(titles, 'route', 'route · source', 'doc/caption', true);
    const bi = badge.createInstance(); head.appendChild(bi);
    const td = await text(head, 'date', '2026-11-09', 'doc/caption', true);
    const kT = head.addComponentProperty('Title', 'TEXT', 'Title'); tt.componentPropertyReferences = { characters: kT };
    const kR = head.addComponentProperty('Route', 'TEXT', 'route · source'); tr.componentPropertyReferences = { characters: kR };
    const kD = head.addComponentProperty('Date', 'TEXT', '2026-11-09'); td.componentPropertyReferences = { characters: kD };
    sec.appendChild(head); head.x = 64; head.y = 200; setMeta(head, { key: 'template:sheet-header' });
    head.description = 'Code: n/a (sheet chrome)\nProps: Title, Route, Date; the nested Status Badge instance takes its own Status property\nMap: figma-standard.md §2';

    sec.resizeWithoutConstraints(Math.max(head.width, badge.width) + 128, head.y + head.height + 64);
    return { section: sec.id, badge: badge.id, header: head.id };
  }
  async function statusBadge(parent, status) {
    c2fNeedGuard(parent);
    if (!STATUSES.includes(status)) throw new Error('FSS: bad status ' + status);
    const c = findByKey('template:status-badge');
    if (!c) throw new Error('FSS: run ensureTemplates() first');
    const i = c.createInstance(); i.setProperties({ [propKey(i, 'Status')]: status }); parent.appendChild(i);
    return i;
  }

  // ---- state frame skeleton (§3) ------------------------------------------------------
  /** `<Title> / <State> / <width>` with Background, Content, [TabBar], Overlay. o.adopt = id of an existing frame to wrap. */
  async function stateFrame(parent, o) {
    c2fNeedGuard(parent);
    const { key, title, state = 'Default', width = 402, height = 874, source, route, tabBar = false, status = 'draft', diff = 'LIMIT not measured', adopt } = o;
    let f;
    if (adopt) {
      f = await figma.getNodeByIdAsync(adopt); c2fNeedGuard(f); // the source must be on a locked page too
      f.name = `${title} / ${state} / ${Math.round(f.width)}`; parent.appendChild(f);
    } else {
      f = figma.createFrame(); f.name = `${title} / ${state} / ${width}`; f.resize(width, height); f.clipsContent = true; f.fills = [];
      const bg = figma.createRectangle(); bg.name = 'Background'; bg.resize(width, height); bg.locked = true; bg.fills = []; f.appendChild(bg);
      const c = figma.createFrame(); c.name = 'Content'; c.fills = []; c.layoutMode = 'VERTICAL'; c.resize(width, height); f.appendChild(c);
      if (tabBar) { const t = figma.createFrame(); t.name = 'TabBar'; t.fills = []; f.appendChild(t); }
      const ov = figma.createFrame(); ov.name = 'Overlay'; ov.fills = []; ov.resize(width, height); f.appendChild(ov); // free children: no Auto Layout on the frame (§3)
      parent.appendChild(f);
    }
    setMeta(f, { key, source, route, state: state.toLowerCase(), viewport: `${Math.round(f.width)}x${Math.round(f.height)}`, diff, status });
    return { id: f.id };
  }

  // ---- screen sheet (§2) ---------------------------------------------------------------
  /**
   * Section `Screen / <route> / <Title>`: Sheet Header (template instance), States, Spec (4 blocks) + Evidence.
   * o.replace = id of the existing sheet with this key: its content is removed and rebuilt in the same
   * section (same node id and position: links, the manifest and the Handoff `f2c:base` stay valid).
   * Screen sheets hold instances only; kit masters are never rebuilt this way (instances depend on them).
   */
  async function sheet(o) {
    c2fNeedGuard(figma.currentPage);
    const { key, route, title, source, status = 'draft', date = '', commit = '', states = [{ state: 'Default' }], position, spec } = o;
    const ex = findByKey(key);
    if (o.replace) {
      if (!ex || ex.id !== o.replace) throw new Error('FSS: replace ' + o.replace + ' is not the sheet with key ' + key + ' on this page');
      c2fNeedGuard(ex);
      if (ex.findOne((n) => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET')) throw new Error('FSS: ' + ex.name + ' holds masters: not a screen sheet, not replaced');
    } else if (ex) return { id: ex.id, existed: true };
    // everything the build needs, checked BEFORE the first change: a cleared sheet comes back only
    // with a rollback of the whole file
    const tpl = findByKey('template:sheet-header'); if (!tpl) throw new Error('FSS: run ensureTemplates() first');
    const pad = await num('doc/sheet-pad'), gapS = await num('doc/state-gap'), gapSpec = await num('doc/spec-gap');
    const headerH = await num('doc/header-h'), specW = await num('doc/spec-w');
    for (const [n, c] of [['doc/sheet-bg', 'doc'], ['space/5', 'legacy'], ['space/2', 'legacy']]) await V(n, c);
    for (const st of ['doc/section', 'doc/body']) await S(st);
    let sec;
    if (o.replace) { for (const c of [...ex.children]) c.remove(); sec = ex; }
    else {
      let pos = position;
      if (!pos) { let y = 0; for (const n of figma.currentPage.children) y = Math.max(y, n.y + n.height); pos = { x: 0, y: y + 400 }; }
      sec = figma.createSection(); sec.x = pos.x; sec.y = pos.y;
    }
    sec.name = `Screen / ${route} / ${title}`;
    await fillVar(sec, 'doc/sheet-bg'); sec.strokes = []; setMeta(sec, { key, route, source, status });

    const head = tpl.createInstance(); sec.appendChild(head); head.x = pad; head.y = pad;
    head.setProperties({ [propKey(head, 'Title')]: title, [propKey(head, 'Route')]: `${route} · ${source ?? ''}`, [propKey(head, 'Date')]: [date, commit].filter(Boolean).join(' · ') });
    const bi = head.findOne((n) => n.type === 'INSTANCE'); bi.setProperties({ [propKey(bi, 'Status')]: status });

    const row = autoFrame('States', 'HORIZONTAL'); await bind(row, 'itemSpacing', 'doc/state-gap');
    sec.appendChild(row); row.x = pad; row.y = pad + headerH + gapS;
    const frames = [];
    for (const s of states) {
      const r = await stateFrame(row, { key: `${key}#${s.state.toLowerCase()}`, title, route, source, status, state: s.state, width: s.width, height: s.height, tabBar: !!s.tabBar, diff: s.diff, adopt: s.adopt });
      frames.push(r.id);
    }
    const sp = autoFrame('Spec'); sp.counterAxisSizingMode = 'FIXED'; sp.resize(specW, 100); await bind(sp, 'itemSpacing', 'space/5', 'legacy'); sec.appendChild(sp);
    for (const n of ['Components used', 'Tokens', 'States', 'LIMITS', 'Evidence']) {
      const b = autoFrame(n); await bind(b, 'itemSpacing', 'space/2', 'legacy'); sp.appendChild(b); b.layoutSizingHorizontal = 'FILL';
      await text(b, 'heading', n, 'doc/section');
      const li = await text(b, 'list', (spec && spec[n]) || '—', 'doc/body', true); li.layoutSizingHorizontal = 'FILL'; li.textAutoResize = 'HEIGHT';
    }
    sp.x = pad + row.width + gapSpec; sp.y = row.y;
    sec.resizeWithoutConstraints(sp.x + specW + pad, Math.max(row.y + row.height, sp.y + sp.height) + pad);
    c2fMarkRebuilt(sec); // only after a complete build: a failed one leaves the sheet unstampable without evidence
    return { id: sec.id, header: head.id, states: row.id, frames, spec: sp.id, bounds: { w: sec.width, h: sec.height } };
  }

  // ---- component sheet and tile (§4) ------------------------------------------------------
  /** `Tile / <Name>`: fill doc/tile-bg, radius doc/tile-radius, padding doc/tile-pad, gap doc/tile-gap. masterNode is moved into it. */
  async function tile(parent, o) {
    c2fNeedGuard(parent, o.masterNode);
    const { key, name, variants = 1, usage, masterNode } = o;
    const ex = findByKey(key, parent); if (ex) return { id: ex.id, existed: true };
    const t = autoFrame(`Tile / ${name}`);
    await fillVar(t, 'doc/tile-bg'); await bindAll(t, RAD, 'doc/tile-radius'); await bindAll(t, PAD, 'doc/tile-pad'); await bind(t, 'itemSpacing', 'doc/tile-gap');
    parent.appendChild(t);
    if (masterNode) t.appendChild(masterNode);
    await text(t, 'caption', `${name} · ${variants} variants`, 'doc/caption', true);
    if (usage) await text(t, 'usage', usage, 'doc/body');
    setMeta(t, { key });
    return { id: t.id };
  }
  /** Section `Component / <Family>`: Sheet Header + Body. o.body = id of an existing frame to wrap (named `Body`). */
  async function componentSheet(o) {
    c2fNeedGuard(figma.currentPage);
    const { key, family, source, status = 'draft', body, position } = o;
    const ex = findByKey(key); if (ex) return { id: ex.id, existed: true };
    const b = await figma.getNodeByIdAsync(body); if (!b) throw new Error('FSS: body not found ' + body);
    c2fNeedGuard(b); // the source must be on a locked page too, checked before any change
    const tpl = findByKey('template:sheet-header'); if (!tpl) throw new Error('FSS: run ensureTemplates() first');
    const pad = await num('doc/sheet-pad'), headerH = await num('doc/header-h'), gap = await num('doc/state-gap');
    let pos = position; if (!pos) { let y = 0; for (const n of figma.currentPage.children) y = Math.max(y, n.y + n.height); pos = { x: 0, y: y + 400 }; }
    const sec = figma.createSection(); sec.name = 'Component / ' + family; sec.x = pos.x; sec.y = pos.y; await fillVar(sec, 'doc/sheet-bg'); sec.strokes = [];
    const head = tpl.createInstance(); sec.appendChild(head); head.x = pad; head.y = pad;
    head.setProperties({ [propKey(head, 'Title')]: family, [propKey(head, 'Route')]: source, [propKey(head, 'Date')]: '' });
    head.findOne((n) => n.type === 'INSTANCE').setProperties({ [propKey(head.findOne((n) => n.type === 'INSTANCE'), 'Status')]: status });
    b.name = 'Body'; sec.appendChild(b); b.x = pad; b.y = pad + headerH + gap;
    sec.resizeWithoutConstraints(b.width + 2 * pad, b.y + b.height + pad);
    setMeta(sec, { key, source, status });
    c2fMarkRebuilt(sec); // only after a complete build
    return { id: sec.id, bounds: { w: sec.width, h: sec.height } };
  }

  /** `Row / <title>` (§4): title, source line, wrapping content with the masters (moved in). */
  async function row(parent, title, source, masters, width = 1368) {
    c2fNeedGuard(parent, ...masters);
    const r = autoFrame('Row / ' + title); r.counterAxisSizingMode = 'FIXED'; parent.appendChild(r); r.resize(width, 100);
    r.layoutSizingHorizontal = 'FIXED'; r.layoutSizingVertical = 'HUG';
    await fillVar(r, 'doc/row-bg'); await bindAll(r, RAD, 'radius/radius-12', 'velo'); await bindAll(r, PAD, 'space/5', 'legacy'); await bind(r, 'itemSpacing', 'space/3', 'legacy');
    await text(r, 'title', title, 'doc/body');
    const s = await text(r, 'source', source || '—', 'doc/caption', true); s.layoutSizingHorizontal = 'FILL'; s.textAutoResize = 'HEIGHT';
    const c = autoFrame('content', 'HORIZONTAL'); c.layoutWrap = 'WRAP'; r.appendChild(c); c.layoutSizingHorizontal = 'FILL';
    await bind(c, 'itemSpacing', 'space/5', 'legacy'); await bind(c, 'counterAxisSpacing', 'space/5', 'legacy');
    for (const m of masters) c.appendChild(m);
    return { id: r.id };
  }

  return { STATUSES, setMeta, findByKey, missingMeta, ensureTemplates, statusBadge, stateFrame, sheet, tile, row, componentSheet, text };
}
