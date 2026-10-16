"""BE-133: the object storage registry -- the real file, and every way to break it.

storage_registry.yaml is the one source the storage init, `velo doctor` and the
backend all read. These tests need no storage: they pin what the file says
today, and that a malformed file is refused instead of read with defaults.
Axes: REPEAT (a key written twice), EMPTINESS (empty sections), SHORTAGE
(a missing field), plus wrong shapes.
"""

from __future__ import annotations

import pytest

from app.core.storage_registry import (
    REGISTRY_PATH,
    RegistryError,
    load_registry,
    parse_registry_text,
)

VALID = """\
test_bucket_suffix: "-test"
buckets:
  voice:
    expire_days: 1
    backup: false
    reader: signed_link
service_keys:
  velo-app:
    secret_env: STORAGE_SECRET_KEY
    actions: [s3:GetObject, s3:PutObject]
"""


class TestRealRegistry:
    def test_types_are_exactly_voice_and_master_documents(self) -> None:
        registry = load_registry()
        assert [b.name for b in registry.buckets] == ["voice", "master-documents"]

    def test_voice_lives_one_day_read_by_signed_link_no_backup(self) -> None:
        voice = load_registry().bucket_type("voice")
        assert voice.expire_days == 1
        assert voice.reader == "signed_link"
        assert voice.backup is False

    def test_master_documents_no_expiry_api_only_backed_up(self) -> None:
        docs = load_registry().bucket_type("master-documents")
        assert docs.expire_days is None
        assert docs.reader == "api"
        assert docs.backup is True

    def test_voice_entry_carries_the_24_to_48_hours_note(self) -> None:
        """Owner ruling (BE-133 answer, p.6): the prose about what "a day"
        means sits next to voice in the registry itself."""
        text = REGISTRY_PATH.read_text(encoding="utf-8")
        voice_block = text.split("  voice:", 1)[1].split("  master-documents:", 1)[0]
        assert "24 to" in voice_block and "48" in voice_block
        assert "midnight UTC" in voice_block

    def test_one_service_key_named_in_code_its_secret_in_the_env(self) -> None:
        registry = load_registry()
        assert [k.name for k in registry.service_keys] == ["velo-app"]
        key = registry.key_for_secret("STORAGE_SECRET_KEY")
        assert key.name == "velo-app"

    def test_service_key_moves_objects_and_nothing_else(self) -> None:
        """No bucket creation, no policy or lifecycle changes: the key the app
        holds can only move objects. Paired: the object actions ARE there."""
        actions = set(load_registry().service_keys[0].actions)
        assert {"s3:GetObject", "s3:PutObject", "s3:DeleteObject"} <= actions
        assert not any(
            a.startswith(
                ("s3:Create", "s3:PutBucket", "s3:DeleteBucket", "s3:PutLifecycle")
            )
            for a in actions
        )

    def test_every_type_has_a_test_twin(self) -> None:
        registry = load_registry()
        assert registry.test_bucket_suffix == "-test"
        assert registry.test_bucket_name("voice") == "voice-test"
        assert registry.test_bucket_name("master-documents") == "master-documents-test"

    def test_unknown_type_is_a_key_error(self) -> None:
        with pytest.raises(KeyError):
            load_registry().bucket_type("photos")


class TestRefusals:
    def test_valid_minimal_document_parses(self) -> None:
        """The baseline every refusal below departs from by one change."""
        registry = parse_registry_text(VALID)
        assert registry.bucket_type("voice").expire_days == 1

    # -- REPEAT --
    def test_bucket_written_twice_is_refused(self) -> None:
        """Plain safe_load keeps the second `voice:` and drops the first."""
        doubled = VALID.replace(
            "service_keys:",
            "  voice:\n    expire_days: 9\n    backup: false\n    reader: api\n"
            "service_keys:",
        )
        with pytest.raises(RegistryError, match="written twice"):
            parse_registry_text(doubled)

    def test_two_keys_sharing_one_secret_are_refused(self) -> None:
        doubled = (
            VALID
            + "  velo-other:\n    secret_env: STORAGE_SECRET_KEY\n"
            + "    actions: [s3:GetObject]\n"
        )
        with pytest.raises(RegistryError, match="share one secret_env"):
            parse_registry_text(doubled)

    def test_duplicate_action_is_refused(self) -> None:
        with pytest.raises(RegistryError, match="actions"):
            parse_registry_text(
                VALID.replace(
                    "[s3:GetObject, s3:PutObject]", "[s3:GetObject, s3:GetObject]"
                )
            )

    # -- EMPTINESS --
    @pytest.mark.parametrize("section", ["buckets", "service_keys"])
    def test_empty_section_is_refused(self, section: str) -> None:
        head, _, _ = VALID.partition(f"{section}:")
        rest = VALID.split(f"{section}:", 1)[1]
        # Drop the section body up to the next top-level key (or the end).
        tail_lines = rest.splitlines()[1:]
        while tail_lines and tail_lines[0].startswith(" "):
            tail_lines.pop(0)
        emptied = head + f"{section}: {{}}\n" + "\n".join(tail_lines) + "\n"
        with pytest.raises(RegistryError, match="non-empty"):
            parse_registry_text(emptied)

    def test_empty_actions_are_refused(self) -> None:
        with pytest.raises(RegistryError, match="actions"):
            parse_registry_text(VALID.replace("[s3:GetObject, s3:PutObject]", "[]"))

    # -- SHORTAGE --
    def test_missing_field_is_refused_not_defaulted(self) -> None:
        with pytest.raises(RegistryError, match="missing \\['backup'\\]"):
            parse_registry_text(VALID.replace("    backup: false\n", ""))

    def test_missing_expire_days_is_refused_null_must_be_written(self) -> None:
        """No expiry is `expire_days: null`, written out -- never an absent field."""
        with pytest.raises(RegistryError, match="expire_days"):
            parse_registry_text(VALID.replace("    expire_days: 1\n", ""))

    def test_missing_suffix_is_refused(self) -> None:
        with pytest.raises(RegistryError):
            parse_registry_text(VALID.replace('test_bucket_suffix: "-test"\n', ""))

    # -- wrong shapes --
    def test_unknown_field_is_refused(self) -> None:
        with pytest.raises(RegistryError, match="unknown \\['public'\\]"):
            parse_registry_text(
                VALID.replace(
                    "    backup: false\n", "    backup: false\n    public: true\n"
                )
            )

    @pytest.mark.parametrize("days", ["0", "-1", "true", '"1"', "1.5"])
    def test_bad_expire_days_is_refused(self, days: str) -> None:
        with pytest.raises(RegistryError, match="expire_days"):
            parse_registry_text(VALID.replace("expire_days: 1", f"expire_days: {days}"))

    def test_null_expire_days_is_accepted(self) -> None:
        assert (
            parse_registry_text(VALID.replace("expire_days: 1", "expire_days: null"))
            .buckets[0]
            .expire_days
            is None
        )

    def test_unknown_reader_is_refused(self) -> None:
        with pytest.raises(RegistryError, match="reader"):
            parse_registry_text(VALID.replace("reader: signed_link", "reader: browser"))

    @pytest.mark.parametrize(
        "name", ["Voice", "voice_notes", "v", "-voice", "voice.notes"]
    )
    def test_bad_bucket_name_is_refused(self, name: str) -> None:
        with pytest.raises(RegistryError, match="bucket name"):
            parse_registry_text(VALID.replace("  voice:", f"  {name}:"))

    def test_bucket_colliding_with_a_test_twin_is_refused(self) -> None:
        colliding = VALID.replace(
            "service_keys:",
            "  voice-test:\n    expire_days: 1\n    backup: false\n    reader: api\n"
            "service_keys:",
        )
        with pytest.raises(RegistryError, match="collides"):
            parse_registry_text(colliding)

    def test_action_outside_s3_is_refused(self) -> None:
        with pytest.raises(RegistryError, match="actions"):
            parse_registry_text(VALID.replace("s3:PutObject]", "admin:CreateUser]"))

    def test_lowercase_secret_env_is_refused(self) -> None:
        with pytest.raises(RegistryError, match="secret_env"):
            parse_registry_text(
                VALID.replace(
                    "secret_env: STORAGE_SECRET_KEY", "secret_env: storage_secret"
                )
            )
