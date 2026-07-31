---
name: probekit-i18n-audit
description: "PAUSED for VELO — not applicable until multi-language ships; do not run, it would report a vacuous pass. i18n compliance audit: checks all strings use t(), keys exist in every locale, RTL support, no hardcoded text. Switch this back on when VELO gains an i18n surface (see Configuration)."
---

# i18n-audit v1.0.0 — PAUSED (PROMPT №435)

> **PAUSED, NOT RETIRED.** This skill is kept deliberately and is not archived or
> deleted. It does not apply to VELO *yet* — and it is expected to. Read the
> Configuration block before running or changing anything here.

i18n compliance audit for Vue 3 frontend.
Verifies all user-visible strings go through vue-i18n `t()` and keys exist in all 4 locales.

## Configuration

<!-- ================= PAUSED FOR VELO (PROMPT №435) =================
     Operator's ruling, verbatim: «не выбрасываем — ставим на паузу. Скоро мы
     будем встраивать эту функцию отдельно.» So this skill stays in the repo,
     unarchived, waiting to be switched on. It is NOT dead tooling and it is NOT
     a candidate for cleanup -- probekit-project-hygiene will see an unused
     skill here; that is expected, leave it.

     WHY IT IS PAUSED: VELO has ZERO i18n surface today. Verified PROMPT №435,
     not assumed:
       - vue-i18n is NOT in frontend/package.json
       - 0 occurrences of $t( / useI18n / vue-i18n anywhere in frontend/src
       - no frontend/src/i18n/ directory, so no locales to compare
       - the product says so itself: LanguageTimezoneView.vue:13-15 -- «The app
         has NO i18n yet», English toasts «появится позже» rather than switching
     Russian is the only real language and every string is inline Russian.

     WHY IT MUST NOT BE RUN AS-IS: with no t() calls and no locales_dir, the
     probes do not fail -- they find NOTHING and score a vacuous pass, or flag
     all ~80 screens as "hardcoded text" which is true and useless. Either
     result is noise that looks like a finding. The `description` above is
     marked PAUSED for exactly this reason: to stop it auto-triggering on
     «проверка переводов» and reporting a clean bill of health for a feature
     that does not exist.

     TO SWITCH IT BACK ON when multi-language lands:
       1. set source_dir / locales_dir to the real tree (frontend/src and
          wherever the locale JSONs end up)
       2. set supported_locales to what VELO actually ships -- the [en,ru,de,ar]
          below is CBS's set, NOT VELO's, and ru is almost certainly the base,
          not en
       3. re-check the RTL probe: it is only relevant if an RTL locale (ar or
          similar) actually ships. probekit-responsive-audit's own RTL probe (P6)
          was DROPPED for the same reason -- restore that one too, in step.
       4. drop the PAUSED markers from the description and the title above.

     The values below are CBS's originals, left UNCHANGED on purpose: pointing
     them at VELO paths would make a paused skill look configured and runnable.
     ================================================================= -->
source_dir: mockups/frontend/src
locales_dir: mockups/frontend/src/i18n/locales
supported_locales: [en, ru, de, ar]
base_locale: en

## Probes

Read `references/probe-definitions.md` for full probe specifications (P1–P8):
P1: Hardcoded Strings in Templates (CRITICAL), P2: Hardcoded Strings in Script (HIGH),
P3: Key Parity Across Locales (CRITICAL), P4: Unused i18n Keys (LOW),
P5: Missing i18n Keys in Code (CRITICAL), P6: RTL Locale Setup (HIGH),
P7: Locale File Structure (MEDIUM), P8: Placeholder/Attribute i18n (MEDIUM).

## Execution Steps

1. Read all 4 locale files — build key maps
2. Scan all .vue files for template text and t() calls
3. Run P1-P8 probes
4. Cross-reference keys: used vs defined
5. Classify and report

## Severity Rules

| Finding | Severity |
|---------|----------|
| Hardcoded user-visible string | P1 |
| Missing key in non-base locale | P1 |
| t() call with nonexistent key | P1 |
| Missing RTL support | P2 |
| Empty translation value | P2 |
| Hardcoded placeholder text | P2 |
| Unused i18n key | P3 |
| Structure mismatch between locales | P2 |

## Anchor

[*] i18n-audit v1.0.0 * ready
