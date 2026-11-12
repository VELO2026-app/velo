# =============================================================================
# VELO Backend -- config: COMMS paired-secret production gate (Phase 6 / W)
# =============================================================================
#
# Standalone (no DB/Redis): drives Settings(**kwargs) directly to assert the
# comms rules of the validator.
#
# ENV ISOLATION (post-VPS finding): the process environment carries a real
# COMMS_API_URL on a server -- an earlier version of this test asserted
# defaults and went red on the VPS while green in a bare sandbox. So every
# case passes ALL comms fields EXPLICITLY (kwargs beat os.environ), on top of
# a valid instance (tests/settings_instance.py). The test states the whole
# comms config; the environment cannot leak into it.
#
# The gate: comms may be OFF (all empty -> feature disabled, clean degrade),
# but a PARTIAL comms config is a silent failure -- a set api_url with an
# empty token ships "Bearer " and 401s the bell for everyone; a relay enabled
# by flag with an empty redis_url never starts. Enforced on every role
# (BE-192: there is no development mode).
# =============================================================================

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from tests.settings_instance import build_settings


@pytest.fixture
def make_settings(monkeypatch: pytest.MonkeyPatch):
    def make(
        *,
        api_url: str = "",
        token: str = "",
        redis_url: str = "",
        relay_enabled: bool = True,
    ) -> Settings:
        """Settings with the ENTIRE comms quartet pinned explicitly.

        relay_enabled defaults to True -- the production default -- so the
        "comms not installed" case (all urls empty) is tested against the
        real default, not a convenient False (R3: an earlier version used
        False here and missed that a comms-less box fails to start)."""
        return build_settings(
            monkeypatch,
            comms_api_url=api_url,
            comms_service_token=token,
            comms_redis_url=redis_url,
            comms_relay_enabled=relay_enabled,
        )

    return make


def test_full_comms_config_passes(make_settings) -> None:
    s = make_settings(
        api_url="http://comms-app:8000",
        token="tok",
        redis_url="redis://comms-redis:6379/0",
        relay_enabled=True,
    )
    assert s.comms_api_url == "http://comms-app:8000"


def test_comms_not_installed_starts_on_prod_default(make_settings) -> None:
    """R3: NO comms config at all, relay_enabled at its production default
    (True) -- must start. The gate only fires when comms is INTENDED (some
    field set)."""
    s = make_settings()  # relay_enabled defaults to True now
    assert s.comms_api_url == ""
    assert s.comms_relay_enabled is True


def test_api_url_without_token_rejected(make_settings) -> None:
    with pytest.raises(ValidationError, match="COMMS_SERVICE_TOKEN"):
        make_settings(api_url="http://comms-app:8000", token="", redis_url="redis://x")


def test_token_without_api_url_rejected(make_settings) -> None:
    with pytest.raises(ValidationError, match="COMMS_API_URL"):
        make_settings(token="tok", api_url="", redis_url="redis://x")


def test_relay_enabled_without_redis_rejected(make_settings) -> None:
    # comms is INTENDED (api_url + token set) but redis is missing -> reject.
    with pytest.raises(ValidationError, match="COMMS_REDIS_URL"):
        make_settings(api_url="http://comms-app:8000", token="tok", redis_url="")


def test_redis_without_api_and_token_rejected(make_settings) -> None:
    """The inverse half-integration: relay ships events, bell proxy dead."""
    with pytest.raises(ValidationError, match="COMMS_API_URL"):
        make_settings(redis_url="redis://x", api_url="", token="")
