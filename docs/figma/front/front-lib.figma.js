/**
 * FRONT: the front-end agent's writes to the Figma mirror pages (docs/figma-protocol.md §8, §9; FE-224).
 * The source of truth is this file in the repo. Read it from the branch you work against
 * (`git show origin/deploy-machine:docs/figma/front/front-lib.figma.js`) and paste it into
 * `figma_execute` BEFORE docs/figma/front/fss-lib.figma.js (the FSS builders; makeFSS calls
 * c2fNeedGuard). A read-only caller (the weekly check) pastes it too and calls only c2fInventory().
 *
 *   const FRONT = makeFront({ thread: '<bb thread id>', task: 'FE-NNN' });
 *   await FRONT.acquire(['Фронт · Экраны']);          // once per task: the lock outlives one call
 *   return await FRONT.write(['Фронт · Экраны'], 'resnap user.dashboard', async () => {
 *     const r = await FSS.sheet({ …, replace: '<sheet id>' });   // rebuilds the section in place
 *     return Object.assign(r, await FRONT.stamp(r.id, { commit: '<sha>', committedAt: '<git %cI>' }));
 *   });
 *   await FRONT.release(['Фронт · Экраны']);           // end of the task (or let the lock expire)
 *
 * What a write guarantees:
 *   - pages: only `Фронт · …` and `Обложка`; anything else stops the call before any change;
 *   - lock `f2c:lock` = {who, task, until} (the designer's agent uses the same format); a live lock of
 *     another owner (the designer's agent, another front thread) stops the call before the version;
 *     `acquire` holds the lock across calls (TTL 60 min, every write extends it), a write without
 *     `acquire` locks and releases in `finally`;
 *   - a named version is saved first; no version -> stop (unless allowNoVersion, owner's yes);
 *   - the FSS builders refuse a target or a source node outside the locked pages; a write refuses
 *     to start when fss-lib.figma.js is pasted without its version or older than FSS_LIB_MIN;
 *   - new nodes are created on the first locked page (it is made current), never on a designer page;
 *   - `stamp` writes a commit without `evidence` only on a sheet that FSS.sheet / FSS.componentSheet
 *     rebuilt in this write; anything else (a baseline, a raw resnap) needs `evidence`: a diff result
 *     or another comparison with that commit.
 * NOT guarded: a raw `figma.*` change. Figma does not report a plugin's own changes to the plugin
 * (`documentchange` stays silent, checked live 21.11), so nothing can watch them. The rule: before a
 * raw change, pass the node to FRONT.touch(node) — it refuses a node outside the locked pages.
 * Restoring a saved version rolls back the WHOLE file, the designer's pages included.
 */
/** Numeric versions (yyyymmddnn): compared as numbers, never as strings. */
const FRONT_LIB_VERSION = 2026112103;
/** The oldest fss-lib.figma.js (FSS_LIB_VERSION) a write accepts. */
const FSS_LIB_MIN = 2026112101;
/** Prefix of the current c2fSeal; a stored seal with another prefix cannot be compared. */
const C2F_SEAL_V = 'v2:';
const C2F_FILE = 'IV92js0q2cBHmHmDxB0zxM';
/** pluginData keys only FRONT.stamp may write (FSS.setMeta refuses them). */
const C2F_RESERVED = ['commit', 'captured', 'committed', 'evidence', 'seal'];
// Set only while FRONT.write runs: { pages: Set<pageId>, rebuilt: Set<sheetId> }.
let C2F_GUARD = null;

function c2fPageOf(n) { let p = n; while (p && p.type !== 'PAGE') p = p.parent; return p; }
/** The top-level node of a page that holds `n` (a mirror sheet), or null. */
function c2fSheetOf(n) {
  let x = n;
  while (x && x.parent && x.parent.type !== 'PAGE') x = x.parent;
  return x && x.parent && x.parent.type === 'PAGE' ? x : null;
}
/** Throws unless every node is on a page the running FRONT.write locked. Marks nothing. */
function c2fNeedGuard(...nodes) {
  for (const node of nodes) {
    if (!node) continue;
    const p = c2fPageOf(node);
    if (!C2F_GUARD || !p || !C2F_GUARD.pages.has(p.id)) {
      throw new Error('FRONT: node "' + node.name + '" on page "' + (p && p.name) + '" is outside FRONT.write: wrap the call in FRONT.write([<page>], …) and lock every page it touches (protocol §9)');
    }
  }
}
/** Called by FSS.sheet / FSS.componentSheet only: this sheet was rebuilt from code in this write. */
function c2fMarkRebuilt(sheet) {
  c2fNeedGuard(sheet);
  C2F_GUARD.rebuilt.add((c2fSheetOf(sheet) || sheet).id);
}
/** Stored seal vs the current algorithm: { intact, note }. */
function c2fSealState(node) {
  const stored = node.getPluginData('c2f:seal') || null;
  if (!stored) return { seal: null, intact: null, note: 'no seal' };
  if (!stored.startsWith(C2F_SEAL_V)) return { seal: stored, intact: null, note: 'seal ' + stored.split(':')[0] + ' is not ' + C2F_SEAL_V + ' restamp needed' };
  return { seal: stored, intact: stored === c2fSeal(node), note: null };
}

/**
 * Structure fingerprint of a mirror sheet (`c2f:seal`, protocol §9.7), version 2. Covers type, name,
 * visibility, opacity, rounded geometry, fills and strokes (bound variable or colour, image hash),
 * effects, font and texts of every layer; the root position is left out (moving a sheet is not an
 * edit). Instances are not entered, only their texts are read. pluginData is not covered.
 * A kit or variable update CAN change it (sizes of bound layers and instances): the weekly check
 * reports such a sheet as edited, and the PR that changed the kit or the tokens lists it for a resnap.
 * KEEP IDENTICAL to c2fSeal in docs/figma/velo-figma-designer/scripts/compare.figma.js (a test checks it).
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

/** makeFront({ thread, task, allowNoVersion?, fileKey? }) — see the header. */
function makeFront(o) {
  o = o || {};
  const FILE = o.fileKey || C2F_FILE;
  const OWN = /^(Фронт · .+|Обложка)$/;
  const TTL = 60 * 60e3;
  const fail = (m) => { throw new Error(m); };
  if (!o.thread) fail('FRONT: thread is required (the lock owner; two front threads must not share one)');
  if (!o.task) fail('FRONT: task is required (FE-NNN: goes into the lock and the version name)');
  const WHO = 'front-agent ' + o.thread;

  function lockOf(p) {
    const raw = p.getPluginData('f2c:lock');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; } // a broken lock is overwritten
  }
  const alive = (l) => !!l && Date.parse(l.until) > Date.now();
  const busy = (p) => { const l = lockOf(p); return alive(l) && l.who !== WHO ? l : null; };
  const busyError = (p, l) => 'СТРАНИЦА ЗАНЯТА: "' + p.name + '" — ' + l.who + ' до ' + l.until + ' (' + l.task + '). Ничего не изменено: подожди или спроси человека.';
  const setLock = (p, label) => p.setPluginData('f2c:lock', JSON.stringify({ who: WHO, task: o.task + (label ? ' ' + label : ''), until: new Date(Date.now() + TTL).toISOString() }));
  function checkFile() {
    if (!figma.fileKey) { if (!o.allowUnknownFile) fail('FRONT: figma.fileKey is not available: cannot prove this is ' + FILE + ' (makeFront({ …, allowUnknownFile: true }) only with the owner\'s yes)'); }
    else if (figma.fileKey !== FILE) fail('FRONT: wrong file ' + figma.fileKey + ', expected ' + FILE);
  }
  async function resolvePages(list) {
    if (!Array.isArray(list) || !list.length) fail('FRONT: list the pages');
    await figma.loadAllPagesAsync();
    const out = [];
    for (const ref of list) {
      const p = figma.root.children.find((x) => x.id === ref || x.name === ref);
      if (!p) fail('FRONT: page not found: ' + ref);
      if (!OWN.test(p.name)) fail('FRONT: the front agent may not write to page "' + p.name + '" (protocol §2): only «Фронт · …» and «Обложка»');
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }
  async function version(title) {
    try { await figma.saveVersionHistoryAsync('agent:front ' + o.task + ' ' + title); return 'saved'; } catch (e) {
      if (o.allowNoVersion) return 'NOT saved (allowed): ' + e;
      fail('FRONT: НЕ УДАЛОСЬ СОХРАНИТЬ ВЕРСИЮ (' + e + '). Ничего не изменено. Без точки отката — только по «да» владельца: makeFront({ …, allowNoVersion: true }).');
    }
  }

  return {
    WHO,
    VERSION: FRONT_LIB_VERSION,
    /** Hold the lock of these pages across calls (a resnap is many figma_execute calls). */
    async acquire(list, label) {
      checkFile();
      const pages = await resolvePages(list);
      for (const p of pages) { const l = busy(p); if (l) fail(busyError(p, l)); }
      for (const p of pages) setLock(p, label || 'task lock');
      return { locked: pages.map((p) => p.id), who: WHO, until: lockOf(pages[0]).until };
    },
    /** Drop this thread's lock (another owner's lock is left alone). */
    async release(list) {
      const pages = await resolvePages(list);
      const released = [];
      for (const p of pages) { const l = lockOf(p); if (l && l.who === WHO) { p.setPluginData('f2c:lock', ''); released.push(p.id); } }
      return { released };
    },
    async write(list, label, fn) {
      if (C2F_GUARD) fail('FRONT.write is already running (no nesting)');
      if (typeof makeFSS === 'function' && (typeof FSS_LIB_VERSION !== 'number' || FSS_LIB_VERSION < FSS_LIB_MIN)) {
        fail('FRONT: the pasted FSS builders are not docs/figma/front/fss-lib.figma.js ≥ ' + FSS_LIB_MIN + ' (an old skill copy has no guards): paste the repo file');
      }
      checkFile();
      if (!label) fail('FRONT.write: label is required (goes into the version name)');
      const pages = await resolvePages(list);
      for (const p of pages) { const l = busy(p); if (l) fail(busyError(p, l)); } // before the version: a busy page changes nothing
      const v = await version(label);
      const lockedHere = [];
      const back = figma.currentPage;
      const pageIds = new Set(pages.map((p) => p.id));
      const guard = { pages: pageIds, rebuilt: new Set() };
      try {
        for (const p of pages) {
          const l = lockOf(p);
          if (alive(l) && l.who !== WHO) fail(busyError(p, l)); // taken between the check and now
          if (!(l && l.who === WHO)) lockedHere.push(p); // our own lock (acquire; even expired) is extended and kept
          setLock(p, label);
        }
        C2F_GUARD = guard;
        if (figma.currentPage !== pages[0]) await figma.setCurrentPageAsync(pages[0]); // new nodes land on a locked page
        const r = await fn(pages);
        return Object.assign({ version: v, pages: [...pageIds], rebuilt: [...guard.rebuilt] }, r || {});
      } finally {
        C2F_GUARD = null;
        for (const p of lockedHere) { const l = lockOf(p); if (l && l.who === WHO) p.setPluginData('f2c:lock', ''); }
        if (figma.currentPage !== back) { try { await figma.setCurrentPageAsync(back); } catch (e) { /* page gone: stay */ } }
      }
    },
    /**
     * Inside write: the code commit the sheet now shows. A sheet rebuilt in this write needs only the
     * commit; a sheet NOT rebuilt (a baseline, §8.3) needs `evidence`: how it was compared with that
     * commit. `committedAt` (`git show -s --format=%cI <sha>`) must not be older than the sheet's.
     */
    async stamp(sheetId, m) {
      m = m || {};
      if (!/^[0-9a-f]{7,40}$/.test(m.commit || '')) fail('FRONT.stamp: commit = git sha of the code the sheet shows');
      if (!m.committedAt || isNaN(Date.parse(m.committedAt))) fail('FRONT.stamp: committedAt = commit date (git show -s --format=%cI ' + m.commit + ')');
      const sheet = await figma.getNodeByIdAsync(sheetId);
      if (!sheet) fail('FRONT.stamp: node not found ' + sheetId);
      if (!C2F_GUARD) fail('FRONT.stamp: only inside FRONT.write');
      const rebuilt = C2F_GUARD.rebuilt.has(sheet.id);
      c2fNeedGuard(sheet);
      if (!rebuilt && !m.evidence) fail('FRONT.stamp: "' + sheet.name + '" was not rebuilt by FSS.sheet / FSS.componentSheet in this write: pass evidence (a diff result or how it was compared with ' + m.commit + ', protocol §8.3)');
      const prev = sheet.getPluginData('c2f:committed');
      if (prev && Date.parse(prev) > Date.parse(m.committedAt)) fail('FRONT.stamp: the sheet shows newer code (' + sheet.getPluginData('c2f:commit') + ', ' + prev + '): resnap from the current origin/deploy-machine');
      const captured = m.captured || new Date().toISOString();
      const frames = 'findAll' in sheet ? sheet.findAll((n) => !!n.getPluginData('c2f:state')) : [];
      for (const n of [sheet, ...frames]) { n.setPluginData('c2f:commit', m.commit); n.setPluginData('c2f:committed', m.committedAt); n.setPluginData('c2f:captured', captured); }
      sheet.setPluginData('c2f:evidence', m.evidence || 'rebuilt from code in this write');
      const seal = c2fSeal(sheet);
      sheet.setPluginData('c2f:seal', seal);
      return { sheet: sheet.id, stamped: 1 + frames.length, commit: m.commit, captured, rebuilt, evidence: sheet.getPluginData('c2f:evidence'), seal };
    },
    /** Inside write: declare a raw `figma.*` change of these nodes (refused outside the locked pages). */
    touch(...nodes) {
      if (!C2F_GUARD) fail('FRONT.touch: only inside FRONT.write');
      c2fNeedGuard(...nodes); // guards only: a touched sheet is not «rebuilt»
      return nodes.length;
    },
    /** Read-only: was the sheet changed after the last stamp? */
    async check(sheetId) {
      const s = await figma.getNodeByIdAsync(sheetId);
      if (!s) return { error: 'not found ' + sheetId };
      const st = c2fSealState(s);
      return { sheet: s.id, name: s.name, commit: s.getPluginData('c2f:commit') || null, captured: s.getPluginData('c2f:captured') || null, seal: st.seal, current: c2fSeal(s), intact: st.intact, note: st.note };
    },
  };
}

/**
 * c2fInventory() — READ-ONLY list of the mirror sheets for `frontend/scripts/front-sheets.mjs`
 * (manifest `--write-manifest`, weekly check `--stale`). Top-level sections with `c2f:key` on the
 * `Фронт · …` pages. `sources` = what the sheet mirrors: a screen's view (`c2f:source`), the icon
 * folders, or the `Code:` paths of the kit masters (`name:<Component>` when a master has none);
 * registry, skin and asset sheets are mapped by key in the script.
 */
async function c2fInventory() {
  await figma.loadAllPagesAsync();
  const sheets = [];
  const codeRe = /(?:Code|Код):\s*((?:frontend|packages)\/[\w./@-]*[\w@-])/g;
  for (const p of figma.root.children.filter((x) => /^Фронт · /.test(x.name))) {
    await p.loadAsync();
    for (const s of p.children) {
      const key = s.getPluginData('c2f:key');
      if (!key) continue;
      let sources = [];
      if (key.startsWith('screen:')) sources = [s.getPluginData('c2f:source')].filter(Boolean);
      if (key === 'component:Icons') sources = ['frontend/src/components/icons', 'packages/velo-ui/src/icons'];
      else if (key.startsWith('component:')) {
        const set = new Set();
        for (const c of s.findAll((n) => (n.type === 'COMPONENT' && n.parent.type !== 'COMPONENT_SET') || n.type === 'COMPONENT_SET')) {
          let found = false;
          for (const m of (c.description || '').matchAll(codeRe)) { set.add(m[1]); found = true; }
          const name = /^[A-Z][A-Za-z0-9]+/.exec(c.name);
          if (!found && name) set.add('name:' + name[0]);
        }
        sources = [...set].sort();
        if (!sources.length && s.getPluginData('c2f:source')) sources = [s.getPluginData('c2f:source') + '/**'];
      }
      let commit = s.getPluginData('c2f:commit') || null;
      let captured = s.getPluginData('c2f:captured') || null;
      const skin = s.getPluginData('c2f:skin');
      if (!commit && skin) { try { const j = JSON.parse(skin); commit = j.commit || null; captured = captured || j.date || null; } catch (e) { /* not JSON */ } }
      const st = c2fSealState(s); // a seal of another version counts as no seal (unsealed), with a note
      sheets.push({ key, id: s.id, page: p.name, name: s.name, status: s.getPluginData('c2f:status') || null, sources, commit, captured, seal: st.intact === null ? null : st.seal, intact: st.intact, sealNote: st.note });
    }
  }
  return { file: figma.fileKey, at: new Date().toISOString(), lib: FRONT_LIB_VERSION, sheets };
}
