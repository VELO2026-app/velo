"""VELO -- the `telegram_id` band registry, as DATA (T-58).

This module replaces `docs/telegram-id-bands.md`, which was deleted with
this delivery. A document could only be kept true by remembering to edit
it, and it stopped being true: it knew eight holders where the tree has
thirty, and it carried two comms bands that turned out to be invented.
What follows is read from the tree on every run instead.

WHY BANDS EXIST AT ALL
----------------------
The suite runs against a real Postgres, not a fresh one per file. Test
users are told apart by `telegram_id`, and each file cleans up after
itself by RANGE -- so a band is a file's private stretch of the number
line, and two files sharing a stretch share a fate.

WHY AN OVERLAP IS A HAZARD AND NOT AN UNTIDINESS
------------------------------------------------
`full_cleanup_range` (and every hand-rolled `_do_cleanup` copying it)
SELECTS EVERY USER IN THE RANGE, deletes the rows hanging off them --
bookings, feedbacks, checkins, master profiles -- and COMMITS. Many of
them delete the users too (`delete_users=True`). It runs around every
test, not once per file.

So an overlap does not clash on a unique key and fail loudly. It
DESTROYS THE OTHER FILE'S FIXTURES MID-RUN and the other file fails
somewhere else entirely, on an assertion that has nothing to do with
ids. That is why this is worth machinery.

TODAY NOTHING BREAKS, AND THAT IS A PROPERTY OF THE RUNNER, NOT OF THE
CODE: there is no `pytest-xdist`, no `addopts`, no CI at all (`.github/`
is empty), so files run one after another and each merely sweeps the
previous one's leftovers on entry. The day anything runs in parallel, or
two runs share the stand, every overlap below fires at once.

THE PRECEDENT WORTH KNOWING
---------------------------
`test_chats_t3_students.py` was moved off `89760-89799` because that
range was reserved -- a relocation that nothing verified, and three days
later another amendment claimed inside the destination. Moving a band is
not a fix unless the destination was checked. That is what this module
is for.

READ DECLARATIONS, NOT USAGES. Ids are frequently COMPUTED
(`BAND_MIN + 15`), so grepping for a literal `8981[0-9]` returns a
comment and reads clean while the collision is real. Worse, grepping for
the DECLARATION also lies: a band written in a comment -- a file
describing its NEIGHBOUR's range -- matches the same pattern. Every
reader below therefore parses the AST and looks only at module-level
assignments.
"""

from __future__ import annotations

import ast
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent

# The constant names a band declaration is written under, as they exist
# in the tree today. Six names, three spellings of one idea -- not a
# format we chose, one we inherited and must be able to read.
_BAND_LOW_NAMES = ("BAND_MIN", "_TID_MIN", "TID_MIN")
_BAND_HIGH_NAMES = ("BAND_MAX", "_TID_MAX", "TID_MAX")

# The multi-range form, for a file whose numbers genuinely sit in
# separate clusters. A single (min, max) pair would have to span the
# gaps, and the span -- not the usage -- is what a cleanup deletes.
_BAND_RANGES_NAME = "_TID_RANGES"

_CLEANUP_CALLS = ("cleanup_range", "full_cleanup_range")

# Address space we allocate from. Anything declared outside it is
# flagged: the free-window list below is worthless if bands can appear
# anywhere.
ALLOWED_SPACE: tuple[tuple[int, int], ...] = (
    (55000, 99999),
)

# Do not allocate from these.
RESERVED: dict[tuple[int, int], str] = {
    (89680, 89699): "reserved window, held empty on purpose",
}

# Free windows in the crowded 89xxx space, as of T-58. Recomputed from
# the declarations, not remembered -- see free_windows().
KNOWN_FREE_HINT = "run `python -m tests.telegram_id_bands` for a live map"


@dataclass(frozen=True)
class Band:
    """One declared stretch of the number line, and who owns it."""

    file: str
    low: int
    high: int

    def overlaps(self, other: Band) -> bool:
        # Inclusive bounds: 89400-89499 and 89500-89599 TOUCH, they do
        # not overlap. An off-by-one here would report a dozen false
        # collisions and the check would be switched off within a week.
        return self.low <= other.high and other.low <= self.high


@dataclass(frozen=True)
class CleanupRecord:
    """What a file's cleanup call actually asks for.

    Recorded as FACTS READ FROM THE CALL, never as a judgement. A label
    like "dangerous" rots silently; `(89000, 89999, delete_users=False)`
    can be re-derived on every run and contradicted when it drifts.
    """

    low: int
    high: int
    delete_users: bool | None

    @property
    def width(self) -> int:
        return self.high - self.low + 1


# ---------------------------------------------------------------------------
# KNOWN OVERLAPS -- declared collisions that this delivery does NOT fix
# ---------------------------------------------------------------------------
# T-58 fixed three named points and deliberately left the rest: rewriting
# bands across dozens of files in a repository with no CI, for a risk
# that does not fire today, is a worse trade than making the risk
# visible. This list is that visibility.
#
# `live` means the two files use THE SAME ACTUAL NUMBERS, listed in
# `shared`. `nominal` means only the declared ranges overlap while the
# numbers in use are disjoint. The distinction is computed from ids
# found in the files, WITH THE BAND-DECLARATION LITERALS EXCLUDED --
# `93000` and `93999` are a _TID_MIN/_TID_MAX pair, not ids, and
# counting them is how a live pair gets mislabelled nominal. That
# mistake was made twice while this task was being written.
#
# THE "ONLY SHRINKS" RULE IS A CONVENTION, NOT A GUARANTEE. One run
# cannot see the previous one, so nothing here stops a future entry from
# being appended. What protects it is that every line needs a
# justification in the diff, and the list is short enough to read. What
# IS machine-checked is the other half: an entry that no longer
# corresponds to a real overlap makes the check fail, so this list
# cannot quietly outlive the problem it records.
@dataclass(frozen=True)
class KnownOverlap:
    files: tuple[str, str]
    kind: str  # "live" | "nominal"
    shared: tuple[int, ...]
    why: str


KNOWN_OVERLAPS: tuple[KnownOverlap, ...] = (
    KnownOverlap(
        ("test_admin_practices.py", "test_admin_stats_overview.py"),
        "live",
        (94001, 94010, 94011, 94800, 94900),
        "both files laid out 94xxx with the same plan -- 94900 admin, "
        "94800 master, 94001+ participants -- and the second one's "
        "header repeats the first one's wording, so the numbers were "
        "copied rather than chosen",
    ),
    KnownOverlap(
        ("test_admin_revenue.py", "test_master_stats.py"),
        "live",
        (93001,),
        "one shared number: 93001 is a buyer in the first file and the "
        "default master in the second",
    ),
    KnownOverlap(
        ("test_comms_outbox.py", "test_insights.py"),
        "nominal",
        (),
        "declared ranges touch at 89441-89499; the numbers actually used "
        "are disjoint",
    ),
    KnownOverlap(
        ("test_comms_outbox.py", "test_users.py"),
        "nominal",
        (),
        "test_users' 89442-89484 (declared by T-58, see that file) sits "
        "inside test_comms_outbox's 89400-89499; the numbers actually "
        "used are disjoint. Second recorded consequence of giving "
        "test_users a band -- it was living inside two neighbours at "
        "once",
    ),
    KnownOverlap(
        ("test_comms_outbox.py", "test_role_switch.py"),
        "live",
        (89499,),
        "89499 is test_comms_outbox's own BAND_MAX used as an id AND a "
        "user in test_role_switch",
    ),
    KnownOverlap(
        ("test_diary_feed.py", "test_master_finance.py"),
        "live",
        (90001, 90002, 90003, 90004, 90005, 90010, 90011, 90012, 90013,
         90014),
        "the widest live collision in the tree: both declare all of "
        "90000-90999 and both actually sit on 90001-90014",
    ),
    KnownOverlap(
        ("test_insights.py", "test_master_invite.py"),
        "nominal",
        (),
        "test_insights declares 89441-89519 and sweeps it; "
        "test_master_invite's 89503-89508 sits inside, numbers disjoint",
    ),
    KnownOverlap(
        ("test_insights.py", "test_role_switch.py"),
        "nominal",
        (),
        "same shape as the entry above: 89485-89502 sits inside "
        "test_insights' swept range, numbers disjoint",
    ),
    KnownOverlap(
        ("test_insights.py", "test_users.py"),
        "live",
        (89442, 89443, 89451, 89452),
        "FOUND BY T-58 while giving test_users a cleanup of its own. "
        "test_users' 89442-89484 sits wholly inside test_insights' swept "
        "89441-89519 AND four numbers are used by both files. Not fixed "
        "here because fixing it means moving ids, which T-58 was scoped "
        "out of; recorded so it is a task and not a surprise",
    ),
)


# ---------------------------------------------------------------------------
# BLIND ZONE -- files this check does NOT protect
# ---------------------------------------------------------------------------
# A green check is NOT proof that no bands collide. It is proof that the
# DECLARED ones do not. The files below declare no band in any form the
# reader can see: they pass literals straight to the cleanup call, or
# they clean up nothing at all. For them the check has nothing to
# compare.
#
# This is a frozen snapshot so the gap has a ratchet: a NEW file with no
# declaration fails the check and has to either declare a band or be
# added here on purpose. Each entry is also a re-derivable FACT -- the
# range, its width and whether it deletes user rows -- read from the
# cleanup call, so if a file changes what it sweeps and this record
# stays behind, the check says so.
#
# WIDTH AND DESTRUCTIVENESS TRIAGE WITHOUT ANY JUDGEMENT CALL. A file
# sweeping a thousand numbers is not the same as one sweeping twenty,
# and at equal width `delete_users=True` is not the same as False. We
# deliberately do NOT compare the swept range against the file's own
# usage: "own usage" has nine spellings in this tree, was miscounted
# twice in one day, and a wrong label is worse than no label -- it would
# lower the priority of a dangerous file and send the next person past
# it with a clear conscience.
#
# A record of `None` means the file creates users and cleans up NOTHING.
# Its rows survive the run -- unless a neighbour's range happens to
# cover them, which is a hygiene that depends on somebody else's file
# and says so nowhere.
BLIND_ZONE: dict[str, CleanupRecord | None] = {
    "test_admin_masters.py": CleanupRecord(56000, 56999, False),
    "test_admin_promos.py": None,
    "test_admin_reports.py": CleanupRecord(59200, 59999, False),
    "test_admin_stats.py": CleanupRecord(57000, 57999, True),
    "test_admin_taxonomy.py": CleanupRecord(58950, 58969, False),
    "test_admin_users.py": CleanupRecord(58000, 58999, False),
    "test_admin_withdrawals.py": CleanupRecord(78000, 78999, True),
    "test_ai_summary.py": CleanupRecord(89000, 89999, False),
    "test_attendance.py": CleanupRecord(63000, 63999, False),
    "test_auth.py": None,
    "test_bookings.py": CleanupRecord(61000, 61999, False),
    "test_cancellation.py": None,
    "test_checkin_audience_grandfather.py": CleanupRecord(89660, 89679, False),
    "test_checkins.py": CleanupRecord(85000, 85999, True),
    "test_feedbacks.py": CleanupRecord(86000, 86999, True),
    "test_ledger.py": None,
    "test_master_confirmed_taxonomy.py": CleanupRecord(99800, 99899, False),
    "test_master_languages.py": CleanupRecord(56700, 56799, False),
    "test_master_method_change.py": CleanupRecord(56600, 56699, False),
    "test_master_public.py": CleanupRecord(56500, 56599, False),
    "test_masters.py": CleanupRecord(55000, 55999, False),
    "test_normalize_master_methods.py": CleanupRecord(99900, 99909, False),
    "test_payments_stripe_integration.py": None,
    "test_payments_topup.py": None,
    "test_practice_capacity_waitlist.py": CleanupRecord(89620, 89639, False),
    "test_practice_parent_ownership.py": CleanupRecord(89640, 89659, False),
    "test_practice_taxonomy_union.py": CleanupRecord(99500, 99599, False),
    "test_practices.py": CleanupRecord(60000, 60999, False),
    "test_profile_stats.py": CleanupRecord(87100, 87199, True),
    "test_promo_purchase.py": CleanupRecord(81000, 81999, True),
    "test_promos.py": CleanupRecord(79000, 79999, True),
    "test_purchase.py": CleanupRecord(75000, 75999, False),
    "test_reports.py": CleanupRecord(59000, 59999, False),
    "test_series_cancel_scope.py": CleanupRecord(64000, 64999, False),
    "test_series_card.py": CleanupRecord(62000, 62999, False),
    "test_series_generation.py": CleanupRecord(61000, 61999, False),
    "test_taxonomy.py": CleanupRecord(58970, 58989, False),
    "test_waitlist.py": CleanupRecord(62000, 62999, False),
    "test_withdrawals.py": CleanupRecord(77000, 77999, True),
    "test_zoom_lifecycle.py": None,
    "test_zoom_registrants.py": None,
    "test_zoom_series.py": None,
}


# ---------------------------------------------------------------------------
# Readers -- AST only
# ---------------------------------------------------------------------------
def _module_assignments(tree: ast.Module) -> dict[str, list[ast.expr]]:
    """Module-level `NAME = value` only -- EVERY assignment, not the last.

    Not nested in a function, not inside a comment, not in a string. A
    band written in prose about a neighbour is not a declaration, and
    this is the line that enforces it.

    A list per name rather than one value, because the first version of
    this reader kept only the last write and therefore ANSWERED a file
    that declared its band twice, silently and with the wrong number.
    Callers below either demand exactly one assignment or report the
    ambiguity; none of them picks a winner.
    """
    out: dict[str, list[ast.expr]] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        target = node.targets[0]
        if isinstance(target, ast.Tuple) and isinstance(node.value, ast.Tuple):
            for name_node, value in zip(
                target.elts, node.value.elts, strict=False
            ):
                if isinstance(name_node, ast.Name):
                    out.setdefault(name_node.id, []).append(value)
        elif isinstance(target, ast.Name):
            out.setdefault(target.id, []).append(node.value)
    return out


def _sole(assigns: dict[str, list[ast.expr]], name: str) -> ast.expr | None:
    """The value of `name`, only if the module assigns it exactly once."""
    values = assigns.get(name, [])
    return values[0] if len(values) == 1 else None


def _const_int(node: ast.expr | None) -> int | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, int):
        return node.value
    return None


def declared_bands(tests_dir: Path | None = None) -> list[Band]:
    """Every band declared in the tree, one entry per declared range.

    A file with an unparseable or half-written declaration (a low bound
    and no high one) is skipped here and surfaces through
    incomplete_declarations() -- silently treating it as "no band" would
    hide exactly the file most likely to be wrong.
    """
    directory = tests_dir or TESTS_DIR
    bands: list[Band] = []
    for path in sorted(directory.glob("test_*.py")):
        for low, high in _ranges_in(path):
            bands.append(Band(path.name, low, high))
    return bands


@dataclass(frozen=True)
class BandSource:
    """One declaration of a band, and how it was written."""

    written_as: str
    ranges: tuple[tuple[int, int], ...]


def band_sources(path: Path) -> list[BandSource]:
    """EVERY band declaration in a file, in the order the reader finds
    them.

    More than one entry means the file says two different things about
    its own band. This function does not choose between them -- see
    multiple_declarations() for why choosing is the bug.
    """
    try:
        tree = ast.parse(path.read_text())
    except SyntaxError:
        return []
    assigns = _module_assignments(tree)
    sources: list[BandSource] = []

    for value in assigns.get(_BAND_RANGES_NAME, []):
        if not isinstance(value, ast.Tuple):
            continue
        ranges: list[tuple[int, int]] = []
        for item in value.elts:
            if isinstance(item, ast.Tuple) and len(item.elts) == 2:
                low = _const_int(item.elts[0])
                high = _const_int(item.elts[1])
                if low is not None and high is not None:
                    ranges.append((low, high))
        if ranges:
            sources.append(BandSource(_BAND_RANGES_NAME, tuple(ranges)))

    for low_name, high_name in zip(
        _BAND_LOW_NAMES, _BAND_HIGH_NAMES, strict=True
    ):
        lows = assigns.get(low_name, [])
        highs = assigns.get(high_name, [])
        if not lows or not highs:
            continue
        if len(lows) > 1 or len(highs) > 1:
            # Written more than once under the same name. Recorded as
            # separate sources so the count is right and the report can
            # show what was found; the values are read pairwise.
            for low_value, high_value in zip(lows, highs, strict=False):
                low, high = _const_int(low_value), _const_int(high_value)
                if low is not None and high is not None:
                    sources.append(
                        BandSource(f"{low_name}/{high_name}", ((low, high),))
                    )
            continue
        low, high = _const_int(lows[0]), _const_int(highs[0])
        if low is not None and high is not None:
            sources.append(
                BandSource(f"{low_name}/{high_name}", ((low, high),))
            )
    return sources


def _ranges_in(path: Path) -> list[tuple[int, int]]:
    """The ranges a file claims, when it claims them unambiguously.

    A file with several conflicting sources still returns its first one
    here -- declared_bands() and the overlap check keep working on the
    tree -- but multiple_declarations() fails the suite for it, so such
    a file cannot sit in the tree unnoticed while these ranges are
    trusted.
    """
    sources = band_sources(path)
    if not sources:
        return []
    return list(sources[0].ranges)


def multiple_declarations(
    tests_dir: Path | None = None,
) -> list[tuple[str, list[BandSource]]]:
    """Files that declare their band more than once.

    NOT A STYLE COMPLAINT. The reader has three ways to resolve this and
    all three are silent: a name assigned twice used to keep the LAST
    value; two different names from the same group resolve to whichever
    comes FIRST in the tuple above; and _TID_RANGES wins outright over
    any pair. Whichever one fires, the file gets a band that need not be
    the one its cleanup actually sweeps -- and every check downstream
    then compares confidently against the wrong thing. That is worse
    than the blind zone: there the check knows it does not know, here it
    would be sure and mistaken.

    So this reports rather than resolves. Deciding which declaration is
    the real one is the author's job, not a heuristic's.
    """
    directory = tests_dir or TESTS_DIR
    out = []
    for path in sorted(directory.glob("test_*.py")):
        sources = band_sources(path)
        if len(sources) > 1:
            out.append((path.name, sources))
    return out


def incomplete_declarations(tests_dir: Path | None = None) -> list[str]:
    """Files that name one bound of a band and not the other."""
    directory = tests_dir or TESTS_DIR
    out = []
    for path in sorted(directory.glob("test_*.py")):
        try:
            assigns = _module_assignments(ast.parse(path.read_text()))
        except SyntaxError:
            continue
        has_low = any(
            _const_int(_sole(assigns, n)) is not None
            for n in _BAND_LOW_NAMES
        )
        has_high = any(
            _const_int(_sole(assigns, n)) is not None
            for n in _BAND_HIGH_NAMES
        )
        if has_low != has_high:
            out.append(path.name)
    return out


# The parameter names a helper's default id hides behind. Matched by
# SUFFIX, not equality: the tree uses `telegram_id`, `master_telegram_id`
# and `admin_telegram_id`, and an exact match would silently skip two of
# the three.
_TELEGRAM_ID_SUFFIX = "telegram_id"


@dataclass(frozen=True)
class DefaultOutOfBand:
    file: str
    function: str
    parameter: str
    value: int
    ranges: tuple[tuple[int, int], ...]


def _resolve_int(
    node: ast.expr, assigns: dict[str, list[ast.expr]]
) -> int | None:
    """A default's numeric value, when it can be read WITHOUT guessing.

    Three shapes, all of which appear or plausibly will: a literal, a
    module constant (`= _TID_MIN`), and a constant plus a literal
    (`= _TID_MIN + 5`). Anything else -- a call, an f-string, arithmetic
    on two names -- returns None and is skipped in silence. Evaluating
    other people's expressions is exactly how two inventories were
    miscounted while T-58 was being written; a default this reader
    cannot read is left to the human, not guessed at.
    """
    value = _const_int(node)
    if value is not None:
        return value
    if isinstance(node, ast.Name):
        return _const_int(_sole(assigns, node.id))
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _resolve_int(node.left, assigns)
        right = _const_int(node.right)
        if left is not None and right is not None:
            return left + right
    return None


def defaults_out_of_band(
    tests_dir: Path | None = None,
) -> list[DefaultOutOfBand]:
    """Helper defaults holding an id outside their own file's band.

    THE DEFAULT ITSELF IS NOT THE PROBLEM. A local
    `telegram_id: int = 94900` next to a declared 94000-94999 is good
    practice -- it stops the same number being repeated in twenty call
    sites. (The one removed in T-58 was different in kind: it sat in the
    SHARED helpers.py, where a forgotten argument put a user in a band
    belonging to whichever file happened to be calling.) What this finds
    is a default that has drifted out of its file's band -- typically by
    being copied into a new file along with the helper around it, which
    nothing today would notice.

    THIS IS NOT THE OVERLAP CHECK IN ANOTHER FORM, and the distinction
    is worth keeping when someone later reads them side by side.
    test_admin_practices and test_admin_stats_overview both default an
    admin to 94900 and both are INSIDE their own declared bands, so this
    check is silent about them -- their problem is that the two bands
    are the same band, which is the overlap check's question and is
    recorded in KNOWN_OVERLAPS. Two checks, two questions; neither is a
    duplicate of the other.

    SILENT BY DESIGN in three situations:
      - the file declares no band (the blind zone -- there is nothing to
        compare against, and inventing a comparison would turn thirty-odd
        legitimate files into false alarms);
      - the file's band is inverted (low above high). Nothing can be
        inside such a band, so this check would emit one complaint per
        helper for a single defect that lives in the DECLARATION. The
        marker belongs to inverted(), which points at the band itself;
      - the file declares its band more than once, so which band to
        compare against is itself unknown -- multiple_declarations()
        fails for it and pointing a second finger would only obscure
        the first.
    """
    directory = tests_dir or TESTS_DIR
    ambiguous = {name for name, _ in multiple_declarations(directory)}
    found: list[DefaultOutOfBand] = []
    for path in sorted(directory.glob("test_*.py")):
        if path.name in ambiguous:
            continue
        ranges = _ranges_in(path)
        if not ranges or any(low > high for low, high in ranges):
            continue
        try:
            tree = ast.parse(path.read_text())
        except SyntaxError:
            continue
        assigns = _module_assignments(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            args = node.args
            positional = list(args.posonlyargs) + list(args.args)
            defaulted = list(
                zip(
                    positional[len(positional) - len(args.defaults):],
                    args.defaults,
                    strict=True,
                )
            )
            defaulted += [
                (arg, default)
                for arg, default in zip(
                    args.kwonlyargs, args.kw_defaults, strict=True
                )
                if default is not None
            ]
            for arg, default in defaulted:
                if not arg.arg.endswith(_TELEGRAM_ID_SUFFIX):
                    continue
                value = _resolve_int(default, assigns)
                if value is None:
                    continue
                if any(low <= value <= high for low, high in ranges):
                    continue
                found.append(
                    DefaultOutOfBand(
                        path.name, node.name, arg.arg, value, tuple(ranges)
                    )
                )
    return found


def cleanup_record(path: Path) -> CleanupRecord | None:
    """The widest cleanup range this file asks for, read from the call."""
    try:
        tree = ast.parse(path.read_text())
    except SyntaxError:
        return None
    assigns = _module_assignments(tree)
    widest: CleanupRecord | None = None
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = (
            func.attr if isinstance(func, ast.Attribute)
            else getattr(func, "id", None)
        )
        if name not in _CLEANUP_CALLS or len(node.args) < 3:
            continue

        def resolve(arg: ast.expr) -> int | None:
            value = _const_int(arg)
            if value is not None:
                return value
            if isinstance(arg, ast.Name):
                return _const_int(_sole(assigns, arg.id))
            return None

        low, high = resolve(node.args[1]), resolve(node.args[2])
        if low is None or high is None:
            continue
        delete_users: bool | None = None
        for keyword in node.keywords:
            if keyword.arg == "delete_users" and isinstance(
                keyword.value, ast.Constant
            ):
                delete_users = bool(keyword.value.value)
        record = CleanupRecord(low, high, delete_users)
        if widest is None or record.width > widest.width:
            widest = record
    return widest


def _uses_telegram_ids(tree: ast.Module) -> bool:
    """Does this file actually create or sweep users by telegram id?

    Deliberately narrow: the WORD `telegram_id` appears in prose all
    over the suite, including in this registry's own tests. What counts
    is a numeric id being passed, or a cleanup being asked for -- those
    are the two ways a file can collide with another one.
    """
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.keyword)
            and node.arg == "telegram_id"
            and _const_int(node.value) is not None
        ):
            return True
        if isinstance(node, ast.Attribute) and node.attr == "between":
            return True
        if isinstance(node, ast.Call):
            func = node.func
            name = (
                func.attr if isinstance(func, ast.Attribute)
                else getattr(func, "id", None)
            )
            if name in _CLEANUP_CALLS:
                return True
    return False


def undeclared_files(tests_dir: Path | None = None) -> list[str]:
    """Files that use telegram ids but declare no band the reader sees."""
    directory = tests_dir or TESTS_DIR
    out = []
    for path in sorted(directory.glob("test_*.py")):
        if _ranges_in(path):
            continue
        try:
            tree = ast.parse(path.read_text())
        except SyntaxError:
            continue
        if _uses_telegram_ids(tree):
            out.append(path.name)
    return out


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def find_overlaps(bands: list[Band] | None = None) -> list[tuple[Band, Band]]:
    """Every pair of declared bands that overlap, each pair once.

    WHAT THIS DOES NOT SEE, and it must be said here rather than in a
    commit message: the files in BLIND_ZONE declare nothing, so they
    cannot collide in this function's eyes no matter how much they
    sweep. `test_ai_summary.py` deletes across the whole of 89000-89999
    and this check is blind to it. A GREEN RESULT IS NOT PROOF THAT NO
    BANDS COLLIDE -- it is proof that the declared ones do not.

    The strong form -- where the registry HANDS OUT numbers and a bare
    `telegram_id` literal in a test is itself a failure -- is named as
    the next step, not built here. See the KNOWN CEILING below.

    # KNOWN CEILING (weak form: declarations are checked, usage is not;
    # acknowledged by design):
    #   1. Mechanics: this reads what files DECLARE. Around forty files
    #      declare nothing and pass literals to their cleanup call, so
    #      their ranges never enter the comparison. The check cannot be
    #      strengthened by reading usages instead -- ids are computed,
    #      generated and interpolated in nine different spellings, and
    #      two attempts to count them by hand were wrong on the same
    #      day.
    #   2. Status: acknowledged by design.
    #   3. Backlog ref: none -- the strong form is described in item 5
    #      below rather than deferred to a ticket nobody will find.
    #   4. Promotion trigger: `pytest-xdist` appears in the dependencies,
    #      OR two runs share one stand. Either ends the property that
    #      makes today's overlaps harmless -- serial execution -- and at
    #      that moment every pair in KNOWN_OVERLAPS fires at once.
    #   5. Agreed fix: the registry becomes the ALLOCATOR. Files ask it
    #      for their numbers, a bare five-digit literal next to
    #      `telegram_id=` becomes a check failure, and collisions stop
    #      being possible by construction rather than by inspection.
    #      Cost: migrating some sixty files in a repository with no CI,
    #      which is why it waits for the trigger.
    #   6. Rejected: doing the strong form now. Sixty files of churn,
    #      verified only by one person running the suite by hand, to
    #      prevent something that cannot happen while the runner stays
    #      serial. Also rejected: labelling blind-zone files by
    #      comparing swept range against usage -- see BLIND_ZONE for
    #      why a computed label there would be worse than none.
    """
    items = sorted(
        bands if bands is not None else declared_bands(),
        key=lambda b: (b.low, b.high, b.file),
    )
    pairs = []
    for index, first in enumerate(items):
        for second in items[index + 1:]:
            if first.file == second.file:
                continue
            if first.overlaps(second):
                pairs.append((first, second))
    return pairs


def out_of_space(bands: list[Band] | None = None) -> list[Band]:
    """Bands declared outside the space we allocate from."""
    items = bands if bands is not None else declared_bands()
    return [
        b
        for b in items
        if not any(lo <= b.low and b.high <= hi for lo, hi in ALLOWED_SPACE)
    ]


def inverted(bands: list[Band] | None = None) -> list[Band]:
    """Bands whose low bound is above the high one.

    Worth its own check because such a band is not merely wrong on
    paper: `between(high, low)` matches nothing, so the file's cleanup
    silently stops cleaning and nothing fails until a neighbour trips
    over the leftovers.
    """
    items = bands if bands is not None else declared_bands()
    return [b for b in items if b.low > b.high]


def known_overlap_pairs() -> set[frozenset[str]]:
    return {frozenset(entry.files) for entry in KNOWN_OVERLAPS}


def _subtract(
    windows: list[tuple[int, int]],
    cut: Iterable[tuple[int, int]],
) -> list[tuple[int, int]]:
    """Remove every `cut` range from `windows`, splitting where needed."""
    result = list(windows)
    for cut_low, cut_high in cut:
        remaining: list[tuple[int, int]] = []
        for low, high in result:
            if cut_high < low or cut_low > high:
                remaining.append((low, high))
                continue
            if low < cut_low:
                remaining.append((low, cut_low - 1))
            if cut_high < high:
                remaining.append((cut_high + 1, high))
        result = remaining
    return sorted(result)


def free_windows(
    space: tuple[int, int] = (89000, 89999),
    bands: list[Band] | None = None,
    reserved: Iterable[tuple[int, int]] | None = None,
) -> list[tuple[int, int]]:
    """Stretches inside `space` that are free to claim.

    RESERVED RANGES ARE SUBTRACTED, NOT ANNOTATED (T-59). This function
    feeds the map that replaced the deleted document, and the map's whole
    reason to exist is that a person choosing a band should be able to
    take a line at face value. Returning 89600-89699 with a footnote
    saying part of it is reserved recreates the artefact we buried: a
    register that is only correct if you read the small print. A
    reserved range is printed on its own line in the map instead, so it
    stays visible without being offered.

    `reserved` is a parameter rather than a straight read of RESERVED so
    that the behaviour can be pinned on ranges we control -- otherwise
    every double here rides on whatever single reservation happens to
    exist today and moves when it moves.
    """
    items = sorted(
        (b for b in (bands if bands is not None else declared_bands())
         if b.high >= space[0] and b.low <= space[1]),
        key=lambda b: b.low,
    )
    windows = []
    cursor = space[0]
    for band in items:
        if band.low > cursor:
            windows.append((cursor, band.low - 1))
        cursor = max(cursor, band.high + 1)
    if cursor <= space[1]:
        windows.append((cursor, space[1]))

    cut = RESERVED if reserved is None else reserved
    return _subtract(windows, cut)


# ---------------------------------------------------------------------------
# The map -- what the deleted document was for
# ---------------------------------------------------------------------------
def render_map() -> str:
    """The occupancy map, for a human choosing a band.

    Deleting docs/telegram-id-bands.md removed the artefact people
    actually read before claiming numbers. Reading declarations instead
    of copying them means the map cannot drift -- but it also means
    somebody has to be able to PRINT it, or the next person will pick a
    band by grepping, which is the method being retired here.

    Reachable two ways on purpose: `python -m tests.telegram_id_bands`
    for someone choosing a band, and automatically in the failure output
    of the check for someone who just broke it.
    """
    bands = declared_bands()
    lines = ["DECLARED BANDS", "--------------"]
    for band in sorted(bands, key=lambda b: (b.low, b.file)):
        lines.append(f"  {band.low}-{band.high}  {band.file}")

    # Free means free: reserved stretches are already subtracted by
    # free_windows, not footnoted here. A line in this section can be
    # taken at face value, which is the one thing the document this
    # replaced could not promise.
    lines += ["", "FREE WINDOWS IN 89xxx", "---------------------"]
    for low, high in free_windows():
        lines.append(f"  {low}-{high}  ({high - low + 1} numbers)")

    # Printed on its own, so subtracting it does not make it invisible:
    # the next person needs to know the gap is deliberate and not a
    # stretch somebody forgot to claim.
    lines += ["", "RESERVED (not free, not claimed by a file)", "-" * 36]
    for (low, high), why in sorted(RESERVED.items()):
        lines.append(f"  {low}-{high}  {why}")

    lines += ["", "KNOWN OVERLAPS (recorded, not fixed)", "-" * 36]
    for entry in KNOWN_OVERLAPS:
        shared = ", ".join(str(n) for n in entry.shared) or "-"
        lines.append(
            f"  [{entry.kind}] {entry.files[0]} x {entry.files[1]}"
            f"  shared ids: {shared}"
        )

    blind_with_cleanup = {k: v for k, v in BLIND_ZONE.items() if v}
    widest = sorted(
        blind_with_cleanup.items(),
        key=lambda kv: kv[1].width,
        reverse=True,
    )
    lines += [
        "",
        f"BLIND ZONE ({len(BLIND_ZONE)} files this check does not protect)",
        "-" * 36,
        "  widest sweeps first; a green check says nothing about these",
    ]
    for name, record in widest[:8]:
        lines.append(
            f"  {record.low}-{record.high}  width {record.width:>5}  "
            f"delete_users={record.delete_users}  {name}"
        )
    no_cleanup = [k for k, v in BLIND_ZONE.items() if v is None]
    lines.append(
        f"  ...and {len(no_cleanup)} files that clean up NOTHING: "
        + ", ".join(sorted(no_cleanup))
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# comms coordination -- deliberately absent
# ---------------------------------------------------------------------------
# This module holds NO copy of the comms repository's bands, and that is
# a decision rather than an omission.
#
# # KNOWN CEILING (no cross-repo band coordination; acknowledged by
# # design):
# #   1. Mechanics: velo and comms both create rows keyed by ids that
# #      look alike, but comms upserts its `Recipient` by the PRODUCT's
# #      UUID -- it has no uniqueness on `telegram_id` and no lookup by
# #      it. A number used on both sides collides with nothing and
# #      misaddresses nothing. There is therefore nothing to coordinate.
# #   2. Status: acknowledged by design.
# #   3. Backlog ref: none.
# #   4. Promotion trigger: comms grows a uniqueness constraint on
# #      `telegram_id`, or starts looking rows up by it. Either turns a
# #      shared number into a real collision.
# #   5. Agreed fix, at that point: allocate the two repositories
# #      disjoint spaces and check them from ONE place that can read
# #      both trees -- not by copying one into the other.
# #   6. Rejected: keeping a copy of comms' bands here. The registry
# #      this replaces did exactly that and half of it was fiction: it
# #      credited comms with 90000-90999 and 91000-91999, while a full
# #      numeric sweep of that tree finds six numbers, all in 92xxx.
# #      A copy of someone else's ranges drifts silently and we did not
# #      notice for nine days.
# #
# # AND WHEN THE TRIGGER FIRES, THE DATA IS ALREADY DIRTY: velo's suite
# # runs against a live stand whose relay ships `user_upserted` into
# # comms, so phantom recipients carrying velo test numbers are sitting
# # in the comms database right now. Whoever acts on this marker has to
# # clean rows, not just rules.


if __name__ == "__main__":
    print(render_map())
