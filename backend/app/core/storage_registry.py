"""Object storage registry (BE-133): typed, validated view of storage_registry.yaml.

The YAML file next to this module is the ONE source of what velo-storage
holds -- buckets, their lifetime and readers, and the service keys with their
policy. The storage init container and `velo doctor` read the same file; this
module is how the backend reads it. Nothing here talks to the storage.

The file is validated strictly on load: an unknown field, a missing field or
a value of the wrong shape is a ``RegistryError``, never a default. A typo in
the registry must stop the code that reads it, not quietly build a bucket
without its lifecycle rule.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml

REGISTRY_PATH = Path(__file__).with_name("storage_registry.yaml")

Reader = Literal["signed_link", "api"]
_READERS: frozenset[str] = frozenset({"signed_link", "api"})

# S3 bucket naming as RustFS enforces it, narrowed to what we use: 3..63
# characters, lower-case letters, digits and hyphens, starting and ending
# with a letter or digit. Dots are left out on purpose -- they break
# path-style certificates elsewhere and nothing here needs them.
_BUCKET_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
_KEY_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
_ACTION = re.compile(r"^s3:[A-Za-z]+$")


class RegistryError(ValueError):
    """The registry file does not have the shape this module requires."""


class _UniqueKeyLoader(yaml.SafeLoader):
    """SafeLoader that refuses a mapping key written twice.

    Plain safe_load keeps the LAST of two equal keys without a word, so a
    second ``voice:`` entry would silently replace the first one's rule.
    """


def _construct_unique_mapping(
    loader: _UniqueKeyLoader, node: yaml.MappingNode
) -> dict[Any, Any]:
    seen: set[Any] = set()
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=True)
        if key in seen:
            raise RegistryError(f"key {key!r} is written twice")
        seen.add(key)
    return loader.construct_mapping(node, deep=True)


_UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_unique_mapping
)


@dataclass(frozen=True)
class BucketType:
    """One data type: a bucket and the policy that comes with it."""

    name: str
    # None: no lifecycle rule, objects live until deleted.
    expire_days: int | None
    backup: bool
    reader: Reader


@dataclass(frozen=True)
class ServiceKey:
    """One service key of the storage's root user."""

    name: str
    secret_env: str
    actions: tuple[str, ...]


@dataclass(frozen=True)
class StorageRegistry:
    """The whole registry, as loaded and checked."""

    test_bucket_suffix: str
    buckets: tuple[BucketType, ...]
    service_keys: tuple[ServiceKey, ...]

    def bucket_type(self, name: str) -> BucketType:
        """Return the type called ``name``; KeyError for an unknown one."""
        for bucket in self.buckets:
            if bucket.name == name:
                return bucket
        raise KeyError(name)

    def test_bucket_name(self, name: str) -> str:
        """Name of the test twin of bucket type ``name``."""
        return self.bucket_type(name).name + self.test_bucket_suffix

    def key_for_secret(self, secret_env: str) -> ServiceKey:
        """Return the service key whose secret lives in ``secret_env``."""
        for key in self.service_keys:
            if key.secret_env == secret_env:
                return key
        raise KeyError(secret_env)


def _exact_fields(where: str, raw: Any, fields: set[str]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise RegistryError(f"{where}: expected a mapping")
    present = set(raw)
    if present != fields:
        missing = sorted(fields - present)
        extra = sorted(present - fields)
        raise RegistryError(f"{where}: missing {missing}, unknown {extra}")
    return raw


def _parse_bucket(name: Any, raw: Any, suffix: str) -> BucketType:
    if not isinstance(name, str) or not _BUCKET_NAME.match(name):
        raise RegistryError(f"bucket name {name!r} is not a valid bucket name")
    if not _BUCKET_NAME.match(name + suffix):
        raise RegistryError(
            f"bucket {name!r}: its test twin is not a valid bucket name"
        )
    data = _exact_fields(f"bucket {name}", raw, {"expire_days", "backup", "reader"})
    days = data["expire_days"]
    # bool is an int in Python; `true` must not pass as "1 day".
    if days is not None and (
        isinstance(days, bool) or not isinstance(days, int) or days < 1
    ):
        raise RegistryError(
            f"bucket {name}: expire_days must be null or an integer >= 1"
        )
    if not isinstance(data["backup"], bool):
        raise RegistryError(f"bucket {name}: backup must be true or false")
    if data["reader"] not in _READERS:
        raise RegistryError(f"bucket {name}: reader must be one of {sorted(_READERS)}")
    return BucketType(
        name=name, expire_days=days, backup=data["backup"], reader=data["reader"]
    )


def _parse_key(name: Any, raw: Any) -> ServiceKey:
    if not isinstance(name, str) or not _KEY_NAME.match(name):
        raise RegistryError(f"service key name {name!r} is not valid")
    data = _exact_fields(f"service key {name}", raw, {"secret_env", "actions"})
    env = data["secret_env"]
    if not isinstance(env, str) or not _ENV_NAME.match(env):
        raise RegistryError(
            f"service key {name}: secret_env must be an UPPER_CASE name"
        )
    actions = data["actions"]
    if (
        not isinstance(actions, list)
        or not actions
        or not all(isinstance(a, str) and _ACTION.match(a) for a in actions)
        or len(set(actions)) != len(actions)
    ):
        raise RegistryError(
            f"service key {name}: actions must be distinct s3:<Action> names"
        )
    return ServiceKey(name=name, secret_env=env, actions=tuple(actions))


def parse_registry_text(text: str) -> StorageRegistry:
    """Parse and validate registry YAML text."""
    return parse_registry(yaml.load(text, Loader=_UniqueKeyLoader))


def parse_registry(raw: Any) -> StorageRegistry:
    """Build a ``StorageRegistry`` from the parsed YAML document."""
    data = _exact_fields(
        "registry", raw, {"test_bucket_suffix", "buckets", "service_keys"}
    )
    suffix = data["test_bucket_suffix"]
    if not isinstance(suffix, str) or not re.match(r"^-[a-z0-9]+$", suffix):
        raise RegistryError("test_bucket_suffix must look like '-test'")
    raw_buckets = data["buckets"]
    raw_keys = data["service_keys"]
    if not isinstance(raw_buckets, dict) or not raw_buckets:
        raise RegistryError("buckets: expected a non-empty mapping")
    if not isinstance(raw_keys, dict) or not raw_keys:
        raise RegistryError("service_keys: expected a non-empty mapping")
    buckets = tuple(_parse_bucket(n, b, suffix) for n, b in raw_buckets.items())
    names = {b.name for b in buckets}
    twins = {b.name + suffix for b in buckets}
    if names & twins:
        raise RegistryError("a bucket name collides with another bucket's test twin")
    keys = tuple(_parse_key(n, k) for n, k in raw_keys.items())
    envs = [k.secret_env for k in keys]
    if len(set(envs)) != len(envs):
        raise RegistryError("two service keys share one secret_env")
    return StorageRegistry(
        test_bucket_suffix=suffix, buckets=buckets, service_keys=keys
    )


@lru_cache(maxsize=1)
def load_registry() -> StorageRegistry:
    """Load and validate the registry file once per process."""
    return parse_registry_text(REGISTRY_PATH.read_text(encoding="utf-8"))
