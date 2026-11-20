/**
 * DESIGNER: the ONLY write helpers of the designer's agent (docs/figma-protocol.md §2, §9).
 * Writes only to `Эксперименты · …`, `К разработке` and `Архив`. Refuses any other page.
 * figma-console `figma_execute`: <this file> + one call, e.g.
 *     return await DESIGNER.startExperiment('Сонник', '<front frame id or empty>');
 *     return await DESIGNER.toHandoff(['<frame id>', …], { issue: 'FE-231', dsgn: 'DSGN-30', title: 'Юрдоки', approved: 'Alexandra 2026-11-21', base: '<front sheet id>' });
 *     return await DESIGNER.setStatus('<handoff section id>', 'в работе');
 *     return await DESIGNER.archive('<handoff section id>', 'в коде');
 * Every call: saves a named version first, takes the page lock, returns ids. Idempotent where it can be.
 *
 * STATUS: written 2026-11-20 without a run on the production file (writes were not
 * allowed before the owner's approval). First run: in a copy of the file.
 */
const DESIGNER = (() => {
  const OWN = /^(Эксперименты · .+|К разработке|Архив)$/;
  const STATUSES = ['эксперимент', 'на согласовании', 'к разработке', 'в работе', 'в коде', 'отменено'];
  const WHO = 'designer-agent';

  async function page(name) {
    if (!OWN.test(name)) throw new Error('designer agent may not write to page "' + name + '" (protocol §2)');
    await figma.loadAllPagesAsync();
    let p = figma.root.children.find((x) => x.name === name);
    if (!p) { p = figma.createPage(); p.name = name; }
    await p.loadAsync();
    return p;
  }
  function lock(p, task) {
    const cur = p.getPluginData('f2c:lock');
    if (cur) {
      const l = JSON.parse(cur);
      if (l.who !== WHO && Date.parse(l.until) > Date.now()) throw new Error('page "' + p.name + '" is locked by ' + l.who + ' until ' + l.until + ' (' + l.task + ')');
    }
    p.setPluginData('f2c:lock', JSON.stringify({ who: WHO, task, until: new Date(Date.now() + 30 * 60e3).toISOString() }));
  }
  const unlock = (p) => p.setPluginData('f2c:lock', '');
  const pageOf = (n) => { let p = n; while (p && p.type !== 'PAGE') p = p.parent; return p; };
  async function version(title) { try { await figma.saveVersionHistoryAsync('agent:designer ' + title); } catch (e) { /* view-only or plan limit: continue, report */ return String(e); } return 'saved'; }
  function below(p, gap = 160) {
    const nodes = p.children; if (!nodes.length) return { x: 0, y: 0 };
    const bottom = Math.max(...nodes.map((n) => n.y + n.height));
    return { x: Math.min(...nodes.map((n) => n.x)), y: bottom + gap };
  }
  function section(p, name, key) {
    let s = p.children.find((n) => n.type === 'SECTION' && n.getPluginData('f2c:key') === key);
    if (!s) { const at = below(p); s = figma.createSection(); s.name = name; s.setPluginData('f2c:key', key); p.appendChild(s); s.x = at.x; s.y = at.y; }
    return s;
  }
  function fit(s, pad = 64, gap = 64) {
    let x = pad; let h = 0;
    for (const c of s.children) { c.x = x; c.y = pad; x += c.width + gap; h = Math.max(h, c.height); }
    s.resizeWithoutConstraints(Math.max(x - gap + pad, 400), h + 2 * pad);
  }

  return {
    /** New experiment page (or reuse), optionally with a CLONE of a «Фронт» frame to start from. */
    async startExperiment(topic, sourceId) {
      const p = await page('Эксперименты · ' + topic);
      const v = await version('start experiment ' + topic);
      lock(p, 'experiment ' + topic);
      const s = section(p, topic, 'exp:' + topic);
      const out = { page: p.id, section: s.id, version: v, created: [] };
      if (sourceId) {
        const src = await figma.getNodeByIdAsync(sourceId);
        if (!src) throw new Error('source not found ' + sourceId);
        const c = src.clone(); // instances stay linked to the kit masters
        s.appendChild(c); c.name = c.name.replace(/ \/ \d+$/, '') + ' / эксперимент / ' + Math.round(c.width);
        out.created.push(c.id); fit(s);
      }
      unlock(p);
      return out;
    },
    /** Move approved frames into `Handoff / <issue> / <title>` on «К разработке» and write the metadata. */
    async toHandoff(frameIds, meta) {
      if (!meta || !/^FE-\d+$/.test(meta.issue || '')) throw new Error('meta.issue = FE-NNN is required (create the Linear issue first)');
      if (!meta.approved) throw new Error('meta.approved is required: who approved and when (protocol §4)');
      const p = await page('К разработке');
      const v = await version('handoff ' + meta.issue);
      lock(p, 'handoff ' + meta.issue);
      const s = section(p, 'Handoff / ' + meta.issue + ' / ' + meta.title, 'handoff:' + meta.issue);
      const moved = [];
      for (const id of frameIds) {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) throw new Error('frame not found ' + id);
        const from = pageOf(n);
        if (!OWN.test(from.name)) throw new Error('frame ' + id + ' is on "' + from.name + '": copy it to an experiment first');
        s.appendChild(n); moved.push(n.id); // moving keeps the node id: old links stay valid
      }
      fit(s);
      for (const [k, val] of Object.entries({ issue: meta.issue, dsgn: meta.dsgn || '', status: 'к разработке', approved: meta.approved, base: meta.base || '' })) s.setPluginData('f2c:' + k, val);
      unlock(p);
      return { page: p.id, section: s.id, moved, version: v, link: 'node-id=' + s.id.replace(':', '-') };
    },
    /** Set a status on a handoff section (from Linear). */
    async setStatus(sectionId, status) {
      if (!STATUSES.includes(status)) throw new Error('status must be one of ' + STATUSES.join(', '));
      const s = await figma.getNodeByIdAsync(sectionId);
      const p = pageOf(s);
      if (!OWN.test(p.name)) throw new Error('not a designer page: ' + p.name);
      s.setPluginData('f2c:status', status);
      return { section: s.id, status };
    },
    /** Move a handoff section to «Архив» with its final status. */
    async archive(sectionId, status) {
      const s = await figma.getNodeByIdAsync(sectionId);
      if (!OWN.test(pageOf(s).name)) throw new Error('not a designer page');
      const p = await page('Архив');
      const v = await version('archive ' + s.name);
      lock(p, 'archive');
      const at = below(p); p.appendChild(s); s.x = at.x; s.y = at.y;
      s.setPluginData('f2c:status', status || 'в коде');
      unlock(p);
      return { section: s.id, page: p.id, version: v };
    },
  };
})();
