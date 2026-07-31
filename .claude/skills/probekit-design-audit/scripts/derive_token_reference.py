#!/usr/bin/env python3
"""
derive-token-reference -- read VELO's own design system and report what looks wrong.

Reads frontend/src/styles/variables.css (the system) and frontend/src (the screens),
emits a derived REFERENCE plus a QUESTIONS list.

It FLAGS, it does not BLESS. It never deletes, never merges, never rewrites a token,
and never encodes a flagged value as canonical. A human rules on every question.

THE READ-PATH RULE (this is why the script exists):
  A token is used if EITHER
    (a) var(--x) appears anywhere, OR
    (b) its NAME appears as a string, e.g. tok('--x') / getPropertyValue('--x').
  Path (b) is not optional. The 13 --velo-fog-* tokens have ZERO var() usages and are
  read by name through getComputedStyle in MobileLayout/UserShell/MasterShell. A
  var()-only counter calls them dead; acting on that deletes working layout code.

THE MIRROR RULE (the inverse trap, found PROMPT №436):
  Some tokens are WRITTEN at runtime by JS and never appear in variables.css:
  --velo-frozen-vh and --velo-vvh are set via setProperty() in
  useBackgroundStabilizer.ts and consumed as var(--velo-frozen-vh, 100lvh).
  They are "referenced but undefined" ONLY from the CSS file's point of view.
  They are not dangling. Reported separately as RUNTIME-DEFINED, not as broken.

THE MASK RULE (found PROMPT №436):
  #000 inside mask-image / -webkit-mask-image is an ALPHA CHANNEL, not a colour.
  A naive "hardcoded colour" probe raises CRITICALs on 20 of them and someone
  "fixing" them breaks the fog masks. Classified separately, never as a colour.

Usage: python derive_token_reference.py [--json]
Run from the repo root.
"""
import io, json, os, re, sys
from collections import defaultdict

TOKENS_CSS = 'frontend/src/styles/variables.css'
SRC = 'frontend/src'
SEP = chr(92)

# ---------------------------------------------------------------- read the system
def strip_css_comments(t):
    return re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), t, flags=re.S)

def parse_tokens(path):
    """--name: value;  -> {name: {value, line}}. Comments stripped so commented-out
    tokens are NOT counted as defined."""
    raw = io.open(path, encoding='utf-8').read()
    clean = strip_css_comments(raw)
    out = {}
    for m in re.finditer(r'(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);', clean):
        name, val = m.group(1), ' '.join(m.group(2).split())
        out[name] = {'value': val, 'line': clean[:m.start()].count('\n') + 1}
    return out, raw

def resolve(value, tokens, seen=None):
    """Follow var(--a) chains inside the token file so duplicates compare by the
    value that actually lands, not by the alias spelling."""
    seen = seen or set()
    m = re.fullmatch(r'var\((--[A-Za-z0-9_-]+)\)', value.strip())
    if not m:
        return value
    ref = m.group(1)
    if ref in seen or ref not in tokens:
        return value
    return resolve(tokens[ref]['value'], tokens, seen | {ref})

# ---------------------------------------------------------------- read the screens
def source_files():
    for dp, _, fs in os.walk(SRC):
        for f in fs:
            if f.endswith(('.vue', '.ts', '.js', '.css', '.html', '.svg')):
                yield os.path.join(dp, f).replace(SEP, '/')

def scan_usage(tokens):
    var_use = defaultdict(list)     # path (a): var(--x)
    name_use = defaultdict(list)    # path (b): '--x' as a string
    referenced = set()
    token_use = defaultdict(list)   # path (c): consumed by ANOTHER TOKEN
    for p in source_files():
        t = io.open(p, encoding='utf-8').read()
        if p.endswith('variables.css'):
            # THE ALIAS RULE (PROMPT №437): variables.css references its OWN tokens
            # 10 times -- --velo-motion-* are aliases of --velo-duration-*, and
            # --velo-effect-focus consumes --velo-blue-500. Skipping this file (as
            # this script did until now) reports those sources as ZERO-USE. Deleting
            # one on that advice breaks the token that aliases it. Counted, and kept
            # SEPARATE: "consumed only by another token" is its own category, because
            # if the alias is itself dead the whole chain may be dead together.
            clean = strip_css_comments(t)
            for m in re.finditer(r'var\(\s*(--[A-Za-z0-9_-]+)', clean):
                token_use[m.group(1)].append(p)
                referenced.add(m.group(1))
            continue
        for m in re.finditer(r'var\(\s*(--[A-Za-z0-9_-]+)', t):
            var_use[m.group(1)].append(p)
            referenced.add(m.group(1))
        for m in re.finditer(r'[\'"](--[A-Za-z0-9_-]+)[\'"]', t):
            name_use[m.group(1)].append(p)
            referenced.add(m.group(1))
    return var_use, name_use, referenced, token_use

def px_literals():
    """Dimensional bypass: NNpx written inline in .vue, outside comments."""
    hits = 0
    for p in source_files():
        if not p.endswith('.vue'):
            continue
        t = strip_css_comments(io.open(p, encoding='utf-8').read())
        t = re.sub(r'<!--.*?-->', '', t, flags=re.S)
        hits += len(re.findall(r'(?<![\w-])\d+px', t))
    return hits

def hex_in_css(tokens):
    """Chromatic bypass: raw hex in .vue <style>, outside comments.

    Split into real colours vs mask alpha channels -- see THE MASK RULE."""
    hits = []
    masks = []
    for p in source_files():
        if not p.endswith('.vue'):
            continue
        raw = io.open(p, encoding='utf-8').read()
        m = re.search(r'<style[^>]*>(.*?)</style>', raw, flags=re.S)
        if not m:
            continue
        block = strip_css_comments(m.group(1))
        for h in re.finditer(r'#[0-9a-fA-F]{3,8}\b', block):
            # THE MASK RULE: #000 inside a mask gradient is an alpha channel, not
            # a colour. Look back far enough to catch a multi-line gradient.
            ctx = block[max(0, h.start() - 300):h.end()]
            decl = ctx.rsplit(';', 1)[-1]
            if 'mask-image' in decl or 'mask:' in decl:
                masks.append((p, h.group(0)))
            else:
                hits.append((p, h.group(0)))
    return hits, masks

# ---------------------------------------------------------------- analyse
def main():
    tokens, raw = parse_tokens(TOKENS_CSS)
    var_use, name_use, referenced, token_use = scan_usage(tokens)
    resolved = {n: resolve(d['value'], tokens) for n, d in tokens.items()}

    def uses(n):
        # All THREE paths. Missing any one of them produces a confident lie.
        return len(var_use.get(n, [])) + len(name_use.get(n, [])) + len(token_use.get(n, []))

    def consumers(n):
        return sorted({f for f in var_use.get(n, []) + name_use.get(n, []) + token_use.get(n, [])})

    # duplicates by RESOLVED value
    by_val = defaultdict(list)
    for n, v in resolved.items():
        by_val[v.lower()].append(n)
    dupes = {v: sorted(ns) for v, ns in by_val.items() if len(ns) > 1}

    zero = sorted(n for n in tokens if uses(n) == 0)
    alias_only = sorted(n for n in tokens
                        if token_use.get(n) and not var_use.get(n) and not name_use.get(n))
    single = sorted(n for n in tokens if uses(n) == 1)
    dangling = sorted(r for r in referenced if r not in tokens and r.startswith('--velo'))
    # THE MIRROR RULE: a token written via setProperty() is defined, just not here.
    runtime = set()
    for p in source_files():
        t_ = io.open(p, encoding='utf-8').read()
        for m in re.finditer(r'setProperty\(\s*[\'"](--[A-Za-z0-9_-]+)[\'"]', t_):
            runtime.add(m.group(1))
    undefined = [r for r in dangling if r not in runtime]
    runtime = sorted(runtime & set(dangling))
    hex_hits, mask_hits = hex_in_css(tokens)
    name_only = sorted(n for n in tokens if not var_use.get(n) and name_use.get(n))

    # near-miss drift among px-valued tokens
    px = {}
    for n, v in resolved.items():
        m = re.fullmatch(r'(\d+)px', v.strip())
        if m:
            px[n] = int(m.group(1))
    near = []
    seen_pairs = set()
    for a, va in px.items():
        for b, vb in px.items():
            if a >= b or (a, b) in seen_pairs:
                continue
            if 0 < abs(va - vb) <= 2:
                seen_pairs.add((a, b))
                near.append((a, va, b, vb))

    report = {
        'tokens_defined': len(tokens),
        'tokens_used_any': sum(1 for n in tokens if uses(n) > 0),
        'zero_use': zero,
        'alias_only': {n: consumers(n) for n in alias_only},
        'consumers': {n: consumers(n) for n in tokens},
        'single_use': single,
        'name_only_reads': name_only,
        'undefined_but_referenced': undefined,
        'duplicate_groups': dupes,
        'near_miss_px': near,
        'px_literals_in_vue': px_literals(),
        'hex_in_vue_style': hex_hits,
        'mask_alpha_hex': mask_hits,
        'runtime_defined': runtime,
    }

    if '--json' in sys.argv:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return

    print('== DERIVED REFERENCE (read from variables.css -- not invented) ==')
    print('  tokens defined      : %d' % report['tokens_defined'])
    print('  used (either path)  : %d' % report['tokens_used_any'])
    print('  read BY NAME only   : %d  <- var()-only counters call these DEAD. They are not.'
          % len(name_only))
    for n in name_only:
        print('      %-28s %s' % (n, resolved[n]))
    print()
    print('== QUESTIONS (flagged, NOT decided) ==')
    print('  duplicate-value groups   : %d' % len(dupes))
    print('  zero-use tokens (all 3 paths): %d' % len(zero))
    print('  consumed ONLY by another token: %d  <- deleting these breaks their alias'
          % len(alias_only))
    for n in alias_only:
        print('      %-28s <- %s' % (n, ', '.join(x.split('/')[-1] for x in consumers(n))))
    print('  single-use tokens        : %d' % len(single))
    print('  RUNTIME-defined (setProperty, not dangling): %d  %s' % (len(runtime), runtime or ''))
    print('  genuinely undefined      : %d  %s' % (len(undefined), undefined or ''))
    print('  near-miss px pairs (<=2) : %d' % len(near))
    print('  raw NNpx literals in .vue: %d' % report['px_literals_in_vue'])
    print('  raw hex in .vue <style>  : %d  (real colours)' % len(report['hex_in_vue_style']))
    print('  mask alpha #000 (NOT colours): %d' % len(report['mask_alpha_hex']))
    print()
    print('  -- duplicate groups, largest first --')
    for v, ns in sorted(dupes.items(), key=lambda kv: -len(kv[1])):
        print('     %-42s x%d  %s' % (v, len(ns), ', '.join(ns)))

if __name__ == '__main__':
    main()
