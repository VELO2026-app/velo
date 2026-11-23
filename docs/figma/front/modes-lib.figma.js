/**
 * MODES: the modes of the Figma `velo` collection -- core, gold, goodo (FE-234 item 6,
 * docs/figma-protocol.md §8.4). The source of truth is this file in the repo; paste it into
 * `figma_execute` from the branch you work against
 * (`git show origin/deploy-machine:docs/figma/front/modes-lib.figma.js`).
 *
 * The values come from the code, never from a hand edit: frontend/design/figma-modes.json pins the
 * modes, `node scripts/sync-figma-variables.mjs --skin --snapshot <dump> --payload <out>` (from
 * frontend/) computes them. This file only reads the file (snapshot, plan) and writes a payload
 * (apply). Paste the payload JSON into the call as a literal.
 *
 *   const MODES = makeModes({ thread: '<bb thread id>', task: 'FE-NNN' });
 *   return await MODES.snapshot();                   // read-only: the dump for --snapshot
 *   return await MODES.plan(PAYLOAD);                // read-only: what apply would do, or why not
 *   return await MODES.apply(PAYLOAD, { createModes: true, makeCoreDefault: true });
 *   // inside FRONT.write (front-lib.figma.js pasted first), on a `Фронт · …` page or section:
 *   MODES.pin(node, 'gold');                         // explicit mode, survives a new default mode
 *
 * What apply guarantees:
 *   - the file key is the payload's; the collection exists once; a mode the payload pins by id
 *     (gold = 3905:0) has that id AND that name -- so the core values never land in the gold mode;
 *   - a Figma mode the payload does not name stops the call (allowExtraModes only with the owner's
 *     yes); more than 4 modes stops the call (the Professional plan);
 *   - every value is checked before the first write: the variable exists in its collection, the
 *     value fits its type, an alias target exists and has the same type; one defect = no write;
 *   - a named version is saved first; no version -> stop;
 *   - only values that differ are written; a core-only collection (legacy, one mode) gets its core;
 *   - makeCoreDefault makes the core the default mode (setDefaultMode) and reports the order.
 * The default mode is what every node without an explicit mode shows: pin the pages and sections
 * that must stay in gold BEFORE makeCoreDefault (protocol §8.4).
 */
/** Numeric version (yyyymmddnn), compared as a number. */
const MODES_LIB_VERSION = 2026112301;
const MODES_FORMAT = 'velo-figma-modes/1';
const MODES_FILE = 'IV92js0q2cBHmHmDxB0zxM';
const MODES_MAX = 4;

/** makeModes({ thread, task, fileKey? }) -- see the header. */
function makeModes(o) {
  o = o || {};
  const fail = (m) => { throw new Error('MODES: ' + m); };
  if (!o.task) fail('makeModes({ thread, task }) needs the task (FE-NNN) for the version label');

  async function collections() { return figma.variables.getLocalVariableCollectionsAsync(); }
  async function variables() { return figma.variables.getLocalVariablesAsync(); }
  function encode(value) {
    if (value && typeof value === 'object' && 'r' in value) return { r: value.r, g: value.g, b: value.b, a: value.a == null ? 1 : value.a };
    return value;
  }

  /** Read-only: every local collection with its modes and every variable's values by mode id. */
  async function snapshot() {
    const cols = await collections();
    const vars = await variables();
    return {
      format: MODES_FORMAT, kind: 'snapshot', file: figma.fileKey, at: new Date().toISOString(), lib: MODES_LIB_VERSION,
      collections: cols.map((c) => ({ id: c.id, name: c.name, modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })), defaultModeId: c.defaultModeId })),
      variables: vars.map((v) => {
        const valuesByMode = {};
        for (const k of Object.keys(v.valuesByMode)) valuesByMode[k] = encode(v.valuesByMode[k]);
        return { id: v.id, name: v.name, collectionId: v.variableCollectionId, resolvedType: v.resolvedType, valuesByMode };
      }),
    };
  }

  /** The Figma form of a payload value, or a reason it does not fit the variable. */
  function target(value, variable, byName) {
    const t = variable.resolvedType;
    if (value.alias !== undefined) {
      const to = byName.get(value.alias);
      if (!to) return { error: 'alias target ' + value.alias + ' does not exist' };
      if (to.resolvedType !== t) return { error: 'alias target ' + value.alias + ' is ' + to.resolvedType + ', the variable is ' + t };
      return { alias: to };
    }
    if (value.color !== undefined) {
      if (t !== 'COLOR') return { error: 'a color into a ' + t + ' variable' };
      const c = value.color;
      if (!Array.isArray(c) || c.length !== 4) return { error: 'a color is [r, g, b, a]' };
      return { value: { r: c[0] / 255, g: c[1] / 255, b: c[2] / 255, a: c[3] } };
    }
    if (value.float !== undefined) {
      if (t !== 'FLOAT' && t !== 'TIMING') return { error: 'a number into a ' + t + ' variable' };
      if (typeof value.float !== 'number' || !isFinite(value.float)) return { error: 'not a number' };
      return { value: value.float };
    }
    if (value.string !== undefined) {
      if (t !== 'STRING') return { error: 'a string into a ' + t + ' variable' };
      return { value: String(value.string) };
    }
    return { error: 'unknown value ' + JSON.stringify(value) };
  }

  /** Is the current Figma value already the target? Colors within the 1/255 storage noise. */
  function same(current, t) {
    if (t.alias) return !!current && current.type === 'VARIABLE_ALIAS' && current.id === t.alias.id;
    const v = t.value;
    if (current && typeof current === 'object' && 'r' in current && v && typeof v === 'object') {
      const a = current.a == null ? 1 : current.a;
      return Math.abs(current.r - v.r) <= 0.5 / 255 && Math.abs(current.g - v.g) <= 0.5 / 255
        && Math.abs(current.b - v.b) <= 0.5 / 255 && Math.abs(a - v.a) <= 0.002;
    }
    if (typeof current === 'number' && typeof v === 'number') return Math.abs(current - v) <= 1e-4;
    return current === v;
  }

  /** Every check of apply, no change. Returns { ok, problems, create, changes, writes, col, … }. */
  async function check(payload, opts) {
    opts = opts || {};
    const problems = [];
    if (!payload || payload.format !== MODES_FORMAT || payload.kind !== 'payload') {
      return { ok: false, problems: ['not a ' + MODES_FORMAT + ' payload (sync-figma-variables.mjs --skin --payload)'] };
    }
    const file = o.fileKey || payload.file || MODES_FILE;
    if (figma.fileKey !== file) problems.push('wrong file ' + figma.fileKey + ', the payload is for ' + file);
    const cols = await collections();
    const vars = await variables();
    const byName = new Map(vars.map((v) => [v.name, v]));
    const matches = cols.filter((c) => c.name === payload.collection);
    if (matches.length !== 1) return { ok: false, problems: problems.concat(['collection ' + payload.collection + ': ' + matches.length + ' found, expected 1']) };
    const col = matches[0];
    const wanted = payload.modes || [];
    if (wanted.length === 0) problems.push('the payload names no modes');
    const modeId = new Map();
    const create = [];
    for (const m of wanted) {
      if (m.figmaModeId) {
        const found = col.modes.find((x) => x.modeId === m.figmaModeId);
        if (!found) problems.push('mode ' + m.name + ': id ' + m.figmaModeId + ' is not in ' + col.name);
        else if (found.name !== m.name) problems.push('mode ' + m.figmaModeId + ' is named "' + found.name + '", the payload pins it as "' + m.name + '": stop, a renamed mode would take the wrong values');
        else modeId.set(m.name, found.modeId);
        continue;
      }
      const byModeName = col.modes.filter((x) => x.name === m.name);
      if (byModeName.length > 1) problems.push('mode ' + m.name + ' exists ' + byModeName.length + ' times');
      else if (byModeName.length === 1) modeId.set(m.name, byModeName[0].modeId);
      else create.push(m.name);
    }
    const known = new Set(wanted.map((m) => m.name));
    const extra = col.modes.filter((x) => !known.has(x.name)).map((x) => x.name);
    if (extra.length > 0 && !opts.allowExtraModes) problems.push('Figma modes the payload does not name: ' + extra.join(', ') + ' (allowExtraModes only with the owner\'s yes)');
    if (col.modes.length + create.length > MODES_MAX) problems.push(col.modes.length + ' modes + ' + create.length + ' new > ' + MODES_MAX + ' (the plan limit)');
    if (create.length > 0 && !opts.createModes) problems.push('missing modes ' + create.join(', ') + ': pass { createModes: true }');

    const writes = [];
    const changes = {};
    for (const pc of payload.collections || []) {
      const fc = cols.filter((c) => c.name === pc.name);
      if (fc.length !== 1) { problems.push('collection ' + pc.name + ': ' + fc.length + ' found, expected 1'); continue; }
      const c = fc[0];
      if (pc.coreOnly && c.modes.length !== 1) { problems.push('collection ' + pc.name + ' is core-only but has ' + c.modes.length + ' modes'); continue; }
      if (!pc.coreOnly && c.id !== col.id) { problems.push('collection ' + pc.name + ' is not the moded collection ' + col.name); continue; }
      for (const name of Object.keys(pc.values)) {
        const variable = vars.find((v) => v.name === name && v.variableCollectionId === c.id);
        if (!variable) { problems.push(pc.name + ': no variable ' + name); continue; }
        const entry = pc.values[name];
        for (const modeName of Object.keys(entry)) {
          const t = target(entry[modeName], variable, byName);
          if (t.error) { problems.push(name + ' (' + modeName + '): ' + t.error); continue; }
          const id = pc.coreOnly ? c.modes[0].modeId : modeId.get(modeName);
          const label = pc.coreOnly ? pc.name : modeName;
          if (!pc.coreOnly && !known.has(modeName)) { problems.push(name + ': mode ' + modeName + ' is not in the payload modes'); continue; }
          const current = id ? variable.valuesByMode[id] : undefined;
          if (id && same(current, t)) continue;
          changes[label] = (changes[label] || 0) + 1;
          writes.push({ variable, modeName, modeId: id, target: t }); // id undefined = a mode apply creates
        }
      }
    }
    return { ok: problems.length === 0, problems, col, create, modeId, changes, writes, order: col.modes.map((m) => m.name), defaultMode: (col.modes.find((m) => m.modeId === col.defaultModeId) || {}).name };
  }

  /** Read-only: what apply would create and change, or the problems that stop it. */
  async function plan(payload, opts) {
    const r = await check(payload, Object.assign({ createModes: true }, opts));
    return { ok: r.ok, problems: r.problems, create: r.create, changes: r.changes, order: r.order, defaultMode: r.defaultMode, lib: MODES_LIB_VERSION };
  }

  async function apply(payload, opts) {
    opts = opts || {};
    const r = await check(payload, opts);
    if (!r.ok) fail('stopped before any change:\n  - ' + r.problems.join('\n  - '));
    const col = r.col;
    try {
      await figma.saveVersionHistoryAsync('agent:front ' + o.task + ' figma modes ' + payload.modes.map((m) => m.name).join('/'));
    } catch (e) {
      fail('no version saved (' + (e && e.message) + '): nothing written');
    }
    const created = [];
    for (const name of r.create) {
      const id = col.addMode(name);
      r.modeId.set(name, id);
      created.push({ name, modeId: id });
    }
    let written = 0;
    for (const w of r.writes) {
      const value = w.target.alias ? figma.variables.createVariableAlias(w.target.alias) : w.target.value;
      w.variable.setValueForMode(w.modeId || r.modeId.get(w.modeName), value);
      written++;
    }
    // A new mode starts as a copy of the default one: its values were written above in full
    // (check() counted every value of a mode that did not exist as a change).
    let defaultNote = null;
    const coreName = payload.modes[0].name;
    if (opts.makeCoreDefault) {
      const coreId = r.modeId.get(coreName);
      if (col.defaultModeId !== coreId) {
        if (typeof col.setDefaultMode !== 'function') defaultNote = 'setDefaultMode is not in this Figma: reorder the modes by hand (core first)';
        else col.setDefaultMode(coreId);
      }
    }
    return {
      lib: MODES_LIB_VERSION, created, written, changes: r.changes,
      order: col.modes.map((m) => m.name),
      defaultMode: (col.modes.find((m) => m.modeId === col.defaultModeId) || {}).name,
      defaultNote,
    };
  }

  /** Explicit mode on a mirror page or section; only inside FRONT.write (front-lib pasted first). */
  async function pin(node, modeName) {
    if (typeof c2fNeedGuard !== 'function') fail('pin() needs front-lib.figma.js pasted first and FRONT.write around the call');
    c2fNeedGuard(node);
    const cols = await collections();
    const col = cols.find((c) => c.name === 'velo');
    const mode = col && col.modes.find((m) => m.name === modeName);
    if (!mode) fail('no mode ' + modeName + ' in velo');
    node.setExplicitVariableModeForCollection(col, mode.modeId);
    return { node: node.id, name: node.name, mode: modeName };
  }

  return { snapshot, plan, apply, pin, version: MODES_LIB_VERSION };
}
