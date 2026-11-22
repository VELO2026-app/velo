"""Every header the frontend sets on an API request passes CORS (BE-230).

The frontend and the API are on different origins (domains.frontend,
domains.api; BE-192). A request with a header outside the CORS-safelisted
set makes the browser send a preflight OPTIONS first; a header missing from
allow_headers (app/main.py) answers that preflight with 400, and the request
itself is never sent. That is how the support form, the diary and the chat
stopped writing on a live instance: the frontend sets Idempotency-Key on all
three, and allow_headers did not list it.

Two parts:

* the preflight itself, sent as the browser sends it, on the paths of the
  three writes -- the frontend's origin and its headers pass, a foreign
  header or a foreign origin does not (B-03: allow_headers=["*"] is not an
  option with allow_credentials=True);
* a guard that FINDS the headers in the frontend's code -- not a second list
  of them here -- and sends each through the same preflight. The frontend is
  read from frontend/src/api/ (its client and its calls; the test image
  carries that directory, backend/Dockerfile stage `test`).

HOW THE GUARD FINDS THEM. From the bodies, not by one regular expression:

1. client.ts: the one fetch() call, the variable it passes as `headers`, the
   object that variable starts as and every assignment into it inside the
   same function. A spread of `<x>.headers` there is the callers' channel.
2. client.ts: the members of `export const api = {...}` and, for each, the
   parameter that carries headers -- one named `headers` (an object of
   headers) or `options` (RequestOptions, whose `headers` key is one).
3. every other code file under frontend/src/api/: each call of a carrying
   member, and the header object at that parameter.

Comments are blanked and string, template and regex literals masked before
any of this, so text in a comment or a string is never read as code.

ANY FORM IT CANNOT READ IS RED, with the file and line: a header object that
is a variable, a spread or a computed key; options passed as a variable; a
second fetch(), or one outside client.ts; XMLHttpRequest, EventSource,
WebSocket, sendBeacon, setRequestHeader, new Headers, new Request, axios;
`api` imported under another name, used as a value, or a member client.ts
does not have; a code file of another kind; a literal the lexer cannot close.
A guard that skips what it does not understand is green over the next
missing header. A call whose arguments the lexer splits wrongly (a generic
with a comma inside an argument) moves the carrying argument onto something
that is not a header object -- red as well, never green.

KNOWN CEILING -- a header set outside frontend/src/api/ is not seen.
  1. Mechanics: the guard reads frontend/src/api/ only, the directory the
     test image carries and backend-tests.yml filters on. An `api.post(...)`
     with headers, or a fetch(), written in a store, a composable or a
     component would not be read, and a header added there would pass this
     test and fail the browser's preflight.
  2. Status: acknowledged by design.
  3. Task: none yet -- the dispatcher opens the card after BE-230 ships.
  4. Trigger: a call of `api.*` that passes headers, or a fetch(), appears
     anywhere in frontend/src outside src/api/.
  5. Agreed fix: an ESLint rule in the frontend forbidding headers passed to
     `api.*` (and fetch()) outside src/api/, so the frontend's own lint keeps
     every header where this guard reads.
  6. Rejected: copying all of frontend/src into the test image and filtering
     backend-tests.yml on it -- the backend suite would run on every pull
     request of the frontend.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

import pytest
from httpx import AsyncClient

from app.core.comms import IDEMPOTENCY_HEADER
from app.core.config import settings

ROOT = Path(__file__).resolve().parents[2]
FRONT_API = ROOT / "frontend" / "src" / "api"

# The three writes that carry Idempotency-Key (support ticket, diary entry,
# chat message): the paths their preflights go to.
WRITE_PATHS = (
    "/api/v1/support/tickets",
    "/api/v1/diary",
    f"/api/v1/chats/{uuid4()}/messages",
)

# What a browser sends for a logged-in JSON write with a key: lower case,
# comma-separated, sorted.
BROWSER_HEADERS = "authorization,content-type,idempotency-key"

FOREIGN_HEADER = "x-velo-not-allowed"
FOREIGN_ORIGIN = "https://elsewhere.velo-ci.invalid"


async def _preflight(
    client: AsyncClient,
    requested: str | None,
    *,
    path: str = WRITE_PATHS[0],
    origin: str | None = None,
):
    headers = {
        "Origin": origin or settings.frontend_origin,
        "Access-Control-Request-Method": "POST",
    }
    if requested is not None:
        headers["Access-Control-Request-Headers"] = requested
    return await client.options(path, headers=headers)


def _allowed(response) -> set[str]:
    raw = response.headers.get("access-control-allow-headers", "")
    return {h.strip().lower() for h in raw.split(",") if h.strip()}


# -- the preflight: what the browser sends -------------------------------------


@pytest.mark.parametrize("path", WRITE_PATHS)
async def test_each_write_of_the_frontend_passes_its_preflight(
    client: AsyncClient, path: str,
) -> None:
    resp = await _preflight(client, BROWSER_HEADERS, path=path)

    assert resp.status_code == 200, resp.text
    assert IDEMPOTENCY_HEADER.lower() in _allowed(resp)
    assert resp.headers["access-control-allow-origin"] == settings.frontend_origin
    assert resp.headers["access-control-allow-credentials"] == "true"


async def test_the_key_alone_passes(client: AsyncClient) -> None:
    resp = await _preflight(client, IDEMPOTENCY_HEADER.lower())

    assert resp.status_code == 200, resp.text
    assert IDEMPOTENCY_HEADER.lower() in _allowed(resp)


async def test_the_key_named_twice_passes(client: AsyncClient) -> None:
    resp = await _preflight(client, "idempotency-key, Idempotency-Key")

    assert resp.status_code == 200, resp.text


async def test_a_preflight_naming_no_header_passes(client: AsyncClient) -> None:
    resp = await _preflight(client, None)

    assert resp.status_code == 200, resp.text
    assert resp.headers["access-control-allow-origin"] == settings.frontend_origin


@pytest.mark.parametrize(
    "requested",
    [FOREIGN_HEADER, f"{BROWSER_HEADERS},{FOREIGN_HEADER}"],
    ids=["foreign-alone", "foreign-among-allowed"],
)
async def test_a_foreign_header_is_refused(
    client: AsyncClient, requested: str,
) -> None:
    """B-03: the list is explicit. One header outside it refuses the whole
    preflight -- allow_headers=["*"] would mirror it back instead."""
    resp = await _preflight(client, requested)

    assert resp.status_code == 400
    assert "headers" in resp.text.lower()
    assert FOREIGN_HEADER not in _allowed(resp)


async def test_another_origin_is_refused_even_with_the_key(
    client: AsyncClient,
) -> None:
    resp = await _preflight(
        client, IDEMPOTENCY_HEADER.lower(), origin=FOREIGN_ORIGIN,
    )

    assert resp.status_code == 400
    assert "access-control-allow-origin" not in resp.headers


# -- the guard: the headers the frontend sets, found in its code ----------------


class UnrecognizedFormError(Exception):
    """The frontend's code holds a form the guard cannot read."""


@dataclass(frozen=True)
class Site:
    name: str
    where: str
    source: str  # "client" (client.ts sets it) or "caller" (a call passes it)


@dataclass
class Found:
    sites: list[Site] = field(default_factory=list)
    callers_channel: bool = False

    def names(self) -> set[str]:
        return {s.name.lower() for s in self.sites}

    def by_source(self, source: str) -> set[str]:
        return {s.name.lower() for s in self.sites if s.source == source}


# RFC 9110 token: what a header name may be.
_TOKEN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
_IDENT = re.compile(r"[A-Za-z_$][\w$]*")
_CODE_SUFFIXES = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue"}
_FORBIDDEN = re.compile(
    r"\b(XMLHttpRequest|EventSource|WebSocket|sendBeacon|setRequestHeader|axios)\b"
    r"|\bnew\s+(Headers|Request)\b"
    r"|(?<![\w$])(window|globalThis|self)\s*\.\s*fetch\b",
)
_FETCH = re.compile(r"(?<![\w$.])fetch\s*\(")
_REGEX_BEFORE = set("(,=:[!&|?{};+-*%<>~^")
_REGEX_AFTER_WORDS = {
    "return", "typeof", "case", "in", "of", "delete", "void", "throw", "new",
    "else", "do", "yield", "await",
}
_CLOSE = {")": "(", "]": "[", "}": "{"}


class _Source:
    """One file: its text and a mask of the same length, where comments are
    blanks and the insides of string, template and regex literals are `_`
    (quotes, `${` and `}` of template expressions kept). Structure is read
    from the mask, literal values from the text at the same positions."""

    def __init__(self, path: Path, shown: str) -> None:
        self.path = path
        self.shown = shown
        self.text = path.read_text(encoding="utf-8")
        self.mask = _mask(self.text, self.where)
        _check_balance(self.mask, self.where)

    def where(self, pos: int) -> str:
        return f"{self.shown}:{self.text.count(chr(10), 0, pos) + 1}"

    def fail(self, pos: int, what: str) -> UnrecognizedFormError:
        return UnrecognizedFormError(f"{self.where(pos)}: {what}")


def _mask(text: str, where) -> str:
    out: list[str] = []
    n = len(text)
    i = 0
    # Each entry is the brace depth of one open `${...}`; empty -> top level.
    braces: list[int] = []

    def blank(s: str) -> str:
        return "".join(c if c == "\n" else " " for c in s)

    def hide(s: str) -> str:
        return "".join(c if c == "\n" else "_" for c in s)

    def last_code() -> tuple[str, str]:
        j = len(out) - 1
        while j >= 0 and out[j].isspace():
            j -= 1
        if j < 0:
            return "", ""
        k = j
        while k >= 0 and (out[k].isalnum() or out[k] in "_$"):
            k -= 1
        return out[j], "".join(out[k + 1 : j + 1])

    def template(i: int) -> int:
        """At the char after a backtick (or after the `}` closing `${...}`):
        mask up to the closing backtick or the next `${`."""
        start = i
        while i < n:
            c = text[i]
            if c == "\\":
                i += 2
                continue
            if c == "`":
                out.append(hide(text[start:i]) + "`")
                return i + 1
            if text.startswith("${", i):
                out.append(hide(text[start:i]) + "${")
                braces.append(0)
                return i + 2
            i += 1
        raise UnrecognizedFormError(f"{where(start)}: unterminated template literal")

    while i < n:
        c = text[i]
        if text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(blank(text[i:j]))
            i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j < 0:
                raise UnrecognizedFormError(f"{where(i)}: unterminated comment")
            out.append(blank(text[i : j + 2]))
            i = j + 2
        elif c in "'\"":
            j = i + 1
            while j < n and text[j] != c:
                if text[j] == "\n":
                    raise UnrecognizedFormError(f"{where(i)}: unterminated string")
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                raise UnrecognizedFormError(f"{where(i)}: unterminated string")
            out.append(c + hide(text[i + 1 : j]) + c)
            i = j + 1
        elif c == "`":
            out.append("`")
            i = template(i + 1)
        elif c == "{" and braces:
            braces[-1] += 1
            out.append(c)
            i += 1
        elif c == "}" and braces:
            if braces[-1] == 0:
                braces.pop()
                out.append("}")
                i = template(i + 1)
            else:
                braces[-1] -= 1
                out.append(c)
                i += 1
        elif c == "/":
            prev, word = last_code()
            if prev == "" or prev in _REGEX_BEFORE or word in _REGEX_AFTER_WORDS:
                j = i + 1
                in_class = False
                while j < n:
                    d = text[j]
                    if d == "\n":
                        raise UnrecognizedFormError(f"{where(i)}: unterminated regex")
                    if d == "\\":
                        j += 2
                        continue
                    if d == "[":
                        in_class = True
                    elif d == "]":
                        in_class = False
                    elif d == "/" and not in_class:
                        break
                    j += 1
                if j >= n:
                    raise UnrecognizedFormError(f"{where(i)}: unterminated regex")
                out.append("/" + hide(text[i + 1 : j]) + "/")
                i = j + 1
            else:
                out.append(c)
                i += 1
        else:
            out.append(c)
            i += 1
    if braces:
        raise UnrecognizedFormError(f"{where(n)}: unterminated template expression")
    mask = "".join(out)
    assert len(mask) == n
    return mask


def _check_balance(mask: str, where) -> None:
    stack: list[tuple[str, int]] = []
    for i, c in enumerate(mask):
        if c in "([{":
            stack.append((c, i))
        elif c in _CLOSE:
            if not stack or stack[-1][0] != _CLOSE[c]:
                raise UnrecognizedFormError(f"{where(i)}: unbalanced {c!r}")
            stack.pop()
    if stack:
        raise UnrecognizedFormError(f"{where(stack[-1][1])}: unclosed {stack[-1][0]!r}")


def _skip_ws(mask: str, i: int) -> int:
    while i < len(mask) and mask[i].isspace():
        i += 1
    return i


def _match(mask: str, i: int) -> int:
    """The position of the bracket closing the one at i."""
    depth = 0
    for j in range(i, len(mask)):
        if mask[j] in "([{":
            depth += 1
        elif mask[j] in ")]}":
            depth -= 1
            if depth == 0:
                return j
    raise AssertionError("unreachable: the mask is balanced")


def _skip_generic(mask: str, i: int) -> int:
    """At `<`: the position after the matching `>` (an arrow's `>` is not
    one)."""
    depth = 0
    for j in range(i, len(mask)):
        if mask[j] == "<":
            depth += 1
        elif mask[j] == ">" and mask[j - 1] != "=":
            depth -= 1
            if depth == 0:
                return j + 1
    return len(mask)


def _items(mask: str, open_pos: int, *, angle: bool = False) -> list[tuple[int, int]]:
    """Top-level comma-separated spans inside the bracket at open_pos,
    stripped; an empty span (a trailing comma) is dropped."""
    close = _match(mask, open_pos)
    spans: list[tuple[int, int]] = []
    depth = 0
    start = open_pos + 1
    for j in range(open_pos + 1, close):
        c = mask[j]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif angle and c == "<":
            depth += 1
        elif angle and c == ">" and mask[j - 1] != "=":
            depth -= 1
        elif c == "," and depth == 0:
            spans.append((start, j))
            start = j + 1
    spans.append((start, close))
    out = []
    for a, b in spans:
        while a < b and mask[a].isspace():
            a += 1
        while b > a and mask[b - 1].isspace():
            b -= 1
        if a < b:
            out.append((a, b))
    return out


def _object_entries(
    src: _Source, a: int, b: int, what: str,
) -> list[tuple[str, int, tuple[int, int] | None]]:
    """The entries of the object literal spanning [a, b): (key, position,
    value span or None for a shorthand). Any other form is red."""
    mask = src.mask
    if mask[a] != "{" or _match(mask, a) != b - 1:
        raise src.fail(a, f"{what} is not an object literal")
    entries = []
    for x, y in _items(mask, a):
        c = mask[x]
        if mask.startswith("...", x):
            raise src.fail(x, f"{what}: a spread")
        if c == "[":
            raise src.fail(x, f"{what}: a computed key")
        if c in "'\"":
            end = mask.index(c, x + 1)
            key = src.text[x + 1 : end]
            if "\\" in key:
                raise src.fail(x, f"{what}: an escaped key")
            after = end + 1
        else:
            m = _IDENT.match(mask, x)
            if not m:
                raise src.fail(x, f"{what}: a key of unknown form")
            key = m.group()
            after = m.end()
        k = _skip_ws(mask, after)
        if k >= y:
            if c in "'\"":
                raise src.fail(x, f"{what}: a quoted key without a value")
            entries.append((key, x, None))
        elif mask[k] == ":":
            v = _skip_ws(mask, k + 1)
            entries.append((key, x, (v, y)))
        else:
            raise src.fail(x, f"{what}: a method, accessor or other member")
    return entries


def _header_names(
    src: _Source, span: tuple[int, int], what: str, source: str,
) -> list[Site]:
    sites = []
    for key, pos, _ in _object_entries(src, span[0], span[1], what):
        if not _TOKEN.fullmatch(key):
            raise src.fail(pos, f"{what}: {key!r} is not a header name")
        sites.append(Site(key, src.where(pos), source))
    return sites


def _api_members(client: _Source) -> dict[str, tuple[int, str]]:
    """Member of `api` -> (index of its carrying parameter, "headers" or
    "options"). Every member is listed; one that carries nothing maps to
    (-1, "")."""
    mask = client.mask
    found = list(re.finditer(r"\bexport\s+const\s+api\s*=\s*\{", mask))
    if len(found) != 1:
        raise client.fail(0, f"{len(found)} declarations of `export const api = {{`")
    open_pos = found[0].end() - 1
    members: dict[str, tuple[int, str]] = {}
    for a, _b in _items(mask, open_pos):
        m = re.compile(r"(?:async\s+)?([A-Za-z_$][\w$]*)\s*").match(mask, a)
        if not m:
            raise client.fail(a, "an api member of unknown form")
        name = m.group(1)
        i = m.end()
        if i < len(mask) and mask[i] == "<":
            i = _skip_generic(mask, i)
        i = _skip_ws(mask, i)
        if mask[i : i + 1] != "(":
            raise client.fail(a, f"api.{name} is not a method")
        carrier = (-1, "")
        for index, (x, y) in enumerate(_items(mask, i, angle=True)):
            param = client.text[x:y]
            pm = re.compile(r"(?:\.\.\.)?([A-Za-z_$][\w$]*)").match(param)
            pname = pm.group(1) if pm else ""
            kind = {"headers": "headers", "options": "options"}.get(pname, "")
            typed = "RequestOptions" in param or re.search(
                r"Record\s*<\s*string\s*,\s*string\s*>", param,
            )
            if typed and not kind:
                raise client.fail(
                    x, f"api.{name}: parameter {pname!r} may carry headers",
                )
            if kind:
                carrier = (index, kind)
        members[name] = carrier
    return members


def _client_headers(client: _Source, found: Found) -> None:
    mask = client.mask
    fetches = list(_FETCH.finditer(mask))
    if len(fetches) != 1:
        raise client.fail(0, f"{len(fetches)} fetch() calls in the client, not one")
    call = fetches[0]
    paren = call.end() - 1
    args = _items(mask, paren)
    if len(args) != 2:
        raise client.fail(call.start(), "fetch() without its options object")
    entries = _object_entries(client, *args[1], "fetch() options")
    passed = [e for e in entries if e[0] == "headers"]
    if not passed:
        raise client.fail(call.start(), "fetch() carries no headers")
    _, handoff, value = passed[0]
    if value is None:
        var = "headers"
    else:
        var = client.text[value[0] : value[1]].strip()
        if not _IDENT.fullmatch(var):
            raise client.fail(value[0], "fetch() headers are not a variable")

    funcs = [
        m for m in re.finditer(r"\bfunction\s+[A-Za-z_$][\w$]*\s*", mask)
        if m.start() < call.start()
    ]
    if not funcs:
        raise client.fail(call.start(), "fetch() outside a function")
    i = funcs[-1].end()
    if mask[i] == "<":
        i = _skip_generic(mask, i)
    i = _skip_ws(mask, i)
    body_open = mask.index("{", _match(mask, i))
    body_close = _match(mask, body_open)
    if not body_open < call.start() < body_close:
        raise client.fail(call.start(), "fetch() outside the function found before it")

    for m in re.finditer(rf"(?<![\w$.]){re.escape(var)}\b", mask[: body_close]):
        pos = m.start()
        if pos < body_open:
            continue
        if pos == handoff:
            continue
        j = _skip_ws(mask, m.end())
        before = mask[body_open:pos].rstrip()
        if re.search(r"\b(const|let)$", before):
            k = j
            if mask[k] == ":":
                k += 1
                while k < body_close and not (
                    mask[k] == "="
                    and mask[k + 1] not in "=>"
                    and mask[k - 1] not in "=!<>"
                ):
                    if mask[k] == "<":
                        k = _skip_generic(mask, k)
                        continue
                    k += 1
            if mask[k] != "=":
                raise client.fail(pos, f"{var} is declared without an initial object")
            v = _skip_ws(mask, k + 1)
            if mask[v] != "{":
                raise client.fail(v, f"{var} does not start as an object literal")
            for x, y in _items(mask, v):
                spread = re.compile(r"\.\.\.\s*[A-Za-z_$][\w$]*\s*\.\s*headers\s*$")
                if spread.match(mask[x:y]):
                    found.callers_channel = True
                    continue
                found.sites.extend(_entry_as_header(client, x, y, var))
            continue
        if mask[j] == "[":
            k = _skip_ws(mask, j + 1)
            close = _match(mask, j)
            q = mask[k]
            if q not in "'\"" or _skip_ws(mask, mask.index(q, k + 1) + 1) != close:
                raise client.fail(pos, f"{var}[...] with a key that is not a literal")
            key = client.text[k + 1 : mask.index(q, k + 1)]
            after = _skip_ws(mask, close + 1)
            if not (mask[after] == "=" and mask[after + 1] != "="):
                raise client.fail(pos, f"{var}[{key!r}] used other than assigned")
            if not _TOKEN.fullmatch(key):
                raise client.fail(pos, f"{key!r} is not a header name")
            found.sites.append(Site(key, client.where(pos), "client"))
            continue
        if mask[j] == ".":
            mm = _IDENT.match(mask, _skip_ws(mask, j + 1))
            after = _skip_ws(mask, mm.end()) if mm else j
            if mm and mask[after] == "=" and mask[after + 1] != "=":
                found.sites.append(Site(mm.group(), client.where(pos), "client"))
                continue
        raise client.fail(pos, f"{var} used in a form the guard cannot read")


def _entry_as_header(client: _Source, x: int, y: int, var: str) -> list[Site]:
    """One entry of the initial headers object, other than the callers'
    spread: a literal header name with a value."""
    mask = client.mask
    if mask.startswith("...", x):
        raise client.fail(x, f"{var}'s initial object: a spread of something else")
    if mask[x] == "[":
        raise client.fail(x, f"{var}'s initial object: a computed key")
    if mask[x] in "'\"":
        end = mask.index(mask[x], x + 1)
        key = client.text[x + 1 : end]
    else:
        m = _IDENT.match(mask, x)
        if not m:
            raise client.fail(x, f"{var}'s initial object: a key of unknown form")
        key = m.group()
    if not _TOKEN.fullmatch(key):
        raise client.fail(x, f"{key!r} is not a header name")
    return [Site(key, client.where(x), "client")]


def _client_imports(src: _Source) -> list[tuple[int, int]]:
    """Spans of the import statements of the client module; red for any form
    but a named list with `api` under its own name."""
    spans = []
    for m in re.finditer(r"\bimport\b[^;'\"`]*?\bfrom\s*(['\"])", src.mask):
        q = m.group(1)
        end = src.mask.index(q, m.end())
        module = src.text[m.end() : end]
        if not re.fullmatch(r"(\./|@/api/|(\.\./)+api/)client(\.ts)?", module):
            continue
        clause = src.mask[m.start() : m.end()]
        if "*" in clause:
            raise src.fail(m.start(), "the client imported as a namespace")
        named = re.fullmatch(r"import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['\"]", clause)
        if named is None:
            raise src.fail(m.start(), "the client imported other than by a named list")
        for item in named.group(1).split(","):
            parts = item.split()
            if parts and parts[0] == "api" and len(parts) > 1:
                raise src.fail(m.start(), "`api` imported under another name")
        spans.append((m.start(), end + 1))
    for m in re.finditer(r"\bimport\s*\(", src.mask):
        args = _items(src.mask, m.end() - 1)
        if args and "client" in src.text[args[0][0] : args[0][1]]:
            raise src.fail(m.start(), "the client imported dynamically")
    return spans


def _calls(src: _Source, members: dict[str, tuple[int, str]], found: Found) -> None:
    mask = src.mask
    imports = _client_imports(src)
    for m in re.finditer(r"(?<![\w$.])api\b", mask):
        pos = m.start()
        if any(a <= pos < b for a, b in imports):
            continue
        j = _skip_ws(mask, m.end())
        if mask[j : j + 1] != ".":
            raise src.fail(pos, "`api` used as a value")
        mm = _IDENT.match(mask, _skip_ws(mask, j + 1))
        if not mm:
            raise src.fail(pos, "`api.` without a member name")
        name = mm.group()
        if name not in members:
            raise src.fail(pos, f"api.{name}: client.ts's api has no such member")
        index, kind = members[name]
        if index < 0:
            continue
        k = _skip_ws(mask, mm.end())
        if mask[k : k + 1] == "<":
            k = _skip_ws(mask, _skip_generic(mask, k))
        if mask[k : k + 1] != "(":
            raise src.fail(pos, f"api.{name} referenced, not called")
        args = _items(mask, k)
        if len(args) <= index:
            continue
        a, b = args[index]
        if src.text[a:b] == "undefined":
            continue
        what = f"api.{name}() {kind}"
        if kind == "headers":
            found.sites.extend(_header_names(src, (a, b), what, "caller"))
            continue
        for key, kpos, value in _object_entries(src, a, b, what):
            if key != "headers":
                continue
            if value is None:
                raise src.fail(kpos, f"{what}: headers passed as a variable")
            found.sites.extend(_header_names(src, value, f"{what}.headers", "caller"))


def scan_frontend_headers(api_dir: Path) -> Found:
    """The headers the frontend sets on its API requests, found in the code
    under api_dir (frontend/src/api). Red on any form it cannot read."""
    client_path = api_dir / "client.ts"
    if not client_path.is_file():
        raise UnrecognizedFormError(f"{client_path}: the client is not there")

    def shown(p: Path) -> str:
        return str(p.relative_to(api_dir.parent))

    files = []
    for p in sorted(api_dir.rglob("*")):
        if not p.is_file() or p.name.endswith((".test.ts", ".spec.ts")):
            continue
        if p.suffix in _CODE_SUFFIXES - {".ts"}:
            raise UnrecognizedFormError(
                f"{shown(p)}: a code file the guard does not read",
            )
        if p.suffix == ".ts":
            files.append(_Source(p, shown(p)))

    found = Found()
    client = next(s for s in files if s.path == client_path)
    for src in files:
        bad = _FORBIDDEN.search(src.mask)
        if bad:
            raise src.fail(
                bad.start(), f"a request channel besides the client: {bad.group()!r}",
            )
        if src is not client:
            stray = _FETCH.search(src.mask)
            if stray:
                raise src.fail(stray.start(), "fetch() outside the client")

    _client_headers(client, found)
    members = _api_members(client)
    if not any(index >= 0 for index, _ in members.values()):
        raise client.fail(0, "no member of api carries headers")
    for src in files:
        if src is not client:
            _calls(src, members, found)
    return found


async def test_every_header_the_frontend_sets_passes_preflight(
    client: AsyncClient,
) -> None:
    """The set is found in the frontend's code (frontend/src/api), never
    listed here: a header added there is checked by this test unseen."""
    found = scan_frontend_headers(FRONT_API)

    # The pair of "nothing is refused": something was found, from both
    # places a header comes from -- a scan that reads nothing is green too.
    assert found.by_source("client"), "client.ts sets no header: the scan read nothing"
    assert found.by_source("caller"), "no call passes a header: the scan read nothing"
    assert found.callers_channel, "client.ts does not take the callers' headers"

    for name in sorted(found.names()):
        sites = [s.where for s in found.sites if s.name.lower() == name]
        resp = await _preflight(client, name)
        assert resp.status_code == 200, f"{name} ({', '.join(sites)}): {resp.text}"
        assert name in _allowed(resp), f"{name} ({', '.join(sites)})"

    # A request carries several at once: the browser names them together.
    resp = await _preflight(client, ",".join(sorted(found.names())))
    assert resp.status_code == 200, resp.text


# -- the guard against forms: synthetic frontends -------------------------------

MINI_CLIENT = """\
export interface RequestOptions {
  body?: unknown
  headers?: Record<string, string>
}

async function send<T>(
  method: string,
  path: string,
  options: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const response = await fetch(`${BASE}${path}`, { method, headers })
  return (await response.json()) as T
}

export const api = {
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    return send<T>(method, path, options ?? {})
  },
  get<T>(path: string): Promise<T> {
    return send<T>('GET', path, {})
  },
  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return send<T>('POST', path, { body, headers })
  },
}
"""

IMPORT = "import { api } from '@/api/client'\n"


def _tree(tmp_path: Path, files: dict[str, str], client: str = MINI_CLIENT) -> Path:
    api_dir = tmp_path / "frontend" / "src" / "api"
    api_dir.mkdir(parents=True)
    if client is not None:
        (api_dir / "client.ts").write_text(client, encoding="utf-8")
    for name, body in files.items():
        path = api_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    return api_dir


def test_the_mini_frontend_is_read_whole(tmp_path: Path) -> None:
    api_dir = _tree(tmp_path, {
        "a.ts": IMPORT + (
            "export const x = () => api.post<Out>(\n"
            "  path`/api/v1/a/${id}`,\n"
            "  { body },\n"
            "  { 'Idempotency-Key': key },\n"
            ")\n"
            "export const y = () => api.request<Out>('POST', '/b', {\n"
            "  body, headers: { 'X-One': '1' },\n"
            "})\n"
        ),
    })
    found = scan_frontend_headers(api_dir)
    assert found.by_source("client") == {"authorization"}
    assert found.by_source("caller") == {"idempotency-key", "x-one"}
    assert found.callers_channel
    keyed = {s.where for s in found.sites if s.name == "Idempotency-Key"}
    assert keyed == {"api/a.ts:5"}


# ПОВТОР


def test_one_header_in_many_calls_and_cases_is_one_name(tmp_path: Path) -> None:
    api_dir = _tree(tmp_path, {
        "a.ts": IMPORT + "api.post('/a', b, { 'Idempotency-Key': k })\n",
        "sub/b.ts": IMPORT + "api.post('/b', b, { 'idempotency-key': k })\n",
    })
    found = scan_frontend_headers(api_dir)
    assert found.names() == {"authorization", "idempotency-key"}
    assert len([s for s in found.sites if s.name.lower() == "idempotency-key"]) == 2


# ПУСТОТА


@pytest.mark.parametrize(
    "call",
    [
        "api.post('/a', b)",
        "api.post('/a', b,)",
        "api.post('/a', b, {})",
        "api.post('/a', b, undefined)",
        "api.request('POST', '/a')",
        "api.request('POST', '/a', { body: b, timeoutMs: 5 })",
        "api.get('/a')",
    ],
)
def test_a_call_with_no_header_adds_none(tmp_path: Path, call: str) -> None:
    api_dir = _tree(tmp_path, {"a.ts": IMPORT + call + "\n"})
    assert scan_frontend_headers(api_dir).by_source("caller") == set()


def test_comments_strings_and_regexes_are_not_code(tmp_path: Path) -> None:
    api_dir = _tree(tmp_path, {
        "a.ts": IMPORT + (
            "// api.post('/a', b, { 'X-Commented': '1' })\n"
            "/* fetch(url, { headers }) api.post('/a', b, { 'X-Block': 1 }) */\n"
            "const s = \"api.post('/a', b, { 'X-String': 1 })\"\n"
            "const t = `${'a'.replace(/['\"`]/g, '')} api.post( ${`x${1}`}`\n"
            "const r = 'xy'.replace(/[xy]/g, (c) => c)\n"
            "export const ok = () => api.post('/a', b, { 'X-Real': '1' })\n"
        ),
    })
    assert scan_frontend_headers(api_dir).by_source("caller") == {"x-real"}


# НЕХВАТКА -- forms the guard cannot read are red, with the place


@pytest.mark.parametrize(
    ("body", "where", "what"),
    [
        ("api.post('/a', b, hdrs)", "api/a.ts:2", "not an object literal"),
        ("api.post('/a', b, { ...hdrs })", "api/a.ts:2", "spread"),
        ("api.post('/a', b, { [NAME]: k })", "api/a.ts:2", "computed key"),
        ("api.post('/a', b, { 'Bad Name': k })", "api/a.ts:2", "not a header name"),
        ("api.request('POST', '/a', opts)", "api/a.ts:2", "not an object literal"),
        ("api.request('POST', '/a', { headers })", "api/a.ts:2", "as a variable"),
        ("api.request('POST', '/a', { ...opts })", "api/a.ts:2", "spread"),
        ("const p = api.post\n", "api/a.ts:2", "referenced, not called"),
        ("send(api)", "api/a.ts:2", "used as a value"),
        ("api.upload('/a', f)", "api/a.ts:2", "no such member"),
        ("fetch('/api/v1/a', { headers: h })", "api/a.ts:2", "outside the client"),
        ("window.fetch('/a')", "api/a.ts:2", "besides the client"),
        ("new XMLHttpRequest()", "api/a.ts:2", "besides the client"),
        ("navigator.sendBeacon('/a')", "api/a.ts:2", "besides the client"),
        ("const h = new Headers()", "api/a.ts:2", "besides the client"),
        ("const s = 'unterminated\n", "api/a.ts:2", "unterminated string"),
    ],
)
def test_a_form_the_guard_cannot_read_is_red(
    tmp_path: Path, body: str, where: str, what: str,
) -> None:
    api_dir = _tree(tmp_path, {"a.ts": IMPORT + body + "\n"})
    with pytest.raises(UnrecognizedFormError, match=re.escape(where) + ".*" + what):
        scan_frontend_headers(api_dir)


@pytest.mark.parametrize(
    ("imports", "what"),
    [
        ("import { api as http } from '@/api/client'\n", "another name"),
        ("import * as client from './client'\n", "namespace"),
    ],
)
def test_the_client_imported_otherwise_is_red(
    tmp_path: Path, imports: str, what: str,
) -> None:
    api_dir = _tree(tmp_path, {"a.ts": imports + "x()\n"})
    with pytest.raises(UnrecognizedFormError, match=what):
        scan_frontend_headers(api_dir)


@pytest.mark.parametrize(
    ("client", "what"),
    [
        (
            MINI_CLIENT.replace("headers['Authorization']", "headers[name]"),
            "not a literal",
        ),
        (
            MINI_CLIENT.replace(
                "  if (token) {", "  Object.assign(headers, extra)\n  if (token) {",
            ),
            "cannot read",
        ),
        (
            MINI_CLIENT.replace("{ method, headers }", "{ method }"),
            "carries no headers",
        ),
        (
            MINI_CLIENT.replace("{ method, headers }", "opts"),
            r"fetch\(\) options is not",
        ),
        (
            MINI_CLIENT.replace("{ ...options.headers }", "{ ...defaults }"),
            "spread of something else",
        ),
        (
            MINI_CLIENT.replace(
                "  return (await response.json())",
                "  await fetch('/again')\n  return (await response.json())",
            ),
            "2 fetch",
        ),
        (
            MINI_CLIENT.replace(
                "get<T>(path: string)", "get<T>(path: string, extra?: RequestOptions)",
            ),
            "may carry headers",
        ),
    ],
    ids=[
        "computed-assignment", "object-assign", "fetch-without-headers",
        "fetch-options-variable", "other-spread", "two-fetches", "unnamed-carrier",
    ],
)
def test_a_client_the_guard_cannot_read_is_red(
    tmp_path: Path, client: str, what: str,
) -> None:
    assert client != MINI_CLIENT
    call = "api.post('/a', b, { 'X-A': 1 })\n"
    api_dir = _tree(tmp_path, {"a.ts": IMPORT + call}, client)
    with pytest.raises(UnrecognizedFormError, match=what):
        scan_frontend_headers(api_dir)


def test_no_client_is_red(tmp_path: Path) -> None:
    api_dir = _tree(tmp_path, {"a.ts": IMPORT}, client=None)
    with pytest.raises(UnrecognizedFormError, match="the client is not there"):
        scan_frontend_headers(api_dir)


def test_a_code_file_of_another_kind_is_red(tmp_path: Path) -> None:
    api_dir = _tree(tmp_path, {"legacy.js": "fetch('/a')\n"})
    what = re.escape("legacy.js: a code file")
    with pytest.raises(UnrecognizedFormError, match=what):
        scan_frontend_headers(api_dir)
