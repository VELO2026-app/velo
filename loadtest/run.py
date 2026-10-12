#!/usr/bin/env python3
# =============================================================================
# VELO load tests -- one command on the customer's Mac (BE-147)
# =============================================================================
#
#   python3 loadtest/run.py            # --quick: tests 3, 4, 1 + server
#   python3 loadtest/run.py --full     # + test 2 (15 min) and test 5 (60 min)
#
# ZERO TRUST. The customer runs this himself, against the dev stand, and the
# report is built from THIS run only: no number in it is a default, a
# constant or anything we measured before. What the server says comes from
# `ssh <host> velo loadtest-probe ...` -- the only thing this program runs on
# the server -- and the code version tested is the commit that probe reads
# from the server's own checkout.
#
# What happens, in order (each step stops the run with a plain sentence on
# failure, and no "✓" is printed unless the report was written):
#   1. k6 v2.3.0: downloaded into loadtest/.bin/ if absent, sha256 checked
#      against the official checksums.txt -- no sudo, no brew.
#   2. Secrets: the bot token from BOT_TOKEN or a hidden prompt; the ssh
#      address from --ssh / VELO_SSH or a prompt. Neither is ever printed,
#      logged or written anywhere.
#   3. The server answers `velo loadtest-probe check` (test role, versions).
#   4. Warmup: the load students log in (cached in .state/sessions.json, only
#      missing or expired ones log in again), at ~86 logins/min -- the API's
#      limit is 100/min per address.
#   5. This run's practices are created through the API by the seeded
#      masters (feed, race, start) -- and cancelled after the run, also on
#      failure or Ctrl+C.
#   6. `velo loadtest-probe start`, the tests, `velo loadtest-probe stop`.
#   7. report.html in results/<date-time>/, opened in the browser.
#
# Python 3.9+ standard library only (the python3 of macOS Command Line
# Tools is 3.9): no pip, no third-party code.
# =============================================================================

from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import io
import json
import os
import platform
import random
import re
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))

import render  # noqa: E402  (loadtest/render.py, next to this file)

K6_VERSION = "v2.3.0"
K6_RELEASES = f"https://github.com/grafana/k6/releases/download/{K6_VERSION}"
K6_DIR = HERE / ".bin" / K6_VERSION
STATE_DIR = HERE / ".state"
SESSIONS_PATH = STATE_DIR / "sessions.json"
RESULTS_ROOT = HERE / "results"
PROFILE_PATH = REPO / "backend" / "scripts" / "seed_profiles" / "11102026-loadtest.json"
PROFILE_NAME = "11102026-loadtest"

PROBE_MARK = "velo-loadtest-probe"
PROBE_FORMAT = 1
SESSIONS_FORMAT = 1
PRACTICES_FORMAT = 1

LOGIN_INTERVAL_S = 0.7  # ~86/min: under the API's 100/min per source address
REQUEST_TIMEOUT_S = 60

# The masters of the seed profile and what each may publish (its confirmed
# methods). Keys and telegram ids come from the profile file; directions and
# styles must match the methods the profile gives that master.
FEED_MASTERS = [
    ("med", "meditation", ["presence", "silence"]),
    ("yoga", "yoga", ["hatha", "vinyasa", "nidra"]),
    ("soma", "somatic", [None]),
    ("brth", "breathwork", [None]),
    ("snd", "sound_healing", [None]),
    ("narr", "narrative", [None]),
    ("circ", "circles", ["womens", "sharing"]),
    ("move", "movement", [None]),
    ("art", "art", [None]),
    ("tant", "tantra", [None]),
]
ARENA_MASTER = ("arena", "meditation", "presence")
FEED_PER_MASTER = 10
START_LEAD_MIN = 15      # the "start" practice begins this long after creation
START_DURATION_MIN = 480  # long enough to stay cancellable for a --full run
RACE_LEAD_MIN = 180


class Refusal(Exception):
    """A stop with a sentence for the customer -- never a traceback."""


def say(text: str) -> None:
    print(text, flush=True)


def step(text: str) -> None:
    say(f"\n== {text}")


# -- The scenarios' own constants (one source: lib/config.js, 01-break.js) ----


def _js_text(name: str) -> str:
    return (HERE / name).read_text(encoding="utf-8")


def js_constants() -> dict:
    """Read the shared constants from the JS side instead of copying them."""
    cfg = _js_text("lib/config.js")
    allowed = re.search(r"ALLOWED_BASE_URLS = \[([^\]]*)\]", cfg)
    tid_min = re.search(r"LOAD_TID_MIN = (\d+);", cfg)
    tid_max = re.search(r"LOAD_TID_MAX = (\d+);", cfg)
    start = re.search(r"START_COHORT = \{ offset: (\d+), size: (\d+) \};", cfg)
    race = re.search(r"RACE_COHORT = \{ offset: (\d+), size: (\d+) \};", cfg)
    seats = re.search(r"RACE_SEATS = (\d+);", cfg)
    levels = re.search(r"BREAK_LEVELS \|\| '([\d,]+)'", _js_text("01-break.js"))
    if not all((allowed, tid_min, tid_max, start, race, seats, levels)):
        raise Refusal("lib/config.js или 01-break.js не читаются -- клон репозитория повреждён.")
    return {
        "allowed": re.findall(r"'([^']+)'", allowed.group(1)),
        "tid_min": int(tid_min.group(1)),
        "tid_max": int(tid_max.group(1)),
        "start_cohort": (int(start.group(1)), int(start.group(2))),
        "race_cohort": (int(race.group(1)), int(race.group(2))),
        "race_seats": int(seats.group(1)),
        "break_levels": [int(v) for v in levels.group(1).split(",")],
    }


# -- k6 -----------------------------------------------------------------------


def _download(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=120) as resp:
            return resp.read()
    except urllib.error.URLError as exc:
        raise Refusal(f"Не удалось скачать {url}: {exc}") from exc


def ensure_k6() -> Path:
    """k6 v2.3.0 in loadtest/.bin/, downloaded and sha256-checked if absent."""
    system, machine = platform.system(), platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "amd64"
    if system == "Darwin":
        asset, inner = f"k6-{K6_VERSION}-macos-{arch}.zip", f"k6-{K6_VERSION}-macos-{arch}/k6"
    elif system == "Linux":
        asset, inner = f"k6-{K6_VERSION}-linux-{arch}.tar.gz", f"k6-{K6_VERSION}-linux-{arch}/k6"
    else:
        raise Refusal(f"Неподдерживаемая система: {system}. Тест запускается на macOS.")
    binary = K6_DIR / "k6"
    if not binary.exists():
        say(f"k6 {K6_VERSION} не найден в {K6_DIR} -- скачиваю с GitHub (grafana/k6).")
        sums = _download(f"{K6_RELEASES}/k6-{K6_VERSION}-checksums.txt").decode()
        expected = None
        for line in sums.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1] == asset:
                expected = parts[0]
        if expected is None:
            raise Refusal(f"В официальном checksums.txt нет строки для {asset}.")
        blob = _download(f"{K6_RELEASES}/{asset}")
        actual = hashlib.sha256(blob).hexdigest()
        if actual != expected:
            raise Refusal(
                f"Контрольная сумма {asset} не совпала (ожидалась {expected}, получена {actual}). "
                "Файл не установлен."
            )
        say(f"sha256 совпала с официальной: {actual}")
        K6_DIR.mkdir(parents=True, exist_ok=True)
        if asset.endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(blob)) as zf:
                data = zf.read(inner)
        else:
            with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
                member = tf.extractfile(inner)
                if member is None:
                    raise Refusal(f"В архиве {asset} нет {inner}.")
                data = member.read()
        tmp = binary.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.chmod(0o755)
        tmp.replace(binary)
    out = subprocess.run([str(binary), "version"], capture_output=True, text=True)
    if out.returncode != 0 or f"k6 {K6_VERSION}" not in out.stdout:
        raise Refusal(f"{binary} не отвечает как k6 {K6_VERSION}: {out.stdout.strip() or out.stderr.strip()}")
    return binary


# -- HTTP (control plane: logins, practices) -----------------------------------


class Api:
    def __init__(self, base_url: str) -> None:
        self.base = base_url

    def call(self, method: str, path: str, token: str | None = None, body: dict | None = None):
        """(status, parsed JSON or None, seconds). Never raises on HTTP status."""
        data = None
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
                status, raw = resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            status, raw = exc.code, exc.read()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise Refusal(f"Сервер {self.base} не ответил на {method} {path}: {exc}") from exc
        elapsed = time.perf_counter() - started
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = None
        return status, parsed, elapsed


def error_code(body) -> str:
    return body.get("error", "") if isinstance(body, dict) else ""


def build_init_data(telegram_id: int, bot_token: str) -> str:
    """Telegram WebApp initData, the algorithm auth/service.py verifies."""
    fields = {
        "auth_date": str(int(time.time())),
        "query_id": f"load{telegram_id}",
        "user": json.dumps(
            {"id": telegram_id, "first_name": "Load", "last_name": str(telegram_id),
             "language_code": "ru"},
            separators=(",", ":"),
        ),
    }
    check = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    digest = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    pairs = [f"{k}={urllib.parse.quote(fields[k], safe='')}" for k in sorted(fields)]
    return "&".join(pairs + [f"hash={digest}"])


class Logins:
    """Every login goes through here: one pace for the whole run."""

    def __init__(self, api: Api, bot_token: str) -> None:
        self.api = api
        self._token = bot_token
        self._last = 0.0
        self.durations: list = []

    def login(self, telegram_id: int):
        consecutive_429 = 0
        while True:
            wait = LOGIN_INTERVAL_S - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            status, body, elapsed = self.api.call(
                "POST", "/api/v1/auth/telegram",
                body={"init_data": build_init_data(telegram_id, self._token)},
            )
            if status == 200:
                self.durations.append(elapsed)
                return body
            if status == 429:
                consecutive_429 += 1
                if consecutive_429 >= 3:
                    raise Refusal("Сервер трижды подряд ответил 429 на вход (лимит 100 входов в минуту с адреса). "
                                  "Подождите несколько минут и запустите снова -- готовые сессии сохранены.")
                say("  лимит входов -- пауза 61 с")
                time.sleep(61)
                continue
            if status == 400 and error_code(body) == "bad_request":
                raise Refusal("Сервер не принял подпись входа: токен бота не тот, что у сервера dev.")
            raise Refusal(f"Вход {telegram_id} не удался: {status} {error_code(body)}")


# -- Students: the sessions cache ----------------------------------------------


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    tmp.replace(path)


def warmup(api: Api, logins: Logins, base_url: str, consts: dict, needed: int) -> dict:
    """Make sure `needed` load students have a live session. Returns stats."""
    lo, hi = consts["tid_min"], consts["tid_max"]
    if needed > hi - lo + 1:
        raise Refusal(f"Нужно {needed} учеников, а полоса {lo}..{hi} меньше.")
    cached: dict = {}
    if SESSIONS_PATH.exists():
        try:
            data = json.loads(SESSIONS_PATH.read_text(encoding="utf-8"))
        except ValueError:
            data = None
        if not data or data.get("format") != SESSIONS_FORMAT or data.get("base_url") != base_url:
            say("  файл сессий чужого формата или для другого сервера -- начинаю заново")
        else:
            for s in data.get("sessions", []):
                tid = s.get("telegram_id")
                if isinstance(tid, int) and lo <= tid <= hi and s.get("token"):
                    cached[tid] = s

    def check(entry):
        status, body, _ = api.call("GET", "/api/v1/users/me", token=entry["token"])
        return entry, status, body

    alive = {}
    if cached:
        say(f"  проверяю {len(cached)} сохранённых сессий")
        with ThreadPoolExecutor(max_workers=16) as pool:
            for entry, status, body in pool.map(check, list(cached.values())):
                if status == 200 and isinstance(body, dict) and body.get("telegram_id") == entry["telegram_id"]:
                    alive[entry["telegram_id"]] = entry
                elif status != 401:
                    raise Refusal(f"Проверка сессий: сервер ответил {status}. Ничего не изменено.")
    missing = [tid for tid in range(lo, lo + needed) if tid not in alive]
    say(f"  живых сессий: {len(alive)}, нужно войти ещё: {len(missing)}"
        + (f" (~{len(missing) * LOGIN_INTERVAL_S / 60:.0f} мин)" if missing else ""))

    def save():
        ordered = [alive[t] for t in sorted(alive)]
        _write_private(SESSIONS_PATH, json.dumps(
            {"format": SESSIONS_FORMAT, "base_url": base_url, "sessions": ordered}))

    for done, tid in enumerate(missing, 1):
        body = logins.login(tid)
        alive[tid] = {"telegram_id": tid, "token": body["session_token"], "user_id": body["user"]["id"]}
        if done % 50 == 0 or done == len(missing):
            save()
            say(f"  вошло {done} из {len(missing)}")
    if not missing:
        save()
    return {"cached": len(cached), "alive": len(alive) - len(missing), "logged_in": len(missing)}


# -- Masters and this run's practices ------------------------------------------


def profile_masters() -> dict:
    try:
        profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise Refusal(f"Не читается профиль посева {PROFILE_PATH}: {exc}") from exc
    return {m["key"]: m["telegram_id"] for m in profile.get("masters", [])}


class Practices:
    """Creates this run's practices and cancels every one of them after."""

    def __init__(self, api: Api, run_id: str) -> None:
        self.api = api
        self.run_id = run_id
        self.masters: dict = {}     # key -> session token
        self.created: list = []     # (id, master_key, kind)
        self.cancelled: set = set()

    def login_masters(self, logins: Logins) -> None:
        ids = profile_masters()
        for key in [m[0] for m in FEED_MASTERS] + [ARENA_MASTER[0]]:
            if key not in ids:
                raise Refusal(f"В профиле {PROFILE_NAME} нет мастера '{key}'.")
            body = logins.login(ids[key])
            if body.get("user", {}).get("role") != "master":
                raise Refusal(
                    f"Пользователь {ids[key]} не мастер. На сервере один раз: velo seed --profile {PROFILE_NAME}")
            self.masters[key] = body["session_token"]

    def _create(self, master: str, kind: str, title: str, direction: str, style,
                starts: datetime, duration: int, seats) -> dict:
        token = self.masters[master]
        body = {
            "practice_type": "live",
            "title": f"[load] {self.run_id} {title}",
            "description": "Практика нагрузочного теста. Будет отменена после прогона.",
            "scheduled_at": starts.isoformat(),
            "duration_minutes": duration,
            "timezone": "UTC",
            "max_participants": seats,
            "is_free": True,
            "price_cents": 0,
            "direction": direction,
            "difficulty": "beginner",
        }
        if style:
            body["style"] = style
        status, created, _ = self.api.call("POST", "/api/v1/practices", token=token, body=body)
        if status != 201:
            raise Refusal(f"Мастер '{master}' не смог создать практику: {status} {error_code(created)} "
                          f"{(created or {}).get('message', '')}")
        self.created.append((created["id"], master, kind))
        status, published, _ = self.api.call(
            "PATCH", f"/api/v1/practices/{created['id']}", token=token, body={"status": "scheduled"})
        if status != 200 or published.get("status") != "scheduled":
            raise Refusal(f"Практика не опубликовалась: {status} {error_code(published)}")
        return published

    def create_all(self, race_seats: int) -> dict:
        now = datetime.now(timezone.utc).replace(microsecond=0)
        feed = []
        for index, (key, direction, styles) in enumerate(FEED_MASTERS, 1):
            for n in range(FEED_PER_MASTER):
                starts = now + timedelta(days=1 + n % 7, hours=random.randint(0, 12))
                p = self._create(key, "feed", f"feed {index:02d}-{n + 1:02d}", direction,
                                 styles[n % len(styles)], starts, 60, None)
                feed.append({"id": p["id"], "title": p["title"]})
            say(f"  лента: {len(feed)} из {len(FEED_MASTERS) * FEED_PER_MASTER}")
        key, direction, style = ARENA_MASTER
        race = self._create(key, "race", "race", direction, style,
                            now + timedelta(minutes=RACE_LEAD_MIN), 60, race_seats)
        start = self._create(key, "start", "start", direction, style,
                             now + timedelta(minutes=START_LEAD_MIN), START_DURATION_MIN, None)
        return {
            "format": PRACTICES_FORMAT,
            "run_id": self.run_id,
            "feed": feed,
            "race": {"id": race["id"], "title": race["title"], "max_participants": race["max_participants"]},
            "start": {"id": start["id"], "title": start["title"], "scheduled_at": start["scheduled_at"]},
        }

    def cancel(self, kinds) -> list:
        """Cancel the created practices of these kinds; returns failures."""
        failures = []
        for pid, master, kind in self.created:
            if kind not in kinds or pid in self.cancelled:
                continue
            status, body, _ = self.api.call(
                "POST", f"/api/v1/practices/{pid}/cancel", token=self.masters.get(master), body={})
            if status == 200 or (status == 400 and "status" in (body or {}).get("message", "")):
                self.cancelled.add(pid)
            else:
                failures.append(f"{pid}: {status} {error_code(body)}")
        return failures

    def still_active(self) -> list:
        left = []
        for pid, master, _kind in self.created:
            status, body, _ = self.api.call("GET", f"/api/v1/practices/{pid}", token=self.masters.get(master))
            if status == 200 and body.get("status") in ("scheduled", "live", "draft"):
                left.append(f"{pid} ({body.get('status')})")
        return left


# -- The server probe over ssh ---------------------------------------------------


def probe(ssh_host: str, *args: str, raw_path: Path | None = None) -> dict:
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", ssh_host,
           "velo", "loadtest-probe", *args]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired as exc:
        raise Refusal(f"Сервер не ответил за 3 минуты на: velo loadtest-probe {' '.join(args)}") from exc
    try:
        data = json.loads(out.stdout.strip()) if out.stdout.strip() else None
    except ValueError:
        data = None
    if data is None and raw_path is not None and out.stdout:
        # The server already let go of what it collected (stop removes it):
        # keep its answer as it came, for whoever reads the run directory.
        raw_path.write_text(out.stdout, encoding="utf-8")
    if out.returncode == 255:
        raise Refusal(f"ssh {ssh_host} не пускает: {out.stderr.strip()[:300]}")
    if out.returncode != 0:
        raise Refusal(f"velo loadtest-probe {args[0]} отказал: {out.stderr.strip()[:300]}")
    if not isinstance(data, dict) or data.get("probe") != PROBE_MARK or data.get("format") != PROBE_FORMAT:
        raise Refusal("На сервере нет команды `velo loadtest-probe` (ответ -- не её JSON). "
                      "Сервер нужно обновить: velo update.")
    return data


# -- k6 runs -------------------------------------------------------------------


def run_k6(k6: Path, script: str, run_dir: Path, env_extra: dict, meta: dict) -> int:
    name = script[:-3]
    env = dict(os.environ)
    env.pop("BOT_TOKEN", None)  # k6 never sees the bot token
    env.update(env_extra)
    env["RESULTS_DIR"] = str(run_dir)
    log_path = run_dir / f"{name}.log"
    # k6 draws its progress on the customer's terminal as it is (a pipe would
    # turn the bar into a line per second); its own log lines -- warnings,
    # refusals -- also go to <name>.log in the run directory.
    cmd = [str(k6), "run", "--no-usage-report", "--log-output", f"file={log_path}",
           "--out", f"csv={run_dir / (name + '.csv.gz')}", script]
    say(f"  k6 run {script}")
    started = time.time()
    code = subprocess.run(cmd, cwd=HERE, env=env).returncode
    meta["tests"][name] = {"started": started, "finished": time.time(), "exit_code": code}
    if code not in (0, 99):
        tail = ""
        if log_path.exists():
            lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
            tail = "\n".join(lines[-5:])
        raise Refusal(f"k6 {script} завершился с кодом {code} (сбой, не результат). "
                      f"Журнал: {log_path}\n{tail}")
    return code


def break_point(run_dir: Path, levels: list):
    data = json.loads((run_dir / "01-break-summary.json").read_text(encoding="utf-8"))
    best = None
    for level in levels:
        d = data["metrics"].get(f"http_req_duration{{stage:vus{level}}}")
        e = data["metrics"].get(f"sys_errors{{stage:vus{level}}}")
        if not d or not d["values"].get("count"):
            break
        if d["values"]["p(95)"] < 500 and e and e["values"]["rate"] < 0.01:
            best = level
        else:
            break
    return best


# -- Main ----------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Нагрузочный тест VELO на сервере dev.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--quick", action="store_true", help="тесты 3, 4, 1 (по умолчанию, ~40 мин)")
    mode.add_argument("--full", action="store_true", help="плюс тест 2 (15 мин) и тест 5 (60 мин)")
    parser.add_argument("--ssh", help="адрес ssh сервера dev, например root@zxcvbnm.beer")
    args = parser.parse_args()
    full = bool(args.full)

    consts = js_constants()
    base_url = consts["allowed"][0]
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = RESULTS_ROOT / run_id
    meta: dict = {"run_id": run_id, "mode": "full" if full else "quick", "base_url": base_url,
                  "k6": K6_VERSION, "tests": {}, "client": {
                      "system": platform.system(), "release": platform.release(),
                      "machine": platform.machine(), "python": platform.python_version()}}

    step("k6")
    k6 = ensure_k6()
    say(f"k6 {K6_VERSION}: {k6}")

    step("Секреты")
    bot_token = os.environ.get("BOT_TOKEN", "").strip()
    if not bot_token:
        bot_token = getpass.getpass("Токен бота dev (ввод не отображается): ").strip()
    if not bot_token:
        raise Refusal("Токен бота не задан.")
    ssh_host = (args.ssh or os.environ.get("VELO_SSH", "")).strip()
    if not ssh_host:
        ssh_host = input("Адрес ssh сервера dev (например, root@zxcvbnm.beer): ").strip()
    if not ssh_host:
        raise Refusal("Адрес ssh не задан: без цифр сервера тест не идёт.")

    step("Сервер")
    check = probe(ssh_host, "check")
    if check.get("role") != "test":
        raise Refusal(f"Роль сервера '{check.get('role')}', а тест идёт только на роли test.")
    velo_code = (check.get("code") or {}).get("velo") or {}
    say(f"роль: test, код VELO: {velo_code.get('commit', '?')[:10]} ({velo_code.get('branch', '?')}), "
        f"ядер: {check['server']['cpus']}")
    meta["server_check"] = check

    run_dir.mkdir(parents=True, exist_ok=False)
    api = Api(base_url)
    logins = Logins(api, bot_token)

    step("Ученики (вход)")
    needed = max(max(consts["break_levels"]), sum(consts["race_cohort"]), sum(consts["start_cohort"]))
    meta["warmup"] = warmup(api, logins, base_url, consts, needed)

    practices = Practices(api, run_id)
    probe_started = False
    ok = False
    try:
        step("Мастера и практики этого прогона")
        practices.login_masters(logins)
        practice_file = practices.create_all(consts["race_seats"])
        (run_dir / "practices.json").write_text(json.dumps(practice_file, ensure_ascii=False, indent=2))
        meta["login_durations"] = logins.durations
        env = {"BASE_URL": base_url, "PRACTICES_FILE": str(run_dir / "practices.json")}

        step("Сервер: начало замеров")
        meta["probe_start"] = probe(ssh_host, "start")
        probe_started = True

        step("Тест 3 -- пик перед началом практики")
        run_k6(k6, "03a-start-prepare.js", run_dir, env, meta)
        run_k6(k6, "03b-start-burst.js", run_dir, env, meta)
        failures = practices.cancel({"start"})
        if failures:
            raise Refusal(f"Не отменилась практика «начало»: {failures}")

        step("Тест 4 -- гонка за места")
        run_k6(k6, "04-race.js", run_dir, env, meta)
        meta["race_check"] = probe(ssh_host, "race-check", practice_file["race"]["id"])["race"]
        failures = practices.cancel({"race"})
        if failures:
            raise Refusal(f"Не отменилась практика гонки: {failures}")

        step("Тест 1 -- излом")
        run_k6(k6, "01-break.js", run_dir, env, meta)
        bp = break_point(run_dir, consts["break_levels"])
        meta["break_point"] = bp

        if full:
            if bp is None:
                meta["steady_skipped"] = "излом не найден: ни одна ступень теста 1 не прошла"
                say("  тесты 2 и 5 пропущены: ни одна ступень теста 1 не прошла")
            else:
                steady = max(1, int(bp * 0.6))
                meta["steady_vus"] = steady
                step(f"Тест 2 -- рабочая нагрузка, {steady} учеников")
                run_k6(k6, "02-steady.js", run_dir, dict(env, STEADY_VUS=str(steady)), meta)
                step(f"Тест 5 -- час, {steady} учеников")
                run_k6(k6, "05-hour.js", run_dir, dict(env, STEADY_VUS=str(steady)), meta)

        step("Сервер: конец замеров")
        probe_started = False  # a failed stop is not retried: stop already removed the data
        stop = probe(ssh_host, "stop", raw_path=run_dir / "probe.raw.txt")
        (run_dir / "probe.json").write_text(json.dumps(stop, ensure_ascii=False))

        step("Отмена практик прогона")
        failures = practices.cancel({"feed", "race", "start"})
        left = practices.still_active()
        if failures or left:
            raise Refusal(f"Остались неотменённые практики: {failures + left}")
        say(f"  отменено: {len(practices.cancelled)}, активных не осталось")
        ok = True
    finally:
        if probe_started:
            try:
                stop = probe(ssh_host, "stop", raw_path=run_dir / "probe.raw.txt")
                (run_dir / "probe.json").write_text(json.dumps(stop, ensure_ascii=False))
            except Refusal as exc:
                say(f"  !! сервер: замеры не остановлены: {exc}")
        if not ok and practices.created:
            failures = practices.cancel({"feed", "race", "start"})
            if failures:
                say(f"  !! не отменились практики: {failures}")
        (run_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

    step("Отчёт")
    path = render.build(run_dir)
    say(f"\n✓ Отчёт: {path}")
    try:
        if platform.system() == "Darwin":
            subprocess.run(["open", str(path)], check=False)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Refusal as exc:
        print(f"\n✗ Остановлено: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n✗ Остановлено (Ctrl+C). Что успело отмениться и остановиться -- в строках выше.",
              file=sys.stderr)
        sys.exit(130)
