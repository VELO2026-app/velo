# Owner decisions, 2026-07-25

> **Moved out of `Agent-Velo/DS-build-plan.md` 2026-08-15 by Navigator-46** under that file's own de-ballast rule. These are RULINGS recorded so they are not re-litigated at build time — they have no closing condition and they are not tasks, so they were pure weight on an every-boot file. Read them before touching cross-group people-search or `delete_group`.

---

> **FOLLOW-UP BUNDLE — OWNER DECISIONS 2026-07-25 (all option A; recorded so they are not re-litigated at build time):**
> 1. **Cross-group people-search = ONE ROW PER MEMBERSHIP** with a chip naming the group (a person in N groups appears N times). Reason: this is a MEMBERSHIP-management surface — multiplicity is the meaning, not noise; a deduped row hides it. New backend fn + endpoint (`groups_service`/`groups_router`) + a new master surface; a `.tmp/` preview still gates the visual.
> 2. **`delete_group` orphan guard = BLOCK THE DELETE (409)** naming the practice that uses the group as its audience. Reason: auto-widening to public/students (option B) silently opens a practice the master deliberately restricted — rejected outright; option C still pulls the practice off the feed. A stops the destructive action BEFORE harm and changes no state silently. Guard goes in `delete_group()` before `session.delete(group)`.