// =============================================================================
// VELO Frontend -- Report reasons: codes <-> labels (tz-i18n, owner ruling)
// =============================================================================
//
// The report sheet's reasons are CODES in the backend payload (the field is
// free text on the backend, so the frontend owns this vocabulary):
//   payload: "code, code — свободный комментарий"
// The visible labels live in the report.reasons.* catalogs. The admin
// report detail decodes KNOWN codes back to localized labels; anything else
// (a legacy free-text record, an unknown future code) renders verbatim.
// =============================================================================

import i18n from '@/locales'

export const REASON_CODES = ['disrupted_practice', 'spam', 'abuse', 'fraud', 'other'] as const

export type ReportReasonCode = (typeof REASON_CODES)[number]

/** Localized label for one reason code (report.reasons.<code>). */
export function reportReasonLabel(code: string): string {
  return i18n.global.t(`report.reasons.${code}`)
}

/** Whether the catalogs know this reason code. */
export function isReportReasonCode(token: string): token is ReportReasonCode {
  return (REASON_CODES as readonly string[]).includes(token)
}

/**
 * Decode a stored reason for DISPLAY: known codes become localized labels,
 * unknown tokens pass through verbatim (legacy records are plain Russian
 * sentences and must render exactly as stored). The " — comment" tail keeps
 * its structure: the comment is user text, never decoded.
 */
export function decodeReportReason(raw: string): string {
  const sep = ' — '
  const sepIdx = raw.indexOf(sep)
  const listPart = sepIdx === -1 ? raw : raw.slice(0, sepIdx)
  const commentPart = sepIdx === -1 ? '' : raw.slice(sepIdx)

  const decoded = listPart
    .split(', ')
    .map((token) => (isReportReasonCode(token) ? reportReasonLabel(token) : token))
    .join(', ')

  return `${decoded}${commentPart}`
}
