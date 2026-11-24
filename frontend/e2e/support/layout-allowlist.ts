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
    task: 'FE-249',
    reason:
      'the kit draws these controls under 44x44 px (inputs and selects 40 tall, textareas 43, ' +
      'radio rows and bare inputs 21, progress rows 16, segments 24-36, chips 26-34, day ' +
      'picker days 27-38, the menu trigger 40): a size or hit-area decision for the ' +
      'designer. Not below 16 px.',
    rules: ['small-target'],
    element:
      /^(input|select|button|textarea)(#[\w-]+)?\.(v-input__field|v-select__field|v-textarea__field|v-radio|v-progress-row|v-segment__item|v-segment-track__btn|v-chip|v-day-picker__day|v-menu__trigger|v-more)(\.|\s|$)/,
    minSide: 16,
  },
  {
    task: 'FE-249',
    reason:
      'screen controls under 44x44 px without a larger hit area (icon buttons 22-40, ' +
      'pickers, time fields and the composer field under 44 tall, text buttons 16-29 tall): ' +
      'a size or ' +
      'hit-area decision for the designer. Not below 16 px.',
    rules: ['small-target'],
    element:
      /^(button|a|textarea)(#[\w-]+)?\.(week-strip__day|mreview__pen|admin-catalog__icon-btn|calendar__back|ea__custom-commit|admin-dashboard__eye|groups__add-btn|mcg__add-btn|promo__add|stats__nav-btn|support-detail__menu|admin-dashboard__week-nav|edit-profile__change-photo|support-detail__refresh|report-detail__meta-val|support__email|tickets__stats|use-template__head|composer__input|ea__picker|practice-schedule-picker__trigger|new-promo__picker|mn-sched__field)(\.|\s|$)/,
    minSide: 16,
  },
  {
    task: 'FE-240',
    reason:
      'by design: the mood carousel crops its far cards against the stage edges ' +
      '(.mood-slider__strip in src/components/shared/MoodSlider.vue), labels included',
    rules: ['overflow'],
    routes: ['user-checkin', 'user-feedback', 'user-diary-activity-new'],
    element: /^span\.mood-slider__label(\.|\s|$)/,
  },
  {
    task: 'FE-250',
    reason: 'seven VBarChart labels do not fit a 320 px screen; the last one runs past its edge',
    rules: ['overflow'],
    routes: ['admin-checkin-rate', 'admin-feedback-rate', 'admin-return-rate'],
    element: /^span\.v-bar-chart__label(\.|\s|$)/,
    widths: [320],
  },
]

checkAllowances(LAYOUT_ALLOWLIST)
