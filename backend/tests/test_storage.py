"""BE-133: the storage module against the LIVE velo-storage, in test buckets.

These tests talk to the real storage at velo-storage:9000 -- on the stand the
app container reaches it over aivis-shared. They work ONLY in the test twins
of the registry types (`<type>-test`), which the storage init creates and the
service key may use; the live buckets are never touched. Without a reachable
storage they FAIL, by design: a skipped storage test would turn the colour of
the suite into a fact about the environment.

The registry is read through the Python loader, independently of the init's
own reading of it: a type that is in the YAML but that the init did not create
fails here (test_every_registry_type_round_trips), and nowhere else -- the
`velo doctor` check is the init's own code and shares its blind spots.

Reading by signed link is done the way comms does it: a plain GET of the URL,
redirects not followed, from inside the docker network.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx
import pytest
from botocore.exceptions import ClientError

from app.core import storage
from app.core.config import settings
from app.core.storage_registry import load_registry

TYPES = [b.name for b in load_registry().buckets]


async def _fetch(url: str) -> httpx.Response:
    """GET as comms does: the URL as given, no redirects."""
    async with httpx.AsyncClient(follow_redirects=False, timeout=10) as client:
        return await client.get(url)


@pytest.fixture
def ids() -> tuple[UUID, UUID]:
    return uuid4(), uuid4()


@pytest.fixture
async def stored_voice(
    ids: tuple[UUID, UUID],
) -> AsyncIterator[tuple[storage.Bucket, UUID, UUID, bytes]]:
    where = storage.bucket("voice", test=True)
    owner, obj = ids
    body = b"BE-133 voice body " + obj.bytes
    await storage.put_object(where, owner, obj, body, "audio/ogg")
    yield where, owner, obj, body
    await storage.delete_object(where, owner, obj)


# --------------------------------------------------------------------------
# Every registry type, through the real storage
# --------------------------------------------------------------------------


@pytest.mark.parametrize("type_name", TYPES)
async def test_every_registry_type_round_trips(
    type_name: str, ids: tuple[UUID, UUID]
) -> None:
    """put -> exists -> delete -> gone, in the test twin of EVERY registry type.

    Kills the mutation "a type was added to the YAML and the init did not
    create its bucket or extend the key's policy": that type fails here.
    """
    where = storage.bucket(type_name, test=True)
    owner, obj = ids
    assert where.name == f"{type_name}-test"
    key = await storage.put_object(where, owner, obj, b"x")
    assert key == f"{owner}/{obj}"
    assert await storage.object_exists(where, owner, obj) is True
    await storage.delete_object(where, owner, obj)
    assert await storage.object_exists(where, owner, obj) is False


async def test_delete_twice_is_not_an_error(ids: tuple[UUID, UUID]) -> None:
    """REPEAT: S3 delete is idempotent, and so is ours."""
    where = storage.bucket("voice", test=True)
    owner, obj = ids
    await storage.put_object(where, owner, obj, b"x")
    await storage.delete_object(where, owner, obj)
    await storage.delete_object(where, owner, obj)
    assert await storage.object_exists(where, owner, obj) is False


async def test_put_same_key_twice_overwrites(ids: tuple[UUID, UUID]) -> None:
    """REPEAT: the second put wins; the signed link reads the second body."""
    where = storage.bucket("voice", test=True)
    owner, obj = ids
    await storage.put_object(where, owner, obj, b"first")
    await storage.put_object(where, owner, obj, b"second")
    try:
        response = await _fetch(await storage.signed_read_link(where, owner, obj, 60))
        assert response.status_code == 200
        assert response.content == b"second"
    finally:
        await storage.delete_object(where, owner, obj)


async def test_empty_body_is_stored_and_read_back(ids: tuple[UUID, UUID]) -> None:
    """EMPTINESS: zero bytes is a valid object at this layer; the consumer
    (BE-136) decides whether an empty recording is acceptable."""
    where = storage.bucket("voice", test=True)
    owner, obj = ids
    await storage.put_object(where, owner, obj, b"")
    try:
        response = await _fetch(await storage.signed_read_link(where, owner, obj, 60))
        assert response.status_code == 200
        assert response.content == b""
    finally:
        await storage.delete_object(where, owner, obj)


# --------------------------------------------------------------------------
# Reading "as comms": only by signed link
# --------------------------------------------------------------------------


async def test_signed_link_reads_the_object(
    stored_voice: tuple[storage.Bucket, UUID, UUID, bytes],
) -> None:
    where, owner, obj, body = stored_voice
    link = await storage.signed_read_link(where, owner, obj, 60)
    parts = urlsplit(link)
    # Signed for the internal name comms resolves, path-style, both UUIDs.
    assert parts.scheme == "http"
    assert parts.netloc == "velo-storage:9000"
    assert parts.path == f"/voice-test/{owner}/{obj}"
    assert "X-Amz-Signature=" in parts.query
    response = await _fetch(link)
    assert response.status_code == 200
    assert response.content == body


async def test_unsigned_get_is_refused(
    stored_voice: tuple[storage.Bucket, UUID, UUID, bytes],
) -> None:
    """The bucket is private: the same URL without the signature is 403.
    Paired: the signed form of it is 200 (previous test, same fixture)."""
    where, owner, obj, _ = stored_voice
    link = await storage.signed_read_link(where, owner, obj, 60)
    bare = link.split("?", 1)[0]
    assert (await _fetch(bare)).status_code == 403
    assert (await _fetch(link)).status_code == 200


async def test_tampered_signature_is_refused(
    stored_voice: tuple[storage.Bucket, UUID, UUID, bytes],
) -> None:
    where, owner, obj, _ = stored_voice
    link = await storage.signed_read_link(where, owner, obj, 60)
    head, signature = link.rsplit("X-Amz-Signature=", 1)
    flipped = ("0" if signature[0] != "0" else "1") + signature[1:]
    assert (await _fetch(f"{head}X-Amz-Signature={flipped}")).status_code == 403


async def test_link_for_another_object_is_refused(
    stored_voice: tuple[storage.Bucket, UUID, UUID, bytes],
) -> None:
    """A signature covers its path: swapping the object id in a valid link
    does not open another object."""
    where, owner, obj, _ = stored_voice
    link = await storage.signed_read_link(where, owner, obj, 60)
    other = uuid4()
    assert (await _fetch(link.replace(str(obj), str(other)))).status_code == 403


async def test_expired_link_is_refused(
    stored_voice: tuple[storage.Bucket, UUID, UUID, bytes],
) -> None:
    where, owner, obj, _ = stored_voice
    link = await storage.signed_read_link(where, owner, obj, 1)
    await asyncio.sleep(2.5)
    assert (await _fetch(link)).status_code == 403


async def test_link_to_a_deleted_object_is_404(ids: tuple[UUID, UUID]) -> None:
    where = storage.bucket("voice", test=True)
    owner, obj = ids
    await storage.put_object(where, owner, obj, b"x")
    link = await storage.signed_read_link(where, owner, obj, 60)
    await storage.delete_object(where, owner, obj)
    assert (await _fetch(link)).status_code == 404


# --------------------------------------------------------------------------
# Refusals before the network
# --------------------------------------------------------------------------


async def test_api_only_type_gets_no_signed_link(ids: tuple[UUID, UUID]) -> None:
    """master-documents: only an admin through the VELO API, never a link."""
    where = storage.bucket("master-documents", test=True)
    with pytest.raises(storage.SignedLinkNotAllowedError):
        await storage.signed_read_link(where, *ids, 60)


@pytest.mark.parametrize("ttl", [0, -1, True, 1.5, 86400, 7 * 24 * 3600 + 1])
async def test_bad_ttl_is_refused(ttl: Any, ids: tuple[UUID, UUID]) -> None:
    """Non-positive, not an int, or not shorter than voice's shortest life (24 h)."""
    with pytest.raises(ValueError):
        await storage.signed_read_link(storage.bucket("voice", test=True), *ids, ttl)


async def test_ttl_just_under_the_objects_life_is_signed(
    ids: tuple[UUID, UUID],
) -> None:
    link = await storage.signed_read_link(
        storage.bucket("voice", test=True), *ids, 86399
    )
    assert "X-Amz-Expires=86399" in link


@pytest.mark.parametrize(
    "owner, obj",
    [
        ("6f1c1f9e-1d2a-4b5c-8d9e-0f1a2b3c4d5e", uuid4()),
        (uuid4(), "6f1c1f9e-1d2a-4b5c-8d9e-0f1a2b3c4d5e"),
        (uuid4(), "../etc/passwd"),
        (None, uuid4()),
    ],
)
async def test_key_parts_must_be_uuids(
    owner: Any, obj: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refused before the network: the endpoint points nowhere, and the
    error is TypeError, not StorageUnavailableError."""
    monkeypatch.setattr(storage, "STORAGE_ENDPOINT", "http://127.0.0.1:9")
    where = storage.bucket("voice", test=True)
    with pytest.raises(TypeError):
        await storage.put_object(where, owner, obj, b"x")
    with pytest.raises(TypeError):
        await storage.signed_read_link(where, owner, obj, 60)


async def test_empty_secret_refuses(
    monkeypatch: pytest.MonkeyPatch, ids: tuple[UUID, UUID]
) -> None:
    """Reachable: `velo env set STORAGE_SECRET_KEY` with an empty value, then
    `velo restart` -- the next `velo update` mints a new one."""
    monkeypatch.setattr(settings, "storage_secret_key", "")
    with pytest.raises(storage.StorageNotConfiguredError):
        await storage.put_object(storage.bucket("voice", test=True), *ids, b"x")


async def test_unknown_type_is_refused() -> None:
    with pytest.raises(KeyError):
        storage.bucket("photos")


# --------------------------------------------------------------------------
# Storage down, wrong bucket, wrong key
# --------------------------------------------------------------------------


async def test_storage_down_put_is_unavailable_but_link_is_signed(
    monkeypatch: pytest.MonkeyPatch, ids: tuple[UUID, UUID]
) -> None:
    """Signing is local: no storage needed. Storing is not."""
    monkeypatch.setattr(storage, "STORAGE_ENDPOINT", "http://127.0.0.1:9")
    where = storage.bucket("voice", test=True)
    link = await storage.signed_read_link(where, *ids, 60)
    assert link.startswith("http://127.0.0.1:9/voice-test/")
    with pytest.raises(storage.StorageUnavailableError):
        await storage.put_object(where, *ids, b"x")


async def test_bucket_outside_the_registry_is_denied_not_missing(
    ids: tuple[UUID, UUID],
) -> None:
    """The key's policy covers registry buckets only: anything else is an
    access refusal, NOT BucketMissingError (it may well exist)."""
    voice = load_registry().bucket_type("voice")
    stranger = storage.Bucket(name="velo-not-in-registry", type=voice)
    with pytest.raises(storage.StorageError) as caught:
        await storage.put_object(stranger, *ids, b"x")
    assert not isinstance(caught.value, storage.BucketMissingError)
    assert "AccessDenied" in str(caught.value)


async def test_wrong_secret_is_a_plain_storage_error(
    monkeypatch: pytest.MonkeyPatch, ids: tuple[UUID, UUID]
) -> None:
    monkeypatch.setattr(settings, "storage_secret_key", "WrongSecret123456")
    with pytest.raises(storage.StorageError) as caught:
        await storage.put_object(storage.bucket("voice", test=True), *ids, b"x")
    assert type(caught.value) is storage.StorageError
    assert "WrongSecret123456" not in str(caught.value)


class _HeadStub:
    """HEAD answers scripted per call -- the service key cannot delete a bucket,
    so the missing-bucket branch is driven here (and was measured live with the
    root key, see the BE-133 report)."""

    def __init__(self, object_status: int, bucket_status: int) -> None:
        self.object_status = object_status
        self.bucket_status = bucket_status

    @staticmethod
    def _error(status: int, op: str) -> ClientError:
        return ClientError(
            {
                "Error": {"Code": str(status)},
                "ResponseMetadata": {"HTTPStatusCode": status},
            },
            op,
        )

    async def head_object(self, **_: Any) -> dict[str, Any]:
        if self.object_status != 200:
            raise self._error(self.object_status, "HeadObject")
        return {}

    async def head_bucket(self, **_: Any) -> dict[str, Any]:
        if self.bucket_status != 200:
            raise self._error(self.bucket_status, "HeadBucket")
        return {}


@pytest.mark.parametrize(
    "object_status, bucket_status, expected",
    [
        (200, 200, True),
        (404, 200, False),
        (404, 404, storage.BucketMissingError),
        (403, 200, storage.StorageError),
    ],
)
async def test_head_404_is_told_apart_by_head_bucket(
    object_status: int,
    bucket_status: int,
    expected: Any,
    monkeypatch: pytest.MonkeyPatch,
    ids: tuple[UUID, UUID],
) -> None:
    stub = _HeadStub(object_status, bucket_status)

    @asynccontextmanager
    async def fake_client() -> AsyncIterator[_HeadStub]:
        yield stub

    monkeypatch.setattr(storage, "_client", fake_client)
    where = storage.bucket("voice", test=True)
    if isinstance(expected, bool):
        assert await storage.object_exists(where, *ids) is expected
    else:
        with pytest.raises(expected):
            await storage.object_exists(where, *ids)


class _WriteStub:
    """put/delete answering NoSuchBucket -- as RustFS 1.0.1 does once a
    registry bucket is gone (measured with the root key, BE-133 report)."""

    async def put_object(self, **_: Any) -> dict[str, Any]:
        raise ClientError(
            {
                "Error": {"Code": "NoSuchBucket"},
                "ResponseMetadata": {"HTTPStatusCode": 404},
            },
            "PutObject",
        )

    delete_object = put_object


@pytest.mark.parametrize("operation", ["put", "delete"])
async def test_no_such_bucket_on_write_is_bucket_missing(
    operation: str, monkeypatch: pytest.MonkeyPatch, ids: tuple[UUID, UUID]
) -> None:
    @asynccontextmanager
    async def fake_client() -> AsyncIterator[_WriteStub]:
        yield _WriteStub()

    monkeypatch.setattr(storage, "_client", fake_client)
    where = storage.bucket("voice", test=True)
    with pytest.raises(storage.BucketMissingError):
        if operation == "put":
            await storage.put_object(where, *ids, b"x")
        else:
            await storage.delete_object(where, *ids)


# --------------------------------------------------------------------------
# Nothing secret reaches a log
# --------------------------------------------------------------------------


async def test_no_link_and_no_secret_in_any_log(
    caplog: pytest.LogCaptureFixture, ids: tuple[UUID, UUID]
) -> None:
    """Every logger at DEBUG (botocore's included) while the MODULE stores,
    signs and checks. botocore logs request signatures at DEBUG -- presigned
    ones too -- which is why storage.py holds its loggers at WARNING; without
    that line this test fails. The read by link happens AFTER the log check:
    it stands for comms, whose httpx logs a request URL at INFO and which
    silences httpx itself. Paired: the link is real and reads the object."""
    caplog.set_level(logging.DEBUG)
    where = storage.bucket("voice", test=True)
    await storage.put_object(where, *ids, b"secret-free")
    try:
        link = await storage.signed_read_link(where, *ids, 60)
        assert await storage.object_exists(where, *ids) is True
        signature = link.rsplit("X-Amz-Signature=", 1)[1]
        assert signature and settings.storage_secret_key
        assert signature not in caplog.text
        assert settings.storage_secret_key not in caplog.text
        assert (await _fetch(link)).status_code == 200
    finally:
        await storage.delete_object(where, *ids)
