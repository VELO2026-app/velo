# =============================================================================
# VELO -- the band registry checks itself (T-58)
# =============================================================================
# The suite is the only gate this repository has: `.github/` is empty, so
# a script that is not a test is a script that never runs. These are
# therefore tests and not a linter.
#
# They create no users and claim no band -- they read declarations out of
# the tree with ast and compare them. The registry lives in
# tests/telegram_id_bands.py; read its header for what an overlap
# actually destroys and why a green result here proves less than it
# looks.
#
# THE PROPERTY-LEVEL TESTS RUN ON SYNTHETIC DECLARATIONS, not on the
# real tree, and that is deliberate. A test asserting "no overlaps
# anywhere" against 86 live files goes red whenever somebody else edits
# a band, gets read as flaky, and is deleted by the third irritated
# person. The tree-wide assertions are kept to a handful with precise
# messages; everything about HOW the comparison behaves is pinned on
# fixtures we build here.
# =============================================================================

from pathlib import Path

from tests.telegram_id_bands import (
    BLIND_ZONE,
    KNOWN_OVERLAPS,
    Band,
    band_sources,
    cleanup_record,
    declared_bands,
    defaults_out_of_band,
    find_overlaps,
    free_windows,
    incomplete_declarations,
    inverted,
    known_overlap_pairs,
    multiple_declarations,
    out_of_space,
    render_map,
    undeclared_files,
)

TESTS_DIR = Path(__file__).resolve().parent


def _write(directory: Path, name: str, body: str) -> None:
    (directory / name).write_text(body)


# ---------------------------------------------------------------------------
# The tree
# ---------------------------------------------------------------------------
class TestTheTreeItself:
    def test_no_overlap_outside_the_recorded_ones(self) -> None:
        """Declared bands may only collide where we said they do.

        The recorded ones live in KNOWN_OVERLAPS with a reason each;
        anything else is a new collision and has to be either fixed or
        recorded on purpose.
        """
        known = known_overlap_pairs()
        unexpected = [
            (a, b)
            for a, b in find_overlaps()
            if frozenset((a.file, b.file)) not in known
        ]
        assert not unexpected, (
            "band declarations collide and the collision is not recorded:\n"
            + "\n".join(
                f"  {a.file} ({a.low}-{a.high})  x  "
                f"{b.file} ({b.low}-{b.high})"
                for a, b in unexpected
            )
            + "\n\nEither move one band, or add the pair to "
            "KNOWN_OVERLAPS with a justification.\n\n"
            + render_map()
        )

    def test_no_recorded_overlap_has_outlived_its_problem(self) -> None:
        """A record that no longer describes reality is a lie with a
        justification attached.

        The "this list only shrinks" rule is a convention -- one run
        cannot see the previous one, so nothing stops an append. This
        test covers the other half: once somebody DOES separate two
        bands, the stale entry fails here and has to go.
        """
        live = {frozenset((a.file, b.file)) for a, b in find_overlaps()}
        stale = [
            entry.files
            for entry in KNOWN_OVERLAPS
            if frozenset(entry.files) not in live
        ]
        assert not stale, (
            "KNOWN_OVERLAPS records pairs that no longer overlap -- "
            "delete these entries:\n"
            + "\n".join(f"  {a} x {b}" for a, b in stale)
        )

    def test_blind_zone_has_not_grown(self) -> None:
        """A ratchet on the gap this check cannot see.

        A new file that declares no band is invisible to every
        assertion above. It fails here instead, with the two ways out
        spelled in the message.
        """
        tree = set(undeclared_files())
        frozen = set(BLIND_ZONE)
        appeared = sorted(tree - frozen)
        assert not appeared, (
            "these files use telegram ids and declare no band, so the "
            "overlap check is blind to them:\n"
            + "\n".join(f"  {name}" for name in appeared)
            + "\n\nDeclare a band (BAND_MIN/BAND_MAX or _TID_RANGES), or "
            "add the file to BLIND_ZONE on purpose with its cleanup "
            "range recorded."
        )

    def test_blind_zone_entries_still_describe_the_files(self) -> None:
        """The snapshot is a fact, so it can drift -- and drifting is
        what it is here to catch.

        Recording `(89000, 89999, delete_users=False)` rather than the
        judgement "dangerous" is what makes this possible: a label would
        rot in silence, a range can be re-read on every run.
        """
        drifted = []
        for name, recorded in sorted(BLIND_ZONE.items()):
            path = TESTS_DIR / name
            if not path.exists():
                drifted.append(f"  {name}: file is gone, drop the entry")
                continue
            actual = cleanup_record(path)
            if actual != recorded:
                drifted.append(f"  {name}: recorded {recorded}, found {actual}")
        assert not drifted, (
            "BLIND_ZONE records no longer match the cleanup calls:\n"
            + "\n".join(drifted)
        )

    def test_no_file_declares_its_band_twice(self) -> None:
        """A second declaration is not a duplicate, it is a fork.

        The reader would resolve it -- last write wins for a repeated
        name, first name in the tuple wins across names, _TID_RANGES
        wins outright -- and every resolution is silent. The file would
        then be compared, confidently, against a band its cleanup may
        not sweep. That is worse than the blind zone: there the check
        knows it does not know; here it would be sure and wrong.
        """
        forks = multiple_declarations()
        assert not forks, (
            "these files declare a band more than once, and the reader "
            "would pick one of them SILENTLY:\n"
            + "\n".join(
                f"  {name}: "
                + "; ".join(
                    f"{source.written_as} -> {list(source.ranges)}"
                    for source in sources
                )
                for name, sources in forks
            )
            + "\n\nDelete the declarations that are not the real one. "
            "Nothing here will choose for you."
        )

    def test_no_default_id_sits_outside_its_own_band(self) -> None:
        """Local defaults are legitimate; a local default in somebody
        else's band is not.

        Nothing in the tree violates this today. The check exists for
        the day a helper is copied into a new file with its number still
        attached -- which nothing else would notice.
        """
        strays = defaults_out_of_band()
        assert not strays, (
            "helper defaults hold ids outside their file's own band:\n"
            + "\n".join(
                f"  {s.file}: {s.function}({s.parameter}={s.value}) "
                f"but the file declares {list(s.ranges)}"
                for s in strays
            )
        )

    def test_no_half_written_declarations(self) -> None:
        """One bound without the other reads as "no band" to every
        grep, and the file most likely to be wrong is the one that
        disappears quietest."""
        assert incomplete_declarations() == []

    def test_no_inverted_or_out_of_space_bands(self) -> None:
        assert inverted() == []
        assert out_of_space() == []


# ---------------------------------------------------------------------------
# How the comparison behaves -- on fixtures, not on the tree
# ---------------------------------------------------------------------------
class TestOverlapDetection:
    def test_touching_bounds_are_not_an_overlap(self) -> None:
        """Bounds are inclusive: 89400-89499 and 89500-89599 touch.

        Reporting these would produce a dozen false collisions on the
        first run and the check would be switched off inside a week.
        """
        bands = [Band("a.py", 89400, 89499), Band("b.py", 89500, 89599)]
        assert find_overlaps(bands) == []

    def test_a_single_shared_number_is_an_overlap(self) -> None:
        bands = [Band("a.py", 89400, 89499), Band("b.py", 89499, 89599)]
        assert len(find_overlaps(bands)) == 1

    def test_containment_is_an_overlap(self) -> None:
        """The shape that hides best: a small band wholly inside a big
        one never looks like a clash in a sorted list."""
        bands = [Band("big.py", 89441, 89519), Band("small.py", 89442, 89484)]
        assert len(find_overlaps(bands)) == 1

    def test_two_ranges_of_one_file_do_not_collide_with_each_other(
        self,
    ) -> None:
        """A file declaring disjoint clusters is one holder, not two."""
        bands = [Band("a.py", 89000, 89022), Band("a.py", 89900, 89999)]
        assert find_overlaps(bands) == []

    def test_a_pair_is_reported_once(self) -> None:
        bands = [Band("a.py", 100, 200), Band("b.py", 150, 250)]
        assert len(find_overlaps(bands)) == 1

    def test_inverted_band_is_caught_rather_than_silently_matching_nothing(
        self,
    ) -> None:
        """`between(high, low)` matches no rows, so an inverted band
        turns its own cleanup off and nothing fails until a neighbour
        trips over the leftovers."""
        assert inverted([Band("a.py", 89999, 89000)]) == [
            Band("a.py", 89999, 89000)
        ]


class TestRepeat:
    def test_the_same_input_gives_the_same_answer(self) -> None:
        bands = [
            Band("a.py", 100, 200),
            Band("b.py", 150, 250),
            Band("c.py", 400, 500),
        ]
        assert find_overlaps(bands) == find_overlaps(bands)

    def test_order_of_declarations_does_not_change_the_result(self) -> None:
        """Files arrive from the filesystem, so the answer must not
        depend on the order they were read in."""
        bands = [Band("a.py", 100, 200), Band("b.py", 150, 250)]
        assert find_overlaps(bands) == find_overlaps(list(reversed(bands)))


class TestEmpty:
    def test_no_bands_at_all(self) -> None:
        assert find_overlaps([]) == []
        assert inverted([]) == []
        assert out_of_space([]) == []

    def test_free_windows_of_an_empty_space_is_the_whole_space(self) -> None:
        """With nothing declared AND nothing reserved, everything is free.

        T-58 asserted this against the live RESERVED, and was right at
        the time: free_windows then returned the reserved stretch too and
        the map footnoted it. T-59 subtracts reserved ranges instead, so
        the same call now answers about the real reservation rather than
        about emptiness. The property worth holding is the one below --
        no bands and no reservations means one unbroken window -- and it
        is now stated with both inputs empty instead of relying on what
        happens to be reserved this month.
        """
        assert free_windows((89000, 89999), [], []) == [(89000, 89999)]

    def test_a_reservation_is_subtracted_not_footnoted(self) -> None:
        """The whole point of T-59: a line in the map can be taken at
        face value. A reserved stretch in the middle of an otherwise
        free space splits it in two."""
        assert free_windows((100, 200), [], [(150, 159)]) == [
            (100, 149),
            (160, 200),
        ]

    def test_a_reservation_at_the_edge_shortens_the_window(self) -> None:
        assert free_windows((100, 200), [], [(190, 200)]) == [(100, 189)]
        assert free_windows((100, 200), [], [(100, 110)]) == [(111, 200)]

    def test_a_reservation_covering_everything_leaves_no_window(
        self,
    ) -> None:
        """Not an empty range, no range: a window of zero numbers would
        be offered to somebody."""
        assert free_windows((100, 200), [], [(50, 300)]) == []

    def test_a_reservation_outside_the_space_changes_nothing(self) -> None:
        assert free_windows((100, 200), [], [(500, 600)]) == [(100, 200)]

    def test_several_reservations_are_all_subtracted(self) -> None:
        assert free_windows(
            (100, 200), [], [(110, 119), (150, 159)]
        ) == [(100, 109), (120, 149), (160, 200)]

    def test_a_reservation_is_subtracted_from_a_gap_between_bands(
        self,
    ) -> None:
        """The realistic shape: the space is already carved up by
        declared bands and the reservation lands inside one of the
        gaps."""
        bands = [Band("a.py", 100, 149), Band("b.py", 300, 399)]
        assert free_windows((100, 399), bands, [(200, 249)]) == [
            (150, 199),
            (250, 299),
        ]

    def test_free_windows_between_declared_bands(self) -> None:
        bands = [Band("a.py", 89000, 89099), Band("b.py", 89200, 89299)]
        assert free_windows((89000, 89399), bands) == [
            (89100, 89199),
            (89300, 89399),
        ]


class TestMissingPieces:
    def test_a_band_written_in_a_comment_is_not_a_declaration(
        self, tmp_path: Path
    ) -> None:
        """The trap that produced a wrong inventory while T-58 was being
        planned: a file describing its NEIGHBOUR's range matches every
        grep for a declaration."""
        _write(
            tmp_path,
            "test_commented.py",
            "# BAND_MIN, BAND_MAX = 89800, 89839  <- someone else's band\n"
            'X = "telegram_id"\n',
        )
        assert declared_bands(tmp_path) == []

    def test_a_band_assigned_inside_a_function_is_not_a_declaration(
        self, tmp_path: Path
    ) -> None:
        _write(
            tmp_path,
            "test_local.py",
            "def f():\n    BAND_MIN, BAND_MAX = 1, 2\n    return BAND_MIN\n",
        )
        assert declared_bands(tmp_path) == []

    def test_half_a_declaration_is_reported_not_swallowed(
        self, tmp_path: Path
    ) -> None:
        _write(tmp_path, "test_half.py", "_TID_MIN = 89000\n")
        assert declared_bands(tmp_path) == []
        assert incomplete_declarations(tmp_path) == ["test_half.py"]

    def test_a_non_integer_bound_is_not_a_band(self, tmp_path: Path) -> None:
        _write(
            tmp_path,
            "test_weird.py",
            '_TID_MIN = "89000"\n_TID_MAX = 89999\n',
        )
        assert declared_bands(tmp_path) == []

    def test_an_unparseable_file_does_not_take_the_check_down(
        self, tmp_path: Path
    ) -> None:
        """A syntax error is somebody else's failing test, not ours: we
        must not turn one broken file into a second, confusing failure.
        """
        _write(tmp_path, "test_broken.py", "def (:\n")
        assert declared_bands(tmp_path) == []
        assert incomplete_declarations(tmp_path) == []

    def test_a_cleanup_call_without_a_range_is_not_a_record(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "test_nocall.py"
        path.write_text("full_cleanup_range(session)\n")
        assert cleanup_record(path) is None

    def test_the_widest_cleanup_call_is_the_recorded_one(
        self, tmp_path: Path
    ) -> None:
        """A file may sweep more than one range; the record has to be
        the one that can hurt a neighbour, not the first one parsed."""
        path = tmp_path / "test_two.py"
        path.write_text(
            "full_cleanup_range(s, 100, 199)\n"
            "full_cleanup_range(s, 1000, 9999, delete_users=True)\n"
        )
        record = cleanup_record(path)
        assert record is not None
        assert (record.low, record.high, record.width) == (1000, 9999, 9000)
        assert record.delete_users is True


class TestDefaultsAgainstTheirBand:
    """T-59. A helper default holding an id from somebody else's band.

    Defaults themselves are legitimate and there are 48 of them in the
    tree; this is not a campaign against them. The failure mode is
    narrow: a helper gets copied into a new file with its number still
    attached, and the number is now in the wrong band. Nothing today
    would notice.
    """

    def test_a_default_inside_the_band_is_clean(self, tmp_path: Path) -> None:
        _write(
            tmp_path,
            "test_ok.py",
            "_TID_MIN = 94000\n_TID_MAX = 94999\n"
            "def _make_admin(telegram_id: int = 94900): ...\n",
        )
        assert defaults_out_of_band(tmp_path) == []

    def test_a_default_outside_the_band_is_reported_with_everything_needed(
        self, tmp_path: Path
    ) -> None:
        """The message has to carry the file, the function, the parameter
        name, the value AND the band -- a report that says only "wrong"
        makes the reader re-derive what the checker already knew."""
        _write(
            tmp_path,
            "test_copied.py",
            "_TID_MIN = 95000\n_TID_MAX = 95999\n"
            "def _make_admin(telegram_id: int = 94900): ...\n",
        )
        (stray,) = defaults_out_of_band(tmp_path)
        assert stray.file == "test_copied.py"
        assert stray.function == "_make_admin"
        assert stray.parameter == "telegram_id"
        assert stray.value == 94900
        assert stray.ranges == ((95000, 95999),)

    def test_all_three_parameter_names_are_matched_by_suffix(
        self, tmp_path: Path
    ) -> None:
        """The tree uses telegram_id, master_telegram_id and
        admin_telegram_id. Matching the exact name would silently skip
        two of the three -- and the two skipped ones are the helpers that
        create the OTHER party, which is where a copied number hides
        best."""
        _write(
            tmp_path,
            "test_names.py",
            "_TID_MIN = 95000\n_TID_MAX = 95999\n"
            "def a(telegram_id: int = 1): ...\n"
            "def b(master_telegram_id: int = 2): ...\n"
            "def c(admin_telegram_id: int = 3): ...\n"
            "def d(practice_id: int = 4): ...\n",
        )
        found = {s.parameter for s in defaults_out_of_band(tmp_path)}
        assert found == {
            "telegram_id",
            "master_telegram_id",
            "admin_telegram_id",
        }

    def test_a_default_in_the_second_of_several_ranges_is_clean(
        self, tmp_path: Path
    ) -> None:
        """test_reviews.py is exactly this shape after T-58: two
        clusters, and its default lives in the second one. A check that
        looked at the first declared range only would fail the file that
        motivated the multi-range form."""
        _write(
            tmp_path,
            "test_multi.py",
            "_TID_RANGES = ((89000, 89022), (89900, 89999))\n"
            "def _make(telegram_id: int = 89900): ...\n",
        )
        assert defaults_out_of_band(tmp_path) == []

    def test_a_file_without_a_band_is_not_a_violation(
        self, tmp_path: Path
    ) -> None:
        """The blind zone stays blind. Thirty-odd files declare nothing
        and pass literals to their cleanup; inventing a comparison for
        them would turn legitimate code into a wall of false alarms and
        the check would be switched off within a week."""
        _write(
            tmp_path,
            "test_nodecl.py",
            "def _make_admin(telegram_id: int = 57900): ...\n",
        )
        assert defaults_out_of_band(tmp_path) == []

    def test_an_inverted_band_is_left_to_the_check_that_owns_it(
        self, tmp_path: Path
    ) -> None:
        """Nothing fits inside an inverted band, so this check would emit
        one complaint per helper for a single defect that lives in the
        DECLARATION. inverted() reports it once, pointing at the band.
        Silence here is deliberate, not an oversight."""
        _write(
            tmp_path,
            "test_inverted.py",
            "_TID_MIN = 95999\n_TID_MAX = 95000\n"
            "def a(telegram_id: int = 95500): ...\n"
            "def b(telegram_id: int = 95501): ...\n",
        )
        assert defaults_out_of_band(tmp_path) == []
        assert len(inverted(declared_bands(tmp_path))) == 1

    def test_a_boundary_value_is_inside(self, tmp_path: Path) -> None:
        _write(
            tmp_path,
            "test_edge.py",
            "_TID_MIN = 95000\n_TID_MAX = 95999\n"
            "def a(telegram_id: int = 95000): ...\n"
            "def b(telegram_id: int = 95999): ...\n",
        )
        assert defaults_out_of_band(tmp_path) == []

    def test_a_module_constant_default_is_resolved(
        self, tmp_path: Path
    ) -> None:
        """`= _TID_MIN` and `= _TID_MIN + 5` are readable without
        guessing, and both are plausible ways to write a default that
        cannot drift."""
        _write(
            tmp_path,
            "test_const.py",
            "_TID_MIN = 95000\n_TID_MAX = 95999\n"
            "def a(telegram_id: int = _TID_MIN): ...\n"
            "def b(telegram_id: int = _TID_MIN + 5): ...\n",
        )
        assert defaults_out_of_band(tmp_path) == []

    def test_an_unreadable_default_is_skipped_not_guessed(
        self, tmp_path: Path
    ) -> None:
        """A call, an f-string, arithmetic on two names: the checker
        stops rather than evaluates. Two hand inventories were miscounted
        during T-58 by exactly this kind of cleverness."""
        _write(
            tmp_path,
            "test_expr.py",
            "_TID_MIN = 95000\n_TID_MAX = 95999\n"
            "def a(telegram_id: int = int(str(1000))): ...\n",
        )
        assert defaults_out_of_band(tmp_path) == []

    def test_a_non_numeric_default_is_not_a_violation(
        self, tmp_path: Path
    ) -> None:
        """`telegram_id: int | None = None` is a legitimate signature."""
        _write(
            tmp_path,
            "test_none.py",
            "_TID_MIN = 95000\n_TID_MAX = 95999\n"
            "def a(telegram_id=None): ...\n"
            'def b(telegram_id="x"): ...\n',
        )
        assert defaults_out_of_band(tmp_path) == []

    def test_a_parameter_without_a_default_is_out_of_scope(
        self, tmp_path: Path
    ) -> None:
        _write(
            tmp_path,
            "test_nodefault.py",
            "_TID_MIN = 95000\n_TID_MAX = 95999\n"
            "def a(telegram_id: int): ...\n",
        )
        assert defaults_out_of_band(tmp_path) == []

    def test_keyword_only_and_nested_functions_are_checked_too(
        self, tmp_path: Path
    ) -> None:
        """A helper defined inside a fixture creates users exactly like a
        top-level one, and a keyword-only parameter is still a default."""
        _write(
            tmp_path,
            "test_nested.py",
            "_TID_MIN = 95000\n_TID_MAX = 95999\n"
            "def outer():\n"
            "    def inner(*, telegram_id: int = 1234): ...\n"
            "    return inner\n",
        )
        (stray,) = defaults_out_of_band(tmp_path)
        assert (stray.function, stray.value) == ("inner", 1234)

    def test_repeat_gives_the_same_answer(self, tmp_path: Path) -> None:
        _write(
            tmp_path,
            "test_rep.py",
            "_TID_MIN = 95000\n_TID_MAX = 95999\n"
            "def a(telegram_id: int = 1): ...\n",
        )
        assert defaults_out_of_band(tmp_path) == defaults_out_of_band(
            tmp_path
        )

    def test_an_empty_directory_is_clean(self, tmp_path: Path) -> None:
        assert defaults_out_of_band(tmp_path) == []

    def test_an_unparseable_file_does_not_take_the_check_down(
        self, tmp_path: Path
    ) -> None:
        _write(tmp_path, "test_broken.py", "def (:\n")
        assert defaults_out_of_band(tmp_path) == []


class TestMultipleDeclarations:
    """T-59. A file that says two different things about its own band.

    The reader has three ways to resolve this and every one of them is
    silent, so the file ends up compared -- confidently -- against a
    band its cleanup may not sweep. Worse than the blind zone: there the
    check knows it does not know; here it would be sure and wrong.
    """

    def test_one_declaration_is_clean(self, tmp_path: Path) -> None:
        _write(tmp_path, "test_one.py", "_TID_MIN = 1\n_TID_MAX = 2\n")
        assert multiple_declarations(tmp_path) == []

    def test_no_declaration_is_clean(self, tmp_path: Path) -> None:
        """The blind zone must NOT be turned into a false alarm on
        thirty-odd files -- absence of a declaration is the state this
        check is explicitly silent about."""
        _write(tmp_path, "test_none.py", "X = 1\n")
        assert multiple_declarations(tmp_path) == []

    def test_the_same_name_written_twice(self, tmp_path: Path) -> None:
        """The first hole: the reader used to keep the LAST assignment,
        so the file answered with a number its own cleanup might not
        use."""
        _write(
            tmp_path,
            "test_twice.py",
            "_TID_MIN = 100\n_TID_MAX = 199\n"
            "_TID_MIN = 500\n_TID_MAX = 599\n",
        )
        ((name, sources),) = multiple_declarations(tmp_path)
        assert name == "test_twice.py"
        assert {src.ranges for src in sources} == {
            ((100, 199),),
            ((500, 599),),
        }

    def test_two_different_names_from_the_same_group(
        self, tmp_path: Path
    ) -> None:
        """The second hole: _BAND_LOW_NAMES is scanned in order and the
        FIRST non-empty one won, regardless of which name the file's
        cleanup actually reads."""
        _write(
            tmp_path,
            "test_names.py",
            "BAND_MIN, BAND_MAX = 100, 199\n_TID_MIN = 500\n_TID_MAX = 599\n",
        )
        ((_, sources),) = multiple_declarations(tmp_path)
        assert {src.written_as for src in sources} == {
            "BAND_MIN/BAND_MAX",
            "_TID_MIN/_TID_MAX",
        }

    def test_ranges_form_alongside_a_pair(self, tmp_path: Path) -> None:
        """The third hole: _TID_RANGES returned early and the pair was
        never even looked at."""
        _write(
            tmp_path,
            "test_both.py",
            "_TID_RANGES = ((100, 199),)\n_TID_MIN = 500\n_TID_MAX = 599\n",
        )
        ((_, sources),) = multiple_declarations(tmp_path)
        assert {src.written_as for src in sources} == {
            "_TID_RANGES",
            "_TID_MIN/_TID_MAX",
        }

    def test_the_defaults_check_stays_quiet_about_an_ambiguous_file(
        self, tmp_path: Path
    ) -> None:
        """One defect, one finger. Which band to compare against is
        precisely what is unknown here, so a second complaint would only
        obscure the first."""
        _write(
            tmp_path,
            "test_fork.py",
            "_TID_MIN = 100\n_TID_MAX = 199\n"
            "_TID_MIN = 500\n_TID_MAX = 599\n"
            "def a(telegram_id: int = 9999): ...\n",
        )
        assert defaults_out_of_band(tmp_path) == []
        assert len(multiple_declarations(tmp_path)) == 1

    def test_band_sources_reports_everything_it_found(
        self, tmp_path: Path
    ) -> None:
        """The report must show what was found, not a winner: choosing
        is the bug being fixed."""
        _write(
            tmp_path,
            "test_src.py",
            "_TID_RANGES = ((1, 2),)\nBAND_MIN, BAND_MAX = 10, 20\n",
        )
        sources = band_sources(tmp_path / "test_src.py")
        assert len(sources) == 2

    def test_repeat_gives_the_same_answer(self, tmp_path: Path) -> None:
        _write(
            tmp_path,
            "test_rep.py",
            "_TID_MIN = 1\n_TID_MAX = 2\n_TID_MIN = 3\n_TID_MAX = 4\n",
        )
        assert multiple_declarations(tmp_path) == multiple_declarations(
            tmp_path
        )

    def test_an_empty_directory_is_clean(self, tmp_path: Path) -> None:
        assert multiple_declarations(tmp_path) == []


class TestTheMap:
    def test_the_map_names_the_things_a_chooser_needs(self) -> None:
        """Deleting the document removed what people read before
        claiming numbers; this is its replacement, and it is generated
        rather than remembered."""
        rendered = render_map()
        assert "DECLARED BANDS" in rendered
        assert "FREE WINDOWS" in rendered
        assert "KNOWN OVERLAPS" in rendered
        assert "BLIND ZONE" in rendered
        assert "test_ai_summary.py" in rendered
