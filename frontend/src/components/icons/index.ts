/**
 * VELO Frontend -- Icon Components barrel export (DS-5)
 *
 * SVG icons from Design_prototype/assets/icons/ as Vue components.
 * Most icons use currentColor fill and accept a `size` prop (default 24).
 * Exception: the mood-scale faces (IconMoodScale*) are illustrative assets
 * that keep their own pastel fills (default size 40), like VeloLogo.
 *
 * FE-119 (tz-ui-package.md §4 P4): the 12 cross-cutting glyphs moved to
 * `@velo/ui/icons` and are re-exported here from the kit's barrel -- the
 * consumers never change an import (§2.1); they flip to the kit directly
 * as their host components move in P6/P8. The domain icons stay local.
 *
 * Usage:
 *   `import { IconHome, IconCalendar } from '@/components/icons'`
 */

export { default as IconHome } from './IconHome.vue'
export { IconCalendar } from '@velo/ui'
export { default as IconCalendarStar } from './IconCalendarStar.vue'
export { default as IconStar } from './IconStar.vue'
export { default as IconDiary } from './IconDiary.vue'
export { default as IconDiaryBook } from './IconDiaryBook.vue'
export { default as IconProfile } from './IconProfile.vue'
export { default as IconIdCard } from './IconIdCard.vue'
export { IconGroup } from '@velo/ui'
export { IconWarning } from '@velo/ui'
export { default as IconQuestion } from './IconQuestion.vue'
export { default as IconBrain } from './IconBrain.vue'
export { default as IconClock } from './IconClock.vue'
export { default as IconLock } from './IconLock.vue'
export { default as IconChevronRight } from './IconChevronRight.vue'
export { default as IconMeditation } from './IconMeditation.vue'
export { default as IconBreathwork } from './IconBreathwork.vue'
export { default as IconYoga } from './IconYoga.vue'
export { default as IconSomatic } from './IconSomatic.vue'
export { default as IconTantra } from './IconTantra.vue'
export { default as IconCircles } from './IconCircles.vue'
export { default as IconSoundHealing } from './IconSoundHealing.vue'
export { default as IconArt } from './IconArt.vue'
export { default as IconNarrative } from './IconNarrative.vue'
export { default as IconMovement } from './IconMovement.vue'
export { default as IconRatingConfused } from './IconRatingConfused.vue'
export { default as IconRatingGood } from './IconRatingGood.vue'
export { default as IconRatingFire } from './IconRatingFire.vue'
export { default as IconHeart } from './IconHeart.vue'
export { default as IconFeedback } from './IconFeedback.vue'
export { default as IconRuble } from './IconRuble.vue'
export { IconSuccess } from '@velo/ui'
export { default as IconSupport } from './IconSupport.vue'

// -- Dashboard flow (DS-dashboard): monochrome glyphs (currentColor);
//    the three chrome glyphs ride @velo/ui since FE-119 (P4) --
export { IconCheck } from '@velo/ui'
export { IconArrowRight } from '@velo/ui'
export { IconClose } from '@velo/ui'

// -- Mood scale (FE-85, tz-mood-scale.md §6): five approved illustrative
//    faces for the unified Check-in/Feedback scale, embedded 1:1 from the
//    approved source art -- these components are the in-repo source of truth
//    (raw svg sources are not kept; default size 40, own gradients -- unique
//    ids per instance via useId) --
export { default as IconMoodScaleBad } from './IconMoodScaleBad.vue'
export { default as IconMoodScaleLow } from './IconMoodScaleLow.vue'
export { default as IconMoodScaleNeutral } from './IconMoodScaleNeutral.vue'
export { default as IconMoodScaleGood } from './IconMoodScaleGood.vue'
export { default as IconMoodScaleFire } from './IconMoodScaleFire.vue'

// -- Diary feed (Diary redesign): monochrome glyphs (currentColor) --
export { default as IconPen } from './IconPen.vue'
export { default as IconDreamBook } from './IconDreamBook.vue'
export { IconDots } from '@velo/ui'
export { default as IconMic } from './IconMic.vue'
export { default as IconSend } from './IconSend.vue'
export { default as IconStop } from './IconStop.vue'
// IconDateOrnament / IconAxisConnector / IconAxisDot removed 2026-06-08:
// superseded by IconDecor (part) / IconDecor2 (part) in DiaryTimeline.

// -- Profile menu (Screen A): monochrome glyphs (currentColor) --
// IconEdit removed 2026-09-30: its edit affordances were consolidated into
// IconPen (owner-supplied stylus redraw), so there is one pen glyph.
export { default as IconBookings } from './IconBookings.vue'
export { default as IconBell } from './IconBell.vue'
export { default as IconBellPlain } from './IconBellPlain.vue'
export { default as IconGlobe } from './IconGlobe.vue'
export { default as IconShare } from './IconShare.vue'
export { default as IconLogout } from './IconLogout.vue'

// -- F-9 canonical icon set (2026-06): new functional icons (single-tone currentColor) --
export { default as IconAnalytics } from './IconAnalytics.vue'
export { default as IconBroadcast } from './IconBroadcast.vue'
export { default as IconPlus } from './IconPlus.vue'
export { default as IconPlusFilled } from './IconPlusFilled.vue'
export { default as IconCheckin } from './IconCheckin.vue'
export { default as IconDecor } from './IconDecor.vue'
export { default as IconDecor2 } from './IconDecor2.vue'
export { IconFile } from '@velo/ui'
export { default as IconFilter } from './IconFilter.vue'
export { default as IconFinance } from './IconFinance.vue'
export { default as IconFree } from './IconFree.vue'
export { default as IconHint } from './IconHint.vue'
export { default as IconHourglass } from './IconHourglass.vue'
export { default as IconLanguage } from './IconLanguage.vue'
export { IconList } from '@velo/ui'
export { default as IconMap } from './IconMap.vue'
export { default as IconMessages } from './IconMessages.vue'
export { default as IconNotificationAlt } from './IconNotificationAlt.vue'
export { default as IconPending } from './IconPending.vue'
export { default as IconPromo } from './IconPromo.vue'
export { default as IconReflection } from './IconReflection.vue'
export { default as IconRepeat } from './IconRepeat.vue'
export { IconRequired } from '@velo/ui'
export { IconRequiredDone } from '@velo/ui'
export { default as IconSearch } from './IconSearch.vue'
export { default as IconSchool } from './IconSchool.vue'
export { default as IconCamera } from './IconCamera.vue'
export { default as IconSupportChat } from './IconSupportChat.vue'
export { default as IconTag } from './IconTag.vue'
export { default as IconTrash } from './IconTrash.vue'
export { default as IconThanks } from './IconThanks.vue'
export { default as IconUser } from './IconUser.vue'
export { default as IconUserMode } from './IconUserMode.vue'
export { default as IconUsers } from './IconUsers.vue'
export { default as IconView } from './IconView.vue'
export { default as IconCopy } from './IconCopy.vue'
export { default as IconLink } from './IconLink.vue'
export { default as IconRefresh } from './IconRefresh.vue'
