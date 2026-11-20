/**
 * DESIGNER: the ONLY write helpers of the designer's agent (docs/figma-protocol.md §2, §9).
 * Writes only to `Эксперименты · …`, `К разработке`, `Архив` and `Дизайн · Исходники`; refuses any other page.
 * figma-console `figma_execute`: <this file> + one call, e.g.
 *   return await DESIGNER.startExperiment('Сонник', '<frame id or empty>');
 *   return await DESIGNER.fix([{ id: '<node>', rename: 'Header' }, { id: '<text>', textStyle: 'velo/fs-14' },
 *                              { id: '<node>', bindColor: { field: 'fills', variable: 'color/primary' } },
 *                              { id: '<frame>', bindNumber: { field: 'itemSpacing', variable: 'space/2' } }]);
 *   return await DESIGNER.toHandoff(['<frame id>', …], { issue: 'FE-231', dsgn: 'DSGN-30', title: 'Юрдоки',
 *                                     approved: 'Alexandra 2026-11-21', base: '<front sheet id>' });
 *   return await DESIGNER.setStatus('<handoff section id>', 'в работе');
 *   return await DESIGNER.archive('<handoff section id>', 'в коде', '<link to the «Фронт» sheet>');
 *   return await DESIGNER.remove(['<id>', …]);       // only nodes this agent created (f2c:by)
 *   return await DESIGNER.undoHandoff('<section id>', '<experiment page name>');  // after a failed check
 *
 * Every writing call: validates everything first, saves a named version (no version -> stop,
 * see `options.allowNoVersion`), takes the page lock, releases it in `finally`, returns ids.
 *
 * STATUS: not yet run on the production file (writes wait for the owner's approval).
 * First run: in a copy of the file.
 */
const DESIGNER = (() => {
  const OWN = /^(Эксперименты · .+|К разработке|Архив|Дизайн · Исходники)$/;
  const STATUSES = ['эксперимент', 'на согласовании', 'к разработке', 'в работе', 'в коде', 'отменено'];
  const WHO = 'designer-agent';
  const options = { allowNoVersion: false }; // set true ONLY after the designer said «да, без версии»

  const fail = (msg) => { throw new Error(msg); };
  const pageOf = (n) => { let p = n; while (p && p.type !== 'PAGE') p = p.parent; return p; };
  async function node(id) { const n = await figma.getNodeByIdAsync(id); if (!n) fail('node not found: ' + id); return n; }
  function own(n) { const p = pageOf(n); if (!p || !OWN.test(p.name)) fail('"' + n.name + '" is on page "' + (p && p.name) + '": not a designer page (protocol §2)'); return p; }
  async function page(name) {
    if (!OWN.test(name)) fail('designer agent may not write to page "' + name + '" (protocol §2)');
    await figma.loadAllPagesAsync();
    let p = figma.root.children.find((x) => x.name === name);
    if (!p) { p = figma.createPage(); p.name = name; }
    await p.loadAsync();
    return p;
  }
  function lock(p, task) {
    const cur = p.getPluginData('f2c:lock');
    if (cur) {
      let l = null; try { l = JSON.parse(cur); } catch (e) { /* broken lock: overwrite */ }
      if (l && l.who !== WHO && Date.parse(l.until) > Date.now()) fail('СТРАНИЦА ЗАНЯТА: "' + p.name + '" — ' + l.who + ' до ' + l.until + ' (' + l.task + ')');
    }
    p.setPluginData('f2c:lock', JSON.stringify({ who: WHO, task, until: new Date(Date.now() + 30 * 60e3).toISOString() }));
  }
  const unlock = (p) => { if (p) p.setPluginData('f2c:lock', ''); };
  async function version(title) {
    try { await figma.saveVersionHistoryAsync('agent:designer ' + title); return 'saved'; } catch (e) {
      if (options.allowNoVersion) return 'NOT saved (allowed): ' + e;
      fail('НЕ УДАЛОСЬ СОХРАНИТЬ ВЕРСИЮ (' + e + '). Ничего не изменено. Спроси дизайнера, продолжать ли без точки отката; если да — DESIGNER.options.allowNoVersion = true.');
    }
  }
  /** Run a write under version + lock of the given pages; unlock in finally. */
  async function guarded(pages, task, fn) {
    const v = await version(task);
    const locked = [];
    try { for (const p of pages) { lock(p, task); locked.push(p); } return Object.assign({ version: v }, await fn()); }
    finally { locked.forEach(unlock); }
  }
  function below(p, gap = 160) {
    const nodes = p.children; if (!nodes.length) return { x: 0, y: 0 };
    return { x: Math.min(...nodes.map((n) => n.x)), y: Math.max(...nodes.map((n) => n.y + n.height)) + gap };
  }
  function section(p, name, key) {
    let s = p.children.find((n) => n.type === 'SECTION' && n.getPluginData('f2c:key') === key);
    if (!s) { const at = below(p); s = figma.createSection(); p.appendChild(s); s.name = name; s.setPluginData('f2c:key', key); s.setPluginData('f2c:by', WHO); s.x = at.x; s.y = at.y; }
    return s;
  }
  function fit(s, pad = 64, gap = 64) {
    let x = pad; let h = 0;
    for (const c of s.children) { c.x = x; c.y = pad; x += c.width + gap; h = Math.max(h, c.height); }
    s.resizeWithoutConstraints(Math.max(x - gap + pad, 400), h + 2 * pad);
  }
  function clearMirrorData(n) { for (const k of n.getPluginDataKeys()) if (/^(c2f|f2c):/.test(k)) n.setPluginData(k, ''); }
  async function noteLine(s, label, value) {
    // update «<label>: …» in the `Новое` note if it exists (protocol §5); never creates text
    const note = s.findOne((x) => /^(Новое|Note)/.test(x.name));
    if (!note) return false;
    const texts = note.type === 'TEXT' ? [note] : note.findAll((x) => x.type === 'TEXT');
    const re = new RegExp('(' + label + ':\\s*)[^\\n\\t]*?(?=\\s{2,}|\\t|\\n|$)');
    for (const t of texts) {
      if (!re.test(t.characters)) continue;
      if (t.fontName === figma.mixed) continue;
      await figma.loadFontAsync(t.fontName);
      t.characters = t.characters.replace(re, '$1' + value);
      return true;
    }
    return false;
  }
  let _vars = null;
  async function variable(name) {
    if (!_vars) {
      _vars = {};
      for (const v of await figma.variables.getLocalVariablesAsync()) {
        const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
        if (c.name === 'doc') continue; // sheet chrome, not product
        _vars[v.name] = _vars[v.name] || v; _vars[c.name + '/' + v.name] = v;
      }
    }
    return _vars[name] || fail('variable not found: ' + name + ' (use the exact Figma name, e.g. color/primary, space/2)');
  }

  return {
    options,

    /** New experiment page (or reuse) with a copy of a screen to start from. Instances stay linked to the kit. */
    async startExperiment(topic, sourceId) {
      if (!topic) fail('topic is required');
      const src = sourceId ? await node(sourceId) : null;
      const p = await page('Эксперименты · ' + topic);
      return guarded([p], 'start experiment ' + topic, async () => {
        const s = section(p, topic, 'exp:' + topic);
        const created = [];
        if (src) {
          let c;
          if (src.type === 'COMPONENT') c = src.createInstance();                       // never a second master
          else if (src.type === 'COMPONENT_SET') c = (src.defaultVariant || src.children[0]).createInstance();
          else c = src.clone();                                                           // frames: instances inside stay linked
          s.appendChild(c);
          clearMirrorData(c);                                                             // a copy is not the «Фронт» sheet
          c.setPluginData('f2c:by', WHO); c.setPluginData('f2c:status', 'эксперимент'); c.setPluginData('f2c:from', src.id);
          created.push(c.id); fit(s);
        }
        return { page: p.id, section: s.id, created };
      });
    },

    /** Mechanical fixes in the designer's own frames: rename, text style, colour / number variable. */
    async fix(ops) {
      if (!Array.isArray(ops) || !ops.length) fail('fix([...ops]) needs a non-empty list');
      const nodes = [];
      for (const op of ops) {                                   // validate everything before the first write
        const n = await node(op.id); own(n);
        if (op.textStyle && n.type !== 'TEXT') fail(op.id + ' is not a text layer');
        if (op.textStyle && !/^velo\/fs-/.test(op.textStyle)) fail('only velo/fs-* text styles: ' + op.textStyle);
        nodes.push(n);
      }
      const styles = Object.fromEntries((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s]));
      for (const op of ops) {
        if (op.textStyle && !styles[op.textStyle]) fail('text style not found: ' + op.textStyle);
        if (op.bindColor) await variable(op.bindColor.variable);
        if (op.bindNumber) await variable(op.bindNumber.variable);
      }
      const pages = [...new Set(nodes.map(pageOf))];
      return guarded(pages, 'fix ' + ops.length + ' layers', async () => {
        const done = [];
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i], n = nodes[i];
          if (op.rename) n.name = op.rename;
          if (op.textStyle) { const st = styles[op.textStyle]; await figma.loadFontAsync(st.fontName); await n.setTextStyleIdAsync(st.id); }
          if (op.bindColor) {
            const field = op.bindColor.field || 'fills', v = await variable(op.bindColor.variable);
            n[field] = n[field].map((p) => (p.type === 'SOLID' ? figma.variables.setBoundVariableForPaint(p, 'color', v) : p));
          }
          if (op.bindNumber) {
            const v = await variable(op.bindNumber.variable), f = op.bindNumber.field;
            const fields = f === 'cornerRadius' ? ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'] : f === 'padding' ? ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] : [f];
            for (const x of fields) n.setBoundVariable(x, v);
          }
          done.push(n.id);
        }
        return { fixed: done };
      });
    },

    /** Move approved frames into `Handoff / <issue> / <title>` on «К разработке» and write the metadata. */
    async toHandoff(frameIds, meta) {
      meta = meta || {};
      if (!/^FE-\d+$/.test(meta.issue || '')) fail('meta.issue = FE-NNN is required (create the Linear issue first)');
      if (!meta.title || !String(meta.title).trim()) fail('meta.title is required');
      if (!meta.approved) fail('meta.approved is required: who approved and when (protocol §4)');
      if (!Array.isArray(frameIds) || !frameIds.length) fail('no frames to hand off');
      const frames = [];
      for (const id of frameIds) {                              // validate all before moving any
        const n = await node(id); const from = own(n);
        if (from.name === 'К разработке') fail('"' + n.name + '" is already on «К разработке»');
        frames.push({ n, from: from.name });
      }
      const p = await page('К разработке');
      return guarded([p], 'handoff ' + meta.issue, async () => {
        const s = section(p, 'Handoff / ' + meta.issue + ' / ' + String(meta.title).trim(), 'handoff:' + meta.issue);
        for (const [k, val] of Object.entries({ issue: meta.issue, dsgn: meta.dsgn || '', status: 'к разработке', approved: meta.approved, base: meta.base || '', from: frames[0].from })) s.setPluginData('f2c:' + k, val);
        const moved = [];
        for (const { n } of frames) { s.appendChild(n); n.setPluginData('f2c:status', 'к разработке'); moved.push(n.id); } // moving keeps ids
        fit(s);
        await noteLine(s, 'Статус', 'к разработке');
        return { page: p.id, section: s.id, moved, link: 'node-id=' + s.id.replace(':', '-') };
      });
    },

    /** Put a handoff back to the experiment page it came from (after HANDOFF_CHECK failed on the section). */
    async undoHandoff(sectionId, experimentPage) {
      const s = await node(sectionId); own(s);
      const target = experimentPage || s.getPluginData('f2c:from');
      if (!target || !/^Эксперименты · /.test(target)) fail('experiment page unknown: pass its name');
      const from = pageOf(s), to = await page(target);
      return guarded([from, to], 'undo handoff ' + s.name, async () => {
        const at = below(to); to.appendChild(s); s.x = at.x; s.y = at.y;
        s.setPluginData('f2c:status', 'эксперимент');
        return { section: s.id, page: to.id };
      });
    },

    /** Status of a handoff section (from Linear, protocol §3); also the «Статус:» line of the note. */
    async setStatus(sectionId, status) {
      if (!STATUSES.includes(status)) fail('status must be one of ' + STATUSES.join(', '));
      const s = await node(sectionId); const p = own(s);
      return guarded([p], 'status ' + status + ' ' + s.name, async () => {
        s.setPluginData('f2c:status', status);
        const noted = await noteLine(s, 'Статус', status);
        return { section: s.id, status, noteUpdated: noted };
      });
    },

    /** Move a handoff section to «Архив» with its final status and the link to the «Фронт» sheet (protocol §4.7). */
    async archive(sectionId, status, frontLink) {
      status = status || 'в коде';
      if (!STATUSES.includes(status)) fail('status must be one of ' + STATUSES.join(', '));
      if (status === 'в коде' && !frontLink) fail('«в коде» needs the link to the «Фронт» sheet (protocol §4.7); no sheet yet -> write «нет листа»');
      const s = await node(sectionId); const from = own(s);
      const to = await page('Архив');
      return guarded([from, to], 'archive ' + s.name, async () => {
        const at = below(to); to.appendChild(s); s.x = at.x; s.y = at.y;
        s.setPluginData('f2c:status', status);
        if (frontLink) s.setPluginData('f2c:front', frontLink);
        const noted = await noteLine(s, 'Статус', status + (frontLink ? ' — ' + frontLink : ''));
        return { section: s.id, page: to.id, noteUpdated: noted };
      });
    },

    /** Delete nodes this agent created (pluginData f2c:by), on designer pages only. */
    async remove(ids) {
      const nodes = [];
      for (const id of ids || []) {
        const n = await node(id); own(n);
        if (n.getPluginData('f2c:by') !== WHO) fail('"' + n.name + '" was not created by this agent: not deleting (move it to «Архив» instead)');
        nodes.push(n);
      }
      if (!nodes.length) fail('nothing to remove');
      const pages = [...new Set(nodes.map(pageOf))];
      return guarded(pages, 'remove ' + nodes.length, async () => {
        const removed = nodes.map((n) => n.id); nodes.forEach((n) => n.remove());
        return { removed };
      });
    },
  };
})();
