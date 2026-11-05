// =============================================================================
// VELO Frontend -- Booking lifecycle helpers (shared)
// =============================================================================
//
// Single source of truth for the practice/booking lifecycle as the USER sees it,
// shared by the dashboard nearest-practice card
// (i18n:masterScreens.masterDashboard.nearestOne) and the bookings screen
// (i18n:user.screens.myBookings.title) so the two never drift.
//
// Active-cycle states (before/while the practice runs) are decided by CLIENT
// TIME (scheduled_at + duration_minutes), NOT by practice.status. The backend
// now drives status='live' and status='completed' automatically by the clock
// (the lifecycle worker: live at scheduled_at, completed at scheduled_at +
// duration), but on a poll interval — so status can lag the real moment by a
// few seconds. Driving the live/ended cycle off the clock here makes the card
// flip the instant the practice actually starts/ends, with no dependency on the
// worker's lag. The FINAL statuses (attended/no_show/cancelled) still come from
// the backend booking.status — they carry settlement truth.
//
// "now" is passed in (epoch ms) so callers control reactivity: the dashboard
// feeds a 60s clock ref; one-shot views can pass Date.now().
// =============================================================================

import type { BookingWithPracticeResponse } from '@/api/types'

/** Practice start as epoch ms. */
export function practiceStartMs(b: BookingWithPracticeResponse): number {
  return new Date(b.practice.scheduled_at).getTime()
}

/** Practice end (start + duration) as epoch ms. */
export function practiceEndMs(b: BookingWithPracticeResponse): number {
  return practiceStartMs(b) + (b.practice.duration_minutes ?? 0) * 60_000
}

/** Happening right now: started and not yet ended (client time). */
export function isLiveNow(b: BookingWithPracticeResponse, nowMs: number): boolean {
  return practiceStartMs(b) <= nowMs && nowMs < practiceEndMs(b)
}

/** Already over (now past start + duration). Client time. */
export function hasEnded(b: BookingWithPracticeResponse, nowMs: number): boolean {
  return nowMs >= practiceEndMs(b)
}

/**
 * Free practice. The ONLY reliable free/paid signal on a booking: purchase_id
 * is set even for free practices (create_booking always opens a Purchase), so
 * it cannot distinguish them. `practice.is_free` (surfaced on PracticeSummary)
 * is the source of truth.
 */
export function isFree(b: BookingWithPracticeResponse): boolean {
  return b.practice.is_free
}
