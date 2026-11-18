# =============================================================================
# VELO Backend -- The product's languages (BE-188, BE-196)
# =============================================================================
#
# The languages velo can do: what PRIMER-PROTOCOL 5.2.2 calls the product's
# languages, declared in primer.yaml `languages` (tests/test_primer_env.py
# pins the two equal). Exactly the frontend's catalogs
# (frontend/src/locales/: en, ru, uk). Owner ruling 2026-11-03 (BE-188).
#
# An instance turns on a subset of them in its passport, with a default
# among the subset (BE-196): Settings.languages and
# Settings.default_language (core/config.py), checked against this set at
# start. A person's language -- stored, shown, used -- is
# Settings.language_of(): the person's own if the instance has it on, else
# the instance's default. There is no product-wide default language: the
# default is the instance's.
# =============================================================================

SUPPORTED_LANGUAGES = frozenset({"en", "ru", "uk"})
