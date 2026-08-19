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
    cleanup_record,
    declared_bands,
    find_overlaps,
    free_windows,
    incomplete_declarations,
    inverted,
    known_overlap_pairs,
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
        assert free_windows((89000, 89999), []) == [(89000, 89999)]

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
