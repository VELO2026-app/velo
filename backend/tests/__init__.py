"""The test package. Importing it fills the settings' environment from
backend/ci.env first (tests/ci_environment.py): the package is imported
before tests/conftest.py and every test module, so before app."""

from tests.ci_environment import apply_ci_env

apply_ci_env()
