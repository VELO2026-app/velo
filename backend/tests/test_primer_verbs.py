"""The verbs and seeds of primer.yaml against what they run (BE-195).

The deploy machine runs a verb or a seed by its `run` in the app container
and passes each name of `args` as one value, in the order listed. The
machine itself only reads the form; what the commands are is ours. So:

* every seed is one file of scripts/seed_profiles/, and every file is a
  seed -- a profile added without a seed, or a seed whose file is gone,
  is red here, not on the stand;
* every command names a script that exists in this tree;
* a verb that deletes is `destructive`; the seeds are reset by the machine's
  `pridem seed ... --reset` (machine v0.1.8), by the commands `reset`,
  `reset_only` of each seed and `seeds_reset_all` of the stack -- no verb
  runs seed.py, and no seed, so no reset, runs on prod (`roles`);
* the three commands of a seed name its one file and a mode seed.py has;
* the two scripts read their arguments in the form primer.yaml gives them:
  `ids` of comms_outbox.py as one comma-joined value, the profile of
  seed.py as a name of seed_profiles/ and nothing else.

primer.yaml is read from the repository root (in the test image it is at
/, where Path(__file__).resolve().parents[2] lands from /app/tests);
the scripts from the backend directory (/app/scripts in the image).
"""

import json
import re
import shlex
from pathlib import Path

import pytest
import yaml

from scripts import comms_outbox, seed

ROOT = Path(__file__).resolve().parents[2]
PRIMER = ROOT / "primer.yaml"
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
PROFILES = SCRIPTS / "seed_profiles"

# The machine's name of a seed or a verb (DM-78).
MACHINE_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,62}")
DESTRUCTIVE = {"comms-outbox-requeue-all"}
NOT_ON_PROD = ["test", "preview"]
SEED_PY = ["python", "scripts/seed.py"]


def _primer() -> dict:
    return yaml.safe_load(PRIMER.read_text(encoding="utf-8"))


def _seeds() -> dict:
    seeds = _primer()["stacks"]["velo"]["seeds"]
    assert isinstance(seeds, dict) and seeds, "the stack velo declares seeds"
    return {str(name): spec for name, spec in seeds.items()}


def _jobs_of(entry: str) -> set[str]:
    stack = _primer()["stacks"][entry]
    return {job["service"] for job in (stack.get("jobs") or {}).values()}


def _on_a_job(verb: dict) -> bool:
    """A verb whose service is a job of its entry (machine 24b4ea8, DM-86
    pass 4b): a one-off container, `run` being the words after the job's
    entrypoint -- no command of this tree."""
    entry = verb.get("entry", _primer()["name"])
    return verb.get("service") in _jobs_of(entry)


def _app_verbs() -> dict:
    """The verbs the app runs: `python scripts/<x>.py` of this tree."""
    verbs = {n: v for n, v in _verbs().items() if not _on_a_job(v)}
    assert verbs, "the app runs verbs"
    return verbs


def _script(verb: dict) -> str:
    return shlex.split(verb["run"])[1]


def _verbs() -> dict:
    verbs = _primer()["verbs"]
    assert isinstance(verbs, dict) and verbs, "primer.yaml declares verbs"
    return verbs


# -- primer.yaml ---------------------------------------------------------------


def test_every_profile_is_a_seed_and_every_seed_a_profile() -> None:
    """Each file of seed_profiles/ is a seed, and each seed is a file -- run
    on command, and on the roles test and preview only: a profile is demo
    people and their data (BE-195 part 2). The machine's resets of a seed
    run on the seed's roles, so NOT_ON_PROD keeps them off prod too.

    Was `{run, when, roles}` exactly -- right while the resets were verbs of
    primer.yaml. Machine v0.1.8 resets a seed by the seed's own commands
    `reset` and `reset_only` (BE-194 part 12), so the seed carries them,
    each naming the profile's file literally: the machine puts nothing in."""
    files = sorted(p.stem for p in PROFILES.glob("*.json"))
    assert files, f"{PROFILES} holds profiles"
    seeds = _seeds()
    assert sorted(seeds) == sorted(stem.lower() for stem in files)
    for stem in files:
        spec = seeds[stem.lower()]
        assert spec == {
            "run": f"python scripts/seed.py --profile {stem}",
            "reset": f"python scripts/seed.py --reset --profile {stem}",
            "reset_only": f"python scripts/seed.py --reset-only --profile {stem}",
            "when": "command",
            "roles": NOT_ON_PROD,
        }, stem


def test_every_name_is_a_machine_name() -> None:
    names = [*_seeds(), *_verbs()]
    bad = [n for n in names if not MACHINE_NAME.fullmatch(n)]
    assert not bad, f"not ^[a-z0-9][a-z0-9_-]{{0,62}}$: {bad}"


def test_every_command_names_a_script_of_this_tree() -> None:
    """Every seed and every verb the app runs names a script of this tree.
    Was every verb -- right while all verbs ran in the app; a verb on a job
    (machine 24b4ea8) runs the job's own entrypoint, and
    test_storage_check_is_the_jobs_check_and_ci_runs_it_so holds it."""
    commands = {f"seed {n}": s["run"] for n, s in _seeds().items()}
    commands |= {f"verb {n}": v["run"] for n, v in _app_verbs().items()}
    for where, run in commands.items():
        words = shlex.split(run)
        assert words[:1] == ["python"] and len(words) > 1, f"{where}: {run!r}"
        script = words[1]
        assert script.startswith("scripts/"), f"{where}: {run!r}"
        assert (SCRIPTS.parent / script).is_file(), f"{where}: {script} is missing"


def test_a_verb_that_deletes_is_destructive_and_a_reset_never_runs_on_prod() -> None:
    """A verb that deletes is `destructive`; the seeds are reset by the
    machine's `pridem seed`, never by a verb.

    Was: every verb on seed.py is destructive and on test and preview -- right
    while the resets were the verbs seed-reset, seed-reset-only and
    seed-reset-all (BE-195). Machine v0.1.8 runs a reset by the commands of
    the seed and of the stack (BE-194 part 12): a verb on seed.py would be a
    second way to the same reset, so none is left. The pair: every seed has
    both resets and the stack has seeds_reset_all, on roles that keep them
    off prod -- `--reset-all` runs on the roles every profile allows."""
    verbs = _verbs()
    marked = {n for n, v in verbs.items() if v.get("destructive") is True}
    assert marked == DESTRUCTIVE
    # A verb on a job has no script (machine 24b4ea8); the jobs' verbs are
    # held whole by test_storage_check_is_the_jobs_check_and_ci_runs_it_so.
    on_seed = [n for n, v in _app_verbs().items() if _script(v) == SEED_PY[1]]
    assert not on_seed, f"a verb runs seed.py: {on_seed}"
    seeds = _seeds()
    for name, spec in seeds.items():
        assert spec.get("reset") and spec.get("reset_only"), name
    assert _primer()["stacks"]["velo"].get("seeds_reset_all")
    every = set.intersection(*(set(spec["roles"]) for spec in seeds.values()))
    assert every == set(NOT_ON_PROD), "--reset-all runs on test and preview only"
    assert "comms-outbox" not in verbs, "the verb with `command` is gone"


def test_the_signature_measurement_runs_on_every_role_and_wipes_nothing() -> None:
    """BE-195 part 3: the measurement BE-183 is decided on (BE-201) is taken
    on prod. The machine takes no optional argument -- each declared arg is
    required (`verb <n> <arg>=<value>`) -- so `--since` is a second verb.
    Both are compared whole: any `roles` (prod must stay in), `destructive`
    or `service` (the app runs it) is red here. Found among the verbs the
    app runs -- a verb on a job has no script (machine 24b4ea8)."""
    measuring = {
        n: v
        for n, v in _app_verbs().items()
        if _script(v) == "scripts/signature_stats.py"
    }
    assert measuring == {
        "signature-stats": {"run": "python scripts/signature_stats.py"},
        "signature-stats-since": {
            "run": "python scripts/signature_stats.py --since",
            "args": ["since"],
        },
    }


BACKEND_TESTS = ROOT / ".github" / "workflows" / "backend-tests.yml"
STORAGE_CHECK_STEP = "Check velo-storage as the verb storage-check runs it"


def test_storage_check_is_the_jobs_check_and_ci_runs_it_so() -> None:
    """BE-195 part 4: the init's read-only check on demand -- the job of
    velo-storage run by the machine as `compose run --rm --no-deps <service>
    <words of run> <args>` (24b4ea8). The script takes exactly `--check` in
    $1, so `run` is that one word; on every role, wiping nothing. CI runs the
    very command the machine builds: change `run`, and CI must follow."""
    on_jobs = {n: v for n, v in _verbs().items() if _on_a_job(v)}
    assert on_jobs == {
        "storage-check": {
            "run": "--check",
            "entry": "velo-storage",
            "service": "velo-storage-init",
        }
    }
    verb = on_jobs["storage-check"]
    primer = _primer()
    assert verb["entry"] in primer["stacks"] and verb["entry"] != primer["name"]
    assert verb["service"] in _jobs_of(verb["entry"])
    machine = ["velo-storage-init", *shlex.split(verb["run"])]
    jobs = yaml.safe_load(BACKEND_TESTS.read_text(encoding="utf-8"))["jobs"]
    steps = [
        s
        for j in jobs.values()
        for s in j["steps"]
        if s.get("name") == STORAGE_CHECK_STEP
    ]
    assert len(steps) == 1, f"backend-tests.yml: one step {STORAGE_CHECK_STEP!r}"
    words = shlex.split(steps[0]["run"].replace("\\\n", " "), comments=True)
    at = words.index("run")
    assert words[at : at + 4] == ["run", "--rm", "--no-deps", "-T"], words
    assert words[at + 4 :] == machine, words


# -- comms_outbox.py: `ids` is one comma-joined value --------------------------


@pytest.mark.parametrize(
    ("raw", "ids"), [("12", [12]), ("12,15", [12, 15]), ("3,1,2", [3, 1, 2])]
)
def test_ids_are_read_in_order(raw: str, ids: list[int]) -> None:
    assert comms_outbox._event_ids(raw) == ids


@pytest.mark.parametrize(
    "raw",
    ["", ",", "12,", ",12", "12,,15", "12,12", "0", "12,-1", "a", "12 15", "1.5"],
)
def test_a_bad_list_of_ids_is_refused(raw: str) -> None:
    with pytest.raises(ValueError):
        comms_outbox._event_ids(raw)


@pytest.mark.parametrize(
    "argv",
    [
        ["requeue"],
        ["requeue", "12", "15"],
        ["requeue", "12", "--all"],
        ["requeue", "12,12"],
        ["requeue", ""],
    ],
)
def test_requeue_takes_one_list_or_all(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as refused:
        comms_outbox._parse_args(argv)
    assert refused.value.code == 2


def test_the_verbs_forms_of_the_outbox_parse() -> None:
    assert comms_outbox._parse_args(["list-dead"]).command == "list-dead"
    one = comms_outbox._parse_args(["requeue", "12,15"])
    assert (one.event_ids, one.requeue_all) == ([12, 15], False)
    every = comms_outbox._parse_args(["requeue", "--all"])
    assert (every.event_ids, every.requeue_all) == ([], True)


# -- seed.py: the profile is named, and it is a file of seed_profiles/ --------


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["--reset"],
        ["--reset-only"],
        ["--dry-run"],
        ["--reset-all", "--profile", "15082026"],
        ["--reset-all", "--dry-run"],
        ["--list", "--profile", "15082026"],
    ],
)
def test_the_profile_is_named_or_the_run_stands_alone(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as refused:
        seed._parse_args(argv)
    assert refused.value.code == 2


# What seed.py does by each command of primer.yaml, as its parsed arguments:
# (reset, reset_only, reset_all). `--reset-only` sets `reset` too (seed.py).
MODES = {
    "run": (False, False, False),
    "reset": (True, False, False),
    "reset_only": (True, True, False),
}


def _parsed(command: str):
    words = shlex.split(command)
    assert words[:2] == SEED_PY, command
    assert (SCRIPTS.parent / SEED_PY[1]).is_file()
    return seed._parse_args(words[2:])


def test_the_commands_of_each_seed_name_its_file_and_a_mode_of_seed_py() -> None:
    """The three commands of a seed, as seed.py itself parses them: each
    names the seed's one file of seed_profiles/, and each is the mode its
    field means -- seed, reset and seed, reset alone. `seeds_reset_all` is
    the mode that takes back every profile and names none.

    Replaces a test that parsed the four forms written into it -- right
    while the forms lived in the verbs, as literals of their own. Since
    machine v0.1.8 (BE-194 part 12) the forms are the commands of
    primer.yaml, so they are read from there: a flag renamed in seed.py, or
    a command naming another profile's file, is red here, not on the box."""
    files = {p.stem.lower(): p.stem for p in PROFILES.glob("*.json")}
    seeds = _seeds()
    assert seeds and sorted(seeds) == sorted(files)
    for name, spec in seeds.items():
        for field, mode in MODES.items():
            args = _parsed(spec[field])
            assert args.profile == files[name], (name, field)
            assert (args.reset, args.reset_only, args.reset_all) == mode, (
                name,
                field,
            )
            assert (args.dry_run, args.list) == (False, False), (name, field)
    every = _parsed(_primer()["stacks"]["velo"]["seeds_reset_all"])
    assert (every.reset_all, every.profile, every.reset) == (True, None, False)
    assert (every.dry_run, every.list) == (False, False)


@pytest.mark.parametrize("name", ["../x", "x/../x", "sub/x", "", "nope", "X"])
def test_a_profile_outside_the_directory_is_refused_and_not_read(
    name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    profiles = tmp_path / "profiles"
    (profiles / "sub").mkdir(parents=True)
    (profiles / "x.json").write_text(json.dumps({"description": "inside"}))
    (profiles / "sub" / "x.json").write_text(json.dumps({"description": "below"}))
    (tmp_path / "x.json").write_text(json.dumps({"description": "outside"}))
    monkeypatch.setattr(seed, "PROFILES_DIR", profiles)
    with pytest.raises(SystemExit) as refused:
        seed.load_profile(name)
    message = str(refused.value.code)
    assert "not found" in message and "Available: x" in message


def test_a_profile_of_the_directory_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "x.json").write_text(json.dumps({"description": "inside"}))
    monkeypatch.setattr(seed, "PROFILES_DIR", tmp_path)
    assert seed.load_profile("x") == {"description": "inside"}
