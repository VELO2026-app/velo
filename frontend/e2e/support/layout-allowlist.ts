/**
 * Accepted layout findings (FE-240), as crashes.allow() is for the crash
 * detector. A finding is a bug until proven otherwise. An entry names the
 * task that fixes it and why it is accepted until then, and is as narrow as
 * the case: the rule, the route, the element, the widths, the smallest size.
 * The task that fixes a finding removes its entry.
 */
import { checkAllowances, type LayoutAllowance } from './layout-allowance'

export const LAYOUT_ALLOWLIST: LayoutAllowance[] = [
  {
    task: 'FE-240',
    reason:
      'by design: the mood carousel crops its far cards against the stage edges ' +
      '(.mood-slider__strip in src/components/shared/MoodSlider.vue), labels included',
    rules: ['overflow'],
    routes: ['user-checkin', 'user-feedback', 'user-diary-activity-new'],
    element: /^span\.mood-slider__label(\.|\s|$)/,
    widths: [320],
  },
]

checkAllowances(LAYOUT_ALLOWLIST)
