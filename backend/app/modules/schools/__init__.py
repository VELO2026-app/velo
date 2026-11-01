# =============================================================================
# VELO Backend -- Schools module (tz-curator-groups.md, P1)
# =============================================================================
#
# A school is a community owned by exactly one Master-Curator.
# Curatorship is not a role, a flag or a grant: any verified master becomes a
# curator by creating a school (TZ I-1, 3.3). The owner is held in ONE place --
# school.curator_user_id -- and nowhere else.
#
# This is NOT the master's own student groups (masters/groups_*): those stay
# untouched (I-8). The names are deliberately different everywhere -- table,
# model, schema prefix, route -- so the two never read as one thing.
# =============================================================================
