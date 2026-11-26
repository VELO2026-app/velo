/**
 * SIMILAR_TOKENS: READ-ONLY search for an existing token (Figma variable) close to a
 * proposed value. Run it BEFORE filing a token request (docs/figma-protocol.md §10).
 * Runs in the Figma plugin sandbox through figma-console `figma_execute`:
 *     <this file> + one line:  return await SIMILAR_TOKENS('#a1e0c7');   // colour
 *                              return await SIMILAR_TOKENS('#a1e0c780'); // colour with alpha (rrggbbaa)
 *                              return await SIMILAR_TOKENS(12);          // spacing or radius, px
 * The variables on the page «Kit и токены» are the only approved tokens; they are
 * synced from frontend/tokens.json. Never changes the file.
 * Result: { kind, value, exact: [...], near: [...], advice }
 *   exact  the same value: use this token, do not file a request
 *          Alpha counts as a channel: a translucent token never equals an opaque colour.
 *          Numbers are compared only with spacing and radius variables (`space/`, `app/`,
 *          `radius/`, the H-08 list of the protocol), not with font sizes or other floats.
 *   near   colour within `colorDistance` (max channel difference, 0..255, default 12) or
 *          a number within `numberDistance` px (default 2): offer it to the designer first
 * Mode: values are read in the mode named `opts.mode` (default `gold`, the skin the screens are
 * drawn in) and the result names it; a one-mode collection (legacy) gives its own mode. A
 * collection with several modes and none of that name returns { error }: since FE-234 the first
 * mode of `velo` is the neutral core, and reading it would offer the wrong tokens.
 */
const SIMILAR_TOKENS = async (value, opts) => {
  const o = Object.assign({ colorDistance: 12, numberDistance: 2, limit: 8, mode: 'gold' }, opts || {});
  const isColor = typeof value === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value.trim());
  const isNumber = typeof value === 'number' && isFinite(value);
  if (!isColor && !isNumber) return { error: 'value must be a #rrggbb or #rrggbbaa string, or a number of px' };
  // [r, g, b, a] on a 0..255 scale; a missing alpha is opaque
  const rgb = (h) => [1, 3, 5, 7].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
  const toHex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
    + (c.a !== undefined && c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, '0') : '');
  const want = isColor ? rgb(value.trim().toLowerCase()) : null;
  const vars = await figma.variables.getLocalVariablesAsync(isColor ? 'COLOR' : 'FLOAT');
  const cols = {};
  const colOf = async (id) => {
    if (!(id in cols)) cols[id] = (await figma.variables.getVariableCollectionByIdAsync(id)) || null;
    return cols[id];
  };
  const colName = async (id) => { const c = await colOf(id); return c ? c.name : id; };
  // The mode named o.mode; a one-mode collection (legacy) has only its own. A collection with
  // several modes and none named o.mode is an error: silently reading another mode (the core)
  // would offer the wrong tokens.
  const missingMode = new Set();
  const modeOf = async (v) => {
    const c = await colOf(v.variableCollectionId);
    const modes = (c && c.modes) || [];
    const m = modes.find((x) => x.name === o.mode) || (modes.length === 1 ? modes[0] : null);
    if (!m && modes.length > 1) { missingMode.add(c.name); return null; }
    return m && m.modeId in v.valuesByMode ? m.modeId : Object.keys(v.valuesByMode)[0];
  };
  const resolve = async (v, depth) => {
    const modeId = await modeOf(v);
    if (modeId === null) return null;
    let val = v.valuesByMode[modeId];
    if (val && val.type === 'VARIABLE_ALIAS' && depth < 8) {
      const t = await figma.variables.getVariableByIdAsync(val.id);
      return t ? resolve(t, depth + 1) : null;
    }
    return val;
  };
  const exact = [], near = [];
  for (const v of vars) {
    const val = await resolve(v, 0);
    if (val == null) continue;
    const row = { name: v.name, collection: await colName(v.variableCollectionId) };
    if (isColor) {
      if (typeof val !== 'object') continue;
      const have = rgb(toHex(val));
      const d = Math.max(...have.map((c, i) => Math.abs(c - want[i])));
      Object.assign(row, { value: toHex(val), distance: d });
      if (d === 0) exact.push(row); else if (d <= o.colorDistance) near.push(row);
    } else {
      if (typeof val !== 'number') continue;
      if (!/^(space|radius|app)\//.test(v.name)) continue; // spacing and radius only (protocol H-08)
      const d = Math.abs(val - value);
      Object.assign(row, { value: val, distance: d });
      if (d === 0) exact.push(row); else if (d <= o.numberDistance) near.push(row);
    }
  }
  near.sort((a, b) => a.distance - b.distance);
  if (missingMode.size > 0) return { error: 'no mode "' + o.mode + '" in ' + [...missingMode].join(', ') + ': pass { mode: \'<name>\' } (protocol §8.4)', mode: o.mode };
  return {
    mode: o.mode,
    kind: isColor ? 'color' : 'number', value, exact: exact.slice(0, o.limit), near: near.slice(0, o.limit),
    advice: exact.length ? 'use-existing' : near.length ? 'offer-near-first' : 'no-similar',
  };
};
