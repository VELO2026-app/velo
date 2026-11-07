# =============================================================================
# VELO Backend -- the edition -> modules table (BE-190)
# =============================================================================
#
# An edition is the set of velo's modules an instance runs (protocol
# 5.2.3); the instance's edition comes from its passport (EDITION ->
# Settings.edition) and its modules are reported in /health (protocol
# 9.1). Owner ruling 5.11: one edition, `ai`, with the one module `ai`;
# payments, schools, mcp, zoom, telegram and llm are instance OPTIONS,
# not modules of an edition -- they arrive with BE-182, together with the
# frontend's table (editions.json, FE-130).
#
# The keys are primer.yaml's `editions` exactly (tests/test_report.py):
# the machine refuses a passport whose edition primer.yaml does not
# declare, and Settings refuses one this table does not know.
# =============================================================================

EDITIONS: dict[str, tuple[str, ...]] = {
    "ai": ("ai",),
}
