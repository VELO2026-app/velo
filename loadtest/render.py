# =============================================================================
# VELO load tests -- render the report of one run (BE-147)
# =============================================================================
#
# build(run_dir) -> run_dir/report.html: one self-contained file, in
# Russian, readable by someone who has never seen the code.
#
# ZERO TRUST, enforced here:
#   * every number comes from a file of THIS run in run_dir -- k6 summaries
#     (*-summary.json), the server probe (probe.json), run.py's meta.json;
#     the files sit next to the report and are linked from it;
#   * a value that is absent is shown as "нет данных", never as 0 or as a
#     default;
#   * the charts are SVG drawn right here from those files -- no JavaScript,
#     no third-party code, nothing loaded from the network.
#
# Python 3.9 standard library only.
# =============================================================================

from __future__ import annotations

import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

NO_DATA = "нет данных"
LIMIT_P95_MS = 500
LIMIT_ERRORS = 0.01

ACTION_LABELS = [
    ("open_app", "открыть приложение"),
    ("feed", "лента практик"),
    ("practice", "открыть практику"),
    ("diary", "Дневник"),
    ("profile", "профиль"),
    ("book", "записаться"),
    ("cancel", "отменить запись"),
    ("diary_write", "запись в Дневник"),
    ("bg_me", "фоновое обновление профиля"),
    ("bg_bell", "фоновый колокольчик"),
]
START_STEPS = [
    ("bookings_upcoming", "карточка ближайшей практики"),
    ("checkin", "чек-ин"),
    ("practice_get", "экран практики"),
    ("zoom_resolve", "ссылка на вход"),
    ("join", "вход"),
]
COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#4b5563", "#ca8a04"]


# -- Reading ---------------------------------------------------------------------


def _load(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _metric(summary, name: str, field: str):
    if not summary:
        return None
    m = summary.get("metrics", {}).get(name)
    if not m:
        return None
    return m.get("values", {}).get(field)


def _submetrics(summary, prefix: str) -> dict:
    """{tag value: values} for every 'prefix<value>}' sub-metric."""
    out = {}
    if not summary:
        return out
    for key, m in summary.get("metrics", {}).items():
        if key.startswith(prefix) and key.endswith("}"):
            out[key[len(prefix):-1]] = m.get("values", {})
    return out


# -- Formatting ------------------------------------------------------------------


def ms(value) -> str:
    if value is None:
        return NO_DATA
    return f"{value / 1000:.2f} с" if value >= 1000 else f"{value:.0f} мс"


def pct(value, digits: int = 2) -> str:
    return NO_DATA if value is None else f"{value * 100:.{digits}f} %"


def num(value) -> str:
    if value is None:
        return NO_DATA
    return f"{value:.0f}" if isinstance(value, float) else str(value)


def cores_word(n: int) -> str:
    """1 ядро, 2 ядра, 5 ядер."""
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} ядро"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return f"{n} ядра"
    return f"{n} ядер"


def esc(text) -> str:
    return html.escape(str(text))


def ts(epoch) -> str:
    if epoch is None:
        return NO_DATA
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


# -- SVG charts ------------------------------------------------------------------


def _nice_max(value: float) -> float:
    if value <= 0:
        return 1.0
    exp = 10 ** len(str(int(value)))
    for step in (0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0):
        if value <= exp * step:
            return exp * step
    return exp


def line_chart(series: list, x_labels: list | None = None, y_unit: str = "",
               hline: tuple | None = None, x_title: str = "", y_max: float | None = None,
               width: int = 760, height: int = 300) -> str:
    """series: [(name, [(x, y), ...])]; x numeric. Missing y (None) breaks the line."""
    pts = [(x, y) for _, s in series for x, y in s if y is not None]
    if not pts:
        return f'<p class="nodata">{NO_DATA} для графика</p>'
    left, right, top, bottom = 64, 16, 16, 44
    xs = [x for x, _ in pts]
    x0, x1 = min(xs), max(xs)
    if x1 == x0:
        x1 = x0 + 1
    top_y = y_max if y_max is not None else _nice_max(max([y for _, y in pts] + ([hline[0]] if hline else [])) * 1.05)
    pw, ph = width - left - right, height - top - bottom

    def px(x):
        return left + (x - x0) / (x1 - x0) * pw

    def py(y):
        return top + ph - min(y, top_y) / top_y * ph

    out = [f'<svg viewBox="0 0 {width} {height}" class="chart" role="img">']
    for i in range(5):
        v = top_y * i / 4
        y = py(v)
        out.append(f'<line x1="{left}" y1="{y:.1f}" x2="{width - right}" y2="{y:.1f}" class="grid"/>')
        out.append(f'<text x="{left - 6}" y="{y + 4:.1f}" class="axis" text-anchor="end">{esc(_fmt_axis(v))}{esc(y_unit)}</text>')
    if x_labels:
        for x, label in x_labels:
            out.append(f'<text x="{px(x):.1f}" y="{height - bottom + 16}" class="axis" text-anchor="middle">{esc(label)}</text>')
    if x_title:
        out.append(f'<text x="{left + pw / 2:.1f}" y="{height - 6}" class="axis" text-anchor="middle">{esc(x_title)}</text>')
    if hline:
        y = py(hline[0])
        out.append(f'<line x1="{left}" y1="{y:.1f}" x2="{width - right}" y2="{y:.1f}" class="limit"/>')
        out.append(f'<text x="{width - right - 4}" y="{y - 5:.1f}" class="limit-label" text-anchor="end">{esc(hline[1])}</text>')
    for i, (_name, s) in enumerate(series):
        color = COLORS[i % len(COLORS)]
        segment: list = []
        segments = []
        for x, y in s:
            if y is None:
                if segment:
                    segments.append(segment)
                segment = []
            else:
                segment.append((x, y))
        if segment:
            segments.append(segment)
        for seg in segments:
            path = " ".join(f"{px(x):.1f},{py(y):.1f}" for x, y in seg)
            out.append(f'<polyline points="{path}" fill="none" stroke="{color}" stroke-width="2"/>')
            for x, y in seg if len(seg) <= 40 else []:
                out.append(f'<circle cx="{px(x):.1f}" cy="{py(y):.1f}" r="3" fill="{color}"/>')
    legend_x = left + 8
    for i, (name, _) in enumerate(series):
        color = COLORS[i % len(COLORS)]
        out.append(f'<rect x="{legend_x}" y="{top + 4 + i * 16}" width="10" height="10" fill="{color}"/>')
        out.append(f'<text x="{legend_x + 14}" y="{top + 13 + i * 16}" class="legend">{esc(name)}</text>')
    out.append("</svg>")
    return "".join(out)


def bar_chart(groups: list, series_names: list, y_unit: str = "", hline: tuple | None = None,
              width: int = 760, height: int = 320) -> str:
    """groups: [(label, [value per series])]; a None value draws no bar."""
    values = [v for _, vs in groups for v in vs if v is not None]
    if not values:
        return f'<p class="nodata">{NO_DATA} для графика</p>'
    left, right, top, bottom = 64, 16, 28, 84
    top_y = _nice_max(max(values + ([hline[0]] if hline else [])) * 1.05)
    pw, ph = width - left - right, height - top - bottom
    out = [f'<svg viewBox="0 0 {width} {height}" class="chart" role="img">']
    for i in range(5):
        v = top_y * i / 4
        y = top + ph - v / top_y * ph
        out.append(f'<line x1="{left}" y1="{y:.1f}" x2="{width - right}" y2="{y:.1f}" class="grid"/>')
        out.append(f'<text x="{left - 6}" y="{y + 4:.1f}" class="axis" text-anchor="end">{esc(_fmt_axis(v))}{esc(y_unit)}</text>')
    slot = pw / max(1, len(groups))
    bw = slot * 0.7 / max(1, len(series_names))
    for gi, (label, vs) in enumerate(groups):
        gx = left + gi * slot + slot * 0.15
        for si, v in enumerate(vs):
            if v is None:
                continue
            h = min(v, top_y) / top_y * ph
            out.append(f'<rect x="{gx + si * bw:.1f}" y="{top + ph - h:.1f}" width="{bw - 2:.1f}" '
                       f'height="{h:.1f}" fill="{COLORS[si % len(COLORS)]}"/>')
        cx = left + gi * slot + slot / 2
        out.append(f'<text transform="translate({cx:.1f},{top + ph + 12}) rotate(30)" class="axis">{esc(label)}</text>')
    if hline:
        y = top + ph - hline[0] / top_y * ph
        out.append(f'<line x1="{left}" y1="{y:.1f}" x2="{width - right}" y2="{y:.1f}" class="limit"/>')
        out.append(f'<text x="{width - right - 4}" y="{y - 5:.1f}" class="limit-label" text-anchor="end">{esc(hline[1])}</text>')
    for i, name in enumerate(series_names):
        out.append(f'<rect x="{left + 8 + i * 120}" y="6" width="10" height="10" fill="{COLORS[i % len(COLORS)]}"/>')
        out.append(f'<text x="{left + 22 + i * 120}" y="15" class="legend">{esc(name)}</text>')
    out.append("</svg>")
    return "".join(out)


def _fmt_axis(v: float) -> str:
    if v >= 1000:
        return f"{v / 1000:g}k" if v % 1000 else f"{int(v / 1000)}k"
    return f"{v:g}" if v != int(v) else str(int(v))


# -- Server samples --------------------------------------------------------------

_UNITS = {"b": 1, "kib": 1024, "mib": 1024 ** 2, "gib": 1024 ** 3, "tib": 1024 ** 4,
          "kb": 1000, "mb": 1000 ** 2, "gb": 1000 ** 3, "tb": 1000 ** 4}


def _bytes(text: str):
    m = re.match(r"\s*([\d.]+)\s*([A-Za-z]+)", text or "")
    if not m:
        return None
    unit = _UNITS.get(m.group(2).lower())
    return None if unit is None else float(m.group(1)) * unit


def _cpu(text: str):
    try:
        return float((text or "").rstrip("%"))
    except ValueError:
        return None


def server_series(probe, window):
    """Per container: [(t, cpu %, memory bytes)] inside the window (epoch s)."""
    out: dict = {}
    if not probe:
        return out
    lo, hi = window if window else (None, None)
    for s in probe.get("stats", []):
        t = s.get("t")
        if lo is not None and (t < lo or t > hi):
            continue
        c = s.get("c", {})
        out.setdefault(c.get("Name", "?"), []).append(
            (t, _cpu(c.get("CPUPerc")), _bytes((c.get("MemUsage") or "").split("/")[0])))
    return out


def pg_series(probe, window):
    if not probe:
        return []
    lo, hi = window if window else (None, None)
    return [(p["t"], p["pg"].get("total")) for p in probe.get("pg", [])
            if lo is None or lo <= p["t"] <= hi]


# -- The report ------------------------------------------------------------------


def build(run_dir: Path) -> Path:
    run_dir = Path(run_dir)
    meta = _load(run_dir / "meta.json") or {}
    probe = _load(run_dir / "probe.json")
    summaries = {name: _load(run_dir / f"{name}-summary.json")
                 for name in ("01-break", "02-steady", "03a-start-prepare", "03b-start-burst",
                              "04-race", "05-hour")}
    full = meta.get("mode") == "full"
    tests = meta.get("tests", {})

    def window(name):
        t = tests.get(name)
        return (t["started"], t["finished"]) if t else None

    parts = []
    head = _head(meta, probe, summaries)
    s1, h1 = _section_break(summaries["01-break"], meta)
    s2, h2 = _section_speed(summaries["02-steady"], full, meta)
    s3, h3 = _section_start(summaries["03b-start-burst"])
    s4, h4 = _section_race(summaries["04-race"], meta.get("race_check"), probe)
    s5, h5 = _section_hour(summaries["05-hour"], full, probe, window("05-hour"), meta)
    s6, h6 = _section_headroom(probe, window("01-break"), meta)
    parts.append(head)
    parts.append(_summary_table([
        ("Сколько людей выдержит?", h1, "#q1"),
        ("Насколько быстро?", h2, "#q2"),
        ("Не сломается ли в пик?", h3, "#q3"),
        ("Данные не поплывут?", h4, "#q4"),
        ("Стабильно ли долго?", h5, "#q5"),
        ("Сколько запаса?", h6, "#q6"),
    ]))
    parts += [s1, s2, s3, s4, s5, s6, _assumptions(meta), _raw_files(run_dir)]
    doc = _page(f"Нагрузочный тест VELO — прогон {meta.get('run_id', '')}", "\n".join(parts))
    path = run_dir / "report.html"
    path.write_text(doc, encoding="utf-8")
    return path


def _head(meta, probe, summaries) -> str:
    static = probe or meta.get("server_check") or {}
    code = static.get("code") or {}
    velo = code.get("velo") or {}
    comms = code.get("comms") or {}
    server = static.get("server") or {}
    mem = server.get("mem_total_kb")
    floors = []
    for name, s in summaries.items():
        med = _metric(s, "http_req_duration{action:health}", "med")
        p95 = _metric(s, "http_req_duration{action:health}", "p(95)")
        if med is not None:
            floors.append(f"{esc(name)}: медиана {ms(med)}, p95 {ms(p95)}")
    started = [t["started"] for t in meta.get("tests", {}).values()]
    finished = [t["finished"] for t in meta.get("tests", {}).values()]
    client = meta.get("client", {})
    rows = [
        ("Код на сервере (VELO)", f"{velo.get('commit', NO_DATA)} · ветка {velo.get('branch', NO_DATA)} · {velo.get('date', NO_DATA)}"),
        ("Код сервиса уведомлений (comms)", f"{comms.get('commit', NO_DATA)} · ветка {comms.get('branch', NO_DATA)}" if comms else NO_DATA),
        ("Сервер", f"роль {static.get('role', NO_DATA)}, ядер: {server.get('cpus', NO_DATA)}, "
                   f"память: {f'{mem / 1024 / 1024:.1f} ГиБ' if mem else NO_DATA}, Docker {server.get('docker', NO_DATA)}"),
        ("Адрес", meta.get("base_url", NO_DATA)),
        ("Генератор нагрузки", f"{client.get('system', '')} {client.get('release', '')} {client.get('machine', '')}, "
                               f"k6 {meta.get('k6', NO_DATA)}, Python {client.get('python', '')}"),
        ("Режим", "полный (--full)" if meta.get("mode") == "full" else "быстрый (--quick)"),
        ("Время", f"{ts(min(started)) if started else NO_DATA} — {ts(max(finished)) if finished else NO_DATA}"),
        ("Пол сети (GET /health перед каждым тестом)", "<br>".join(floors) if floors else NO_DATA),
    ]
    body = "".join(f"<tr><th>{esc(k)}</th><td>{v if k.startswith('Пол') else esc(v)}</td></tr>" for k, v in rows)
    return (f"<h1>Нагрузочный тест VELO</h1><p class='lead'>Прогон {esc(meta.get('run_id', ''))}. "
            "Все цифры ниже получены в этом прогоне; файлы с исходными данными лежат рядом с отчётом.</p>"
            f"<h2>Что и где тестировалось</h2><table class='kv'>{body}</table>")


def _summary_table(rows) -> str:
    body = "".join(f"<tr><td><a href='{a}'>{esc(q)}</a></td><td class='big'>{esc(h)}</td></tr>" for q, h, a in rows)
    return f"<h2>Главное</h2><table class='summary'>{body}</table>"


def _section(anchor: str, title: str, headline: str, meaning: str, body: str) -> str:
    return (f"<section id='{anchor}'><h2>{esc(title)}</h2><p class='headline'>{esc(headline)}</p>"
            f"<p class='meaning'>{esc(meaning)}</p>{body}</section>")


def _absent(anchor: str, title: str, why: str):
    return _section(anchor, title, "Не измерялось в этом прогоне", why, ""), "не измерялось в этом прогоне"


def _section_break(s, meta):
    title = "1. Сколько людей выдержит — излом"
    if not s:
        return _absent("q1", title, "Сводки теста 1 нет.")
    levels = sorted(int(k[3:]) for k in _submetrics(s, "http_req_duration{stage:") if k.startswith("vus"))
    rows, p95s, errs = [], [], []
    bp = meta.get("break_point")
    for lv in levels:
        d = _submetrics(s, "http_req_duration{stage:").get(f"vus{lv}", {})
        e = _submetrics(s, "sys_errors{stage:").get(f"vus{lv}", {})
        p95, med, rate, count = d.get("p(95)"), d.get("med"), e.get("rate"), d.get("count")
        if not count:
            continue
        ok = p95 is not None and p95 < LIMIT_P95_MS and rate is not None and rate < LIMIT_ERRORS
        rows.append(f"<tr><td>{lv}</td><td>{ms(med)}</td><td>{ms(p95)}</td><td>{pct(rate)}</td>"
                    f"<td>{num(count)}</td><td class='{'ok' if ok else 'bad'}'>{'норма' if ok else 'нарушение'}</td></tr>")
        p95s.append((lv, p95))
        errs.append((lv, None if rate is None else rate * 100))
    if bp is None:
        headline = "Ни одна ступень не уложилась в норму" if rows else NO_DATA
    elif bp == max(levels or [0]) and all("норма" in r for r in rows):
        headline = f"Не меньше {bp} одновременно активных учеников (верхняя ступень выдержана)"
    else:
        headline = f"{bp} одновременно активных учеников"
    x_labels = [(lv, str(lv)) for lv, _ in p95s]
    body = (line_chart([("p95 времени ответа", p95s)], x_labels, " мс", (LIMIT_P95_MS, "норма 500 мс"),
                       "одновременно активных учеников") +
            line_chart([("ошибки сервера", errs)], x_labels, " %", (LIMIT_ERRORS * 100, "норма 1 %"),
                       "одновременно активных учеников") +
            "<table><tr><th>учеников</th><th>медиана</th><th>p95</th><th>ошибки сервера</th>"
            f"<th>запросов</th><th>вердикт</th></tr>{''.join(rows)}</table>"
            "<p class='note'>Ступень длится 4,5 минуты: 30 с разгон, 60 с установление (не судится), 3 минуты замер. "
            "Нарушение — p95 больше 500 мс или ошибок сервера больше 1 %; тест останавливается на первой такой ступени.</p>")
    meaning = ("Столько учеников одновременно могут пользоваться приложением, пока 95 % ответов быстрее "
               "полсекунды и ошибок меньше 1 %.")
    return _section("q1", title, headline, meaning, body), headline


def _section_speed(s, full, meta):
    title = "2. Насколько быстро — рабочая нагрузка"
    if not full:
        return _absent("q2", title, "Тест 2 идёт только в режиме --full.")
    if not s:
        why = meta.get("steady_skipped") or "Сводки теста 2 нет."
        return _absent("q2", title, why)
    vus = meta.get("steady_vus")
    groups, rows = [], []
    for tag, label in ACTION_LABELS:
        v = s.get("metrics", {}).get(f"action_duration{{phase:steady,action:{tag}}}", {}).get("values", {})
        med, p95 = v.get("med"), v.get("p(95)")
        if v.get("count"):
            groups.append((label, [med, p95]))
            rows.append(f"<tr><td>{esc(label)}</td><td>{ms(med)}</td><td>{ms(p95)}</td><td>{num(v.get('count'))}</td></tr>")
    overall = _metric(s, "http_req_duration{phase:steady}", "med")
    overall95 = _metric(s, "http_req_duration{phase:steady}", "p(95)")
    headline = f"Типичный запрос — {ms(overall)} (медиана), 95 % быстрее {ms(overall95)}"
    body = (bar_chart(groups, ["медиана", "p95"], " мс", (LIMIT_P95_MS, "500 мс")) +
            "<table><tr><th>действие</th><th>медиана</th><th>p95</th><th>замеров</th></tr>" + "".join(rows) + "</table>"
            f"<p class='note'>{num(vus)} учеников (60 % излома этого прогона), 15 минут. Первая минута — разгон: "
            "ученики подключаются постепенно, эта минута в цифры раздела не входит.</p>")
    meaning = "Так быстро приложение отвечает на обычные действия при нагрузке с запасом до излома."
    return _section("q2", title, headline, meaning, body), headline


def _section_start(s):
    title = "3. Не сломается ли в пик — пик перед началом практики"
    if not s:
        return _absent("q3", title, "Сводки теста 3 нет.")
    buckets = _submetrics(s, "http_req_duration{bucket:")
    errs = _submetrics(s, "sys_errors{bucket:")
    p95s, erate, labels = [], [], []
    for b in sorted(buckets):
        if not buckets[b].get("count"):
            continue
        i = int(b[1:])
        p95s.append((i, buckets[b].get("p(95)")))
        erate.append((i, None if errs.get(b, {}).get("rate") is None else errs[b]["rate"] * 100))
        labels.append((i, f"{i * 10}–{i * 10 + 10} с"))
    rows = []
    names = _submetrics(s, "http_req_duration{name:")
    for tag, label in START_STEPS:
        v = names.get(tag, {})
        rows.append(f"<tr><td>{esc(label)}</td><td>{ms(v.get('med'))}</td><td>{ms(v.get('p(95)'))}</td></tr>")
    flows = _metric(s, "start_flow_ok", "count")
    sys_rate = _metric(s, "sys_errors", "rate")
    sys_count = _metric(s, "sys_errors", "passes")
    headline = (f"Полных цепочек: {num(flows)} из 300; ошибок сервера: {num(sys_count)}"
                if flows is not None else NO_DATA)
    body = (line_chart([("p95 времени ответа", p95s)], labels, " мс", (LIMIT_P95_MS, "500 мс"), "время от начала пика") +
            line_chart([("ошибки сервера", erate)], labels, " %", None, "время от начала пика") +
            "<table><tr><th>шаг</th><th>медиана</th><th>p95</th></tr>" + "".join(rows) + "</table>"
            f"<p class='note'>Доля ошибок сервера за весь пик: {pct(sys_rate)}. "
            "Сервер не привязан к моменту старта: чек-ин разрешён до начала практики, вход — в любой момент. "
            "Измерен всплеск 300 записанных учеников за одну минуту — в жизни он приходится на минуту перед началом.</p>")
    meaning = "Так система держит момент, когда все записавшиеся разом входят в практику."
    return _section("q3", title, headline, meaning, body), headline


def _section_race(s, db, probe):
    title = "4. Данные не поплывут — гонка за места"
    if not s:
        return _absent("q4", title, "Сводки теста 4 нет.")
    ok = _metric(s, "race_ok", "count")
    full = _metric(s, "race_full", "count")
    other = _metric(s, "race_other", "count")
    sys_count = _metric(s, "sys_errors", "passes")
    api_after = _metric(s, "race_participants_after", "value")
    skew = _metric(s, "race_start_skew", "p(95)")
    db = db or {}
    before = (probe or {}).get("before") or {}
    after = (probe or {}).get("after") or {}
    dl = None
    if before.get("deadlocks") is not None and after.get("deadlocks") is not None:
        dl = after["deadlocks"] - before["deadlocks"]
    rows = [
        ("успешных броней", "20", num(ok), num(db.get("active_bookings"))),
        ("штатный отказ «мест нет»", "480", num(full), "—"),
        ("прочие ответы", "0", num(other), "—"),
        ("разных учеников среди броней", "20", "—", num(db.get("distinct_students"))),
        ("всего строк броней", "20", "—", num(db.get("all_booking_rows"))),
        ("покупок", "20", "—", num(db.get("purchases"))),
        ("участников по данным практики", "20", num(api_after), num(db.get("current_participants"))),
        ("ошибок сервера (5xx, таймауты)", "0", num(sys_count), "—"),
        ("новых дедлоков Postgres за весь прогон", "0", "—", num(dl)),
    ]
    table = "".join(f"<tr><td>{esc(a)}</td><td>{b}</td><td>{esc(c)}</td><td>{esc(d)}</td></tr>" for a, b, c, d in rows)
    dupes = None
    if db.get("active_bookings") is not None and db.get("distinct_students") is not None:
        dupes = db["active_bookings"] - db["distinct_students"]
    headline = (f"{num(db.get('active_bookings'))} броней на 20 мест, {num(dupes)} дублей, "
                f"{num(dl)} новых дедлоков")
    body = ("<table><tr><th></th><th>ожидание</th><th>по ответам API</th><th>по базе (сервер)</th></tr>"
            f"{table}</table><p class='note'>500 учеников отправили бронь почти одновременно: 95 % запросов "
            f"ушли в пределах {ms(skew)} от общего момента. Колонка «по базе» — ответ сервера "
            "(velo loadtest-probe race-check) сразу после теста, до отмены практики.</p>")
    meaning = "Когда мест меньше, чем желающих, система выдаёт ровно столько мест, сколько есть, и никого не записывает дважды."
    return _section("q4", title, headline, meaning, body), headline


def _section_hour(s, full, probe, window, meta):
    title = "5. Стабильно ли долго — час"
    if not full:
        return _absent("q5", title, "Тест 5 идёт только в режиме --full.")
    if not s:
        return _absent("q5", title, meta.get("steady_skipped") or "Сводки теста 5 нет.")
    minutes = _submetrics(s, "http_req_duration{minute:")
    errs = _submetrics(s, "sys_errors{minute:")
    p95s, erate, labels = [], [], []
    for m in sorted(minutes):
        if not minutes[m].get("count"):
            continue
        i = int(m[1:])
        p95s.append((i, minutes[m].get("p(95)")))
        erate.append((i, None if errs.get(m, {}).get("rate") is None else errs[m]["rate"] * 100))
        if i % 10 == 0:
            labels.append((i, f"{i} мин"))
    mem = []
    if window:
        series = server_series(probe, window)
        mem = [(name, [((t - window[0]) / 60, None if b is None else b / 1024 / 1024) for t, _, b in pts])
               for name, pts in sorted(series.items())
               if name in ("velo-app", "velo-postgres", "velo-redis", "comms-app")]
    steady = [y for x, y in p95s if x >= 1 and y is not None]
    headline = (f"p95 по минутам — от {ms(min(steady))} до {ms(max(steady))}" if steady else NO_DATA)
    body = (line_chart([("p95 времени ответа", p95s)], labels, " мс", (LIMIT_P95_MS, "500 мс"), "минута теста") +
            line_chart([("ошибки сервера", erate)], labels, " %", None, "минута теста") +
            "<h3>Память контейнеров за час</h3>" + line_chart(mem, None, " МиБ", None, "минута теста") +
            f"<p class='note'>{num(meta.get('steady_vus'))} учеников. Минута 0 — разгон, в цифру выше не входит.</p>")
    meaning = "Ровные линии — признак того, что за час не копятся задержки и память."
    return _section("q5", title, headline, meaning, body), headline


def _section_headroom(probe, window, meta):
    title = "6. Сколько запаса — сервер на пике теста 1"
    if not probe or not window:
        return _absent("q6", title, "Замеров сервера за время теста 1 нет.")
    cores = ((probe.get("server") or {}).get("cpus")) or None
    mem_total = ((probe.get("server") or {}).get("mem_total_kb")) or None
    series = server_series(probe, window)
    if not series:
        return _absent("q6", title, "Сервер не прислал ни одного замера за время теста 1.")
    cpu_lines, peak_rows = [], []
    totals: dict = {}
    for name, pts in sorted(series.items()):
        cpu_lines.append((name, [((t - window[0]) / 60, c) for t, c, _ in pts]))
        cpus = [c for _, c, _ in pts if c is not None]
        mems = [b for _, _, b in pts if b is not None]
        peak_rows.append(f"<tr><td>{esc(name)}</td><td>{f'{max(cpus):.0f} %' if cpus else NO_DATA}</td>"
                         f"<td>{f'{max(mems) / 1024 / 1024:.0f} МиБ' if mems else NO_DATA}</td></tr>")
        for t, c, _ in pts:
            if c is not None:
                totals[t] = totals.get(t, 0.0) + c
    peak_total = max(totals.values()) if totals else None
    pg = pg_series(probe, window)
    pg_peak = max([v for _, v in pg if v is not None], default=None)
    max_conn = (probe.get("before") or {}).get("max_connections")
    capacity = cores * 100 if cores else None
    if peak_total is not None and capacity:
        headline = (f"На пике CPU {peak_total:.0f} % из {capacity} % ({cores_word(cores)}) — "
                    f"запас {max(0, capacity - peak_total):.0f} %")
    else:
        headline = NO_DATA
    body = (line_chart(cpu_lines, None, " %", (capacity, f"{cores_word(cores)} = {capacity} %") if capacity else None,
                       "минута теста 1") +
            "<table><tr><th>контейнер</th><th>пик CPU</th><th>пик памяти</th></tr>" + "".join(peak_rows) + "</table>"
            f"<table class='kv'><tr><th>сумма CPU всех контейнеров на пике</th><td>{f'{peak_total:.0f} %' if peak_total is not None else NO_DATA}</td></tr>"
            f"<tr><th>память сервера</th><td>{f'{mem_total / 1024 / 1024:.1f} ГиБ' if mem_total else NO_DATA}</td></tr>"
            f"<tr><th>соединений Postgres на пике / максимум</th><td>{num(pg_peak)} / {num(max_conn)}</td></tr></table>"
            "<p class='note'>Docker считает CPU от одного ядра: 100 % — одно ядро целиком. "
            "Замер раз в несколько секунд, командой velo loadtest-probe на сервере.</p>")
    meaning = "Насколько сервер был загружен в момент излома — и какой ресурс кончился первым."
    return _section("q6", title, headline, meaning, body), headline


def _assumptions(meta) -> str:
    durations = sorted(meta.get("login_durations") or [])
    if durations:
        med = durations[len(durations) // 2] * 1000
        p95 = durations[max(0, int(len(durations) * 0.95) - 1)] * 1000
        login = f"в этом прогоне {len(durations)} входов: медиана {ms(med)}, p95 {ms(p95)}"
    else:
        login = "в этом прогоне все ученики вошли раньше (сессии сохранены), входов не было — " + NO_DATA
    items = [
        "«Одновременно активный» ученик — с открытым приложением, совершает действие раз в 10–30 секунд и в фоне "
        "получает обновления (профиль — раз в 30 с, колокольчик — раз в 60 с), как настоящее приложение. "
        "Сколько зарегистрированных соответствует одному активному — допущение, а не измерение.",
        f"Настоящее приложение при каждом открытии заново входит через Telegram. Здесь ученики вошли заранее: "
        f"сервер ограничивает частоту входов с одного адреса, а генератор один. Стоимость входа — {login}.",
        "Уведомления не выключались: бронь, чек-ин и отмена порождают уведомления; сервис уведомлений пытается "
        "доставить их несуществующим ученикам в Telegram и получает быстрые отказы.",
        "Все практики теста бесплатные: платёжный путь не нагружался, записи учёта с нулевыми суммами создаются.",
        "Zoom на сервере dev отключён: встречи создаются заглушкой, без внешних вызовов.",
        "Время ответа измерено на генераторе и включает путь по интернету — см. «Пол сети».",
        "Окна тестов на графиках сервера — по часам генератора; часы генератора и сервера не сверяются.",
        "Практики теста созданы в начале прогона от имени посевных мастеров и отменены после него.",
    ]
    return "<section><h2>Допущения</h2><ol>" + "".join(f"<li>{esc(i)}</li>" for i in items) + "</ol></section>"


def _raw_files(run_dir: Path) -> str:
    files = sorted(p.name for p in run_dir.iterdir() if p.is_file() and p.name != "report.html")
    links = "".join(f"<li><a href='{esc(n)}'>{esc(n)}</a></li>" for n in files)
    return ("<section><h2>Исходные данные</h2><p>Файлы этого прогона, из которых построен отчёт: сводки k6 "
            "(*-summary.json), временные ряды (*.csv.gz), ответ сервера (probe.json), практики прогона "
            f"(practices.json), ход прогона (meta.json, *.log).</p><ul>{links}</ul></section>")


def _page(title: str, body: str) -> str:
    css = """
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:900px;margin:32px auto;
padding:0 16px;color:#111827;line-height:1.5}
h1{font-size:28px;margin-bottom:4px}h2{margin-top:40px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}
th,td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top}
table.kv th{width:38%;color:#4b5563;font-weight:500}
table.summary td.big,p.headline{font-size:20px;font-weight:600}
p.meaning{color:#374151}p.note{color:#6b7280;font-size:13px}p.lead{color:#4b5563}
td.ok{color:#15803d}td.bad{color:#b91c1c}.nodata{color:#9ca3af;font-style:italic}
svg.chart{width:100%;height:auto;margin:8px 0;background:#fafafa;border:1px solid #f3f4f6}
.grid{stroke:#e5e7eb}.axis{font-size:11px;fill:#6b7280}.legend{font-size:12px;fill:#111827}
.limit{stroke:#b91c1c;stroke-dasharray:6 4}.limit-label{font-size:11px;fill:#b91c1c}
a{color:#2563eb}
"""
    return (f"<!DOCTYPE html><html lang='ru'><head><meta charset='utf-8'>"
            f"<meta name='viewport' content='width=device-width, initial-scale=1'><title>{esc(title)}</title>"
            f"<style>{css}</style></head><body>{body}</body></html>")
