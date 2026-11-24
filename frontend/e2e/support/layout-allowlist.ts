/**
 * Accepted layout findings (FE-240), as crashes.allow() is for the crash
 * detector. A finding is a bug until proven otherwise. An entry needs a
 * `reason` that names the task fixing it, or why this geometry is right for
 * this screen, and is as narrow as the case: the rule, the route, the
 * element, the widths. The task that fixes a finding removes its entry.
 */
import type { LayoutAllowance } from './layout-allowance'

export const LAYOUT_ALLOWLIST: LayoutAllowance[] = [
  {
    reason:
      'FE-249: the kit draws these controls under 44x44 px (inputs and selects 40 tall, ' +
      'radio rows 21, segments 24-36, chips 26-34, the menu trigger 40). A size or ' +
      'hit-area decision for the designer.',
    rules: ['small-target'],
    element:
      /^(input|select|button)(#[\w-]+)?\.(v-input__field|v-select__field|v-radio|v-segment__item|v-segment-track__btn|v-chip|v-menu__trigger|v-more)\b/,
  },
  {
    reason:
      'FE-249: screen controls under 44x44 px without a larger hit area (icon buttons ' +
      '22-40, pickers and the composer field under 44 tall, text buttons). A size or ' +
      'hit-area decision for the designer.',
    rules: ['small-target'],
    element:
      /^(button|a|textarea)(#[\w-]+)?\.(week-strip__day|mreview__pen|admin-catalog__icon-btn|calendar__back|ea__custom-commit|admin-dashboard__eye|groups__add-btn|mcg__add-btn|promo__add|stats__nav-btn|support-detail__menu|admin-dashboard__week-nav|edit-profile__change-photo|support-detail__refresh|report-detail__meta-val|support__email|tickets__stats|use-template__head|composer__input|ea__picker|practice-schedule-picker__trigger|new-promo__picker)\b/,
  },
  {
    reason:
      'FE-250: seven VBarChart labels do not fit a 320 px screen; the last one runs past ' +
      'its right edge.',
    rules: ['overflow'],
    routes: ['admin-checkin-rate', 'admin-feedback-rate', 'admin-return-rate'],
    element: /^span\.v-bar-chart__label\b/,
    widths: [320],
  },
]
