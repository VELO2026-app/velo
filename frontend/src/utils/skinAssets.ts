// =============================================================================
// VELO Frontend -- runtime URLs of the skin's images (FE-230)
// =============================================================================
// A skin package replaces these files on fixed public paths: its assets/ go
// to /icons/, assets/onboarding/ to /onboarding/ (vite.config.ts
// skinAssetSpill, at closeBundle). The core ships neutral files on the same
// paths, so a build without a package still shows an image.
//
// Templates bind these constants (`:src="SKIN_IMAGE.verdictSent"`), never a
// static `src="/onboarding/..."`: the Vue template compiler turns a static
// root-relative src into a module import whenever public/ holds no such file,
// and the build fails. The package files land in dist/ only after the bundle,
// so the URL must stay a runtime URL. skinAssets.test.ts keeps templates on
// the bound form and every /icons/ name inside the skin contract
// (scripts/lib/skin-package.mjs SKIN_ASSETS).
// =============================================================================

/** Public URLs of the images a skin package may replace. */
export const SKIN_IMAGE = {
  /** The brand's app icon; VeloLogo shows it when the package has no logo set. */
  favicon: '/icons/favicon.svg',
  /** Logo ring, light variant (splash spinner). */
  mandalaWhite: '/icons/mandala-white.png',
  /** Logo ring, dark variant (auth screens). */
  mandalaBlue: '/icons/mandala-blue.png',
  /** Wordmark over the light ring. */
  wordFilled: '/icons/velo-word-filled.svg',
  /** Wordmark over the dark ring. */
  wordBlue: '/icons/velo-word-blue.svg',
  /** Static light logo. */
  logoWhite: '/icons/logo-white.svg',
  verdictApproved: '/onboarding/master-verdict-approved.svg',
  verdictReject: '/onboarding/master-verdict-reject.svg',
  verdictSent: '/onboarding/master-verdict-sent.svg',
  onboardingPractice: '/onboarding/onboarding-practice.svg',
  onboardingDiary: '/onboarding/onboarding-diary.svg',
  onboardingMasters: '/onboarding/onboarding-masters.svg',
  masterWelcome: '/onboarding/master-welcome.svg',
  masterSpace: '/onboarding/master-space.svg',
  masterAnalytics: '/onboarding/master-analytics.svg',
} as const
