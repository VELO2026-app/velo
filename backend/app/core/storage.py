"""Object storage client (BE-133): velo-storage, reached only inside docker.

What the backend can do with an object, and nothing more:

* ``put_object``      -- store bytes under ``<owner uuid>/<object uuid>``;
* ``object_exists``   -- True / False, and ``BucketMissingError`` when the bucket
                         itself is gone (the two are different answers);
* ``delete_object``   -- idempotent, as in S3: deleting what is not there is
                         not an error;
* ``signed_read_link``-- a presigned GET for velo-storage:9000, signed LOCALLY
                         (no request to the storage), for bucket types whose
                         registry reader is ``signed_link`` only.

Buckets come from the registry (app/core/storage_registry.yaml) through
``bucket("voice")``; ``bucket("voice", test=True)`` is its test twin, the only
place the suite writes. The key's NAME comes from the registry, its secret
from ``settings.storage_secret_key``.

Object keys are two UUIDs: whose data it is (the person who recorded the
voice, the master whose document it is), then the object. No names, no
personal data in the path -- and erasing one person's files is a delete by
prefix. Anything else is refused before the network is touched.

Nothing here logs a link, a key or a secret: the module does not log at all,
and it holds botocore's own loggers at WARNING (see below). Errors carry the
bucket name and an S3 error code, never a URL.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from aiobotocore.config import AioConfig
from aiobotocore.session import get_session
from botocore.exceptions import BotoCoreError, ClientError

from app.core.config import settings
from app.core.storage_registry import BucketType, load_registry

# The one address of the storage: the docker network name comms also uses
# (LLM_BODY_HOSTS = velo-storage:9000). A signed link is valid for exactly
# the host it was signed for, so this is also the host of every link.
STORAGE_ENDPOINT = "http://velo-storage:9000"
# SigV4 needs a region; RustFS answers to the default one.
STORAGE_REGION = "us-east-1"
# SigV4 caps a presigned URL at 7 days.
_SIGV4_MAX_SECONDS = 7 * 24 * 3600
_SECRET_ENV = "STORAGE_SECRET_KEY"

# botocore logs, at DEBUG, the SigV4 signature of every request it signs --
# presigned links included ("Signature: <hex>", botocore.auth), and with the
# path and date that is enough to rebuild a working link. Measured on
# botocore 1.43.106 by test_no_link_and_no_secret_in_any_log. Its loggers are
# held at WARNING here, whatever LOG_LEVEL the app runs at, so a DEBUG run on
# a server cannot put readable links into its log.
for _name in ("botocore", "aiobotocore"):
    logging.getLogger(_name).setLevel(logging.WARNING)


class StorageError(Exception):
    """Base of every storage failure. Never carries a URL or a secret."""


class StorageNotConfiguredError(StorageError):
    """STORAGE_SECRET_KEY is empty; `velo update` writes it."""


class StorageUnavailableError(StorageError):
    """velo-storage did not answer, or answered with a server error."""


class BucketMissingError(StorageError):
    """The bucket does not exist on the storage."""


class SignedLinkNotAllowedError(StorageError):
    """This bucket type is read through the VELO API only."""


@dataclass(frozen=True)
class Bucket:
    """A physical bucket: a registry type, or its test twin."""

    name: str
    type: BucketType


def bucket(type_name: str, *, test: bool = False) -> Bucket:
    """Resolve a registry type to its bucket; KeyError for an unknown type."""
    registry = load_registry()
    bucket_type = registry.bucket_type(type_name)
    name = registry.test_bucket_name(type_name) if test else bucket_type.name
    return Bucket(name=name, type=bucket_type)


def object_key(owner_id: UUID, object_id: UUID) -> str:
    """``<owner uuid>/<object uuid>``; anything but two UUIDs is a TypeError."""
    if not isinstance(owner_id, UUID) or not isinstance(object_id, UUID):
        raise TypeError("object keys are built from two uuid.UUID values")
    return f"{owner_id}/{object_id}"


def _credentials() -> tuple[str, str]:
    secret = settings.storage_secret_key
    if not secret:
        raise StorageNotConfiguredError(f"{_SECRET_ENV} is empty")
    return load_registry().key_for_secret(_SECRET_ENV).name, secret


@asynccontextmanager
async def _client() -> AsyncIterator[Any]:
    access_key, secret_key = _credentials()
    config = AioConfig(
        signature_version="s3v4",
        s3={"addressing_style": "path"},
        # One attempt: a caller is better served by a fast, clear
        # StorageUnavailableError than by a minute of silent retries.
        retries={"max_attempts": 1, "mode": "standard"},
        connect_timeout=3,
        read_timeout=30,
    )
    session = get_session()
    async with session.create_client(
        "s3",
        endpoint_url=STORAGE_ENDPOINT,
        region_name=STORAGE_REGION,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=config,
    ) as client:
        yield client


def _code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


def _status(exc: ClientError) -> int:
    return int(exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0))


def _translate(exc: Exception, where: Bucket) -> StorageError:
    """Map a client failure to our errors -- by S3 code, never by message."""
    if isinstance(exc, ClientError):
        if _code(exc) == "NoSuchBucket":
            return BucketMissingError(where.name)
        if _status(exc) >= 500:
            return StorageUnavailableError(
                f"{where.name}: {_code(exc) or _status(exc)}"
            )
        return StorageError(f"{where.name}: {_code(exc) or _status(exc)}")
    return StorageUnavailableError(f"{where.name}: {type(exc).__name__}")


async def put_object(
    where: Bucket,
    owner_id: UUID,
    object_id: UUID,
    body: bytes,
    content_type: str = "application/octet-stream",
) -> str:
    """Store ``body``; return its key. Overwrites an object with the same key."""
    key = object_key(owner_id, object_id)
    try:
        async with _client() as client:
            await client.put_object(
                Bucket=where.name, Key=key, Body=body, ContentType=content_type
            )
    except StorageError:
        raise
    except (ClientError, BotoCoreError, OSError) as exc:
        raise _translate(exc, where) from None
    return key


async def object_exists(where: Bucket, owner_id: UUID, object_id: UUID) -> bool:
    """True if the object is there, False if not; BucketMissingError if the
    bucket itself is gone.

    HEAD carries no error body: a missing key and a missing bucket are both a
    bare 404 (measured on RustFS 1.0.1, as aivis measured before). A 404 is
    therefore followed by HEAD on the bucket to tell the two apart.
    """
    key = object_key(owner_id, object_id)
    try:
        async with _client() as client:
            try:
                await client.head_object(Bucket=where.name, Key=key)
                return True
            except ClientError as exc:
                if _status(exc) != 404:
                    raise
            try:
                await client.head_bucket(Bucket=where.name)
            except ClientError as exc:
                if _status(exc) == 404:
                    raise BucketMissingError(where.name) from None
                raise
            return False
    except StorageError:
        raise
    except (ClientError, BotoCoreError, OSError) as exc:
        raise _translate(exc, where) from None


async def delete_object(where: Bucket, owner_id: UUID, object_id: UUID) -> None:
    """Delete the object. Deleting an object that is not there succeeds."""
    key = object_key(owner_id, object_id)
    try:
        async with _client() as client:
            await client.delete_object(Bucket=where.name, Key=key)
    except StorageError:
        raise
    except (ClientError, BotoCoreError, OSError) as exc:
        raise _translate(exc, where) from None


async def signed_read_link(
    where: Bucket, owner_id: UUID, object_id: UUID, ttl_seconds: int
) -> str:
    """A presigned GET link for velo-storage:9000, valid for ``ttl_seconds``.

    Signed locally -- nothing is sent to the storage, so this works (and
    proves nothing about the object) while the storage is down. Refused:
    a bucket type read through the API only; a ttl that is not positive,
    beyond SigV4's 7 days, or not shorter than the type's lifetime (a link
    must not outlive the shortest life of the object it points at -- for
    ``voice`` that is 24 hours, see the registry).
    """
    if where.type.reader != "signed_link":
        raise SignedLinkNotAllowedError(where.name)
    key = object_key(owner_id, object_id)
    if (
        isinstance(ttl_seconds, bool)
        or not isinstance(ttl_seconds, int)
        or ttl_seconds <= 0
    ):
        raise ValueError("ttl_seconds must be a positive integer")
    if ttl_seconds > _SIGV4_MAX_SECONDS:
        raise ValueError("ttl_seconds exceeds the 7 days SigV4 allows")
    if (
        where.type.expire_days is not None
        and ttl_seconds >= where.type.expire_days * 86400
    ):
        raise ValueError("a link must expire before the shortest life of its object")
    async with _client() as client:
        url: str = await client.generate_presigned_url(
            "get_object",
            Params={"Bucket": where.name, "Key": key},
            ExpiresIn=ttl_seconds,
        )
    return url
