/**
 * UI badge over a booking card. Lives in a .ts module, NOT in BookingCard.vue:
 * types exported from .vue SFCs are invisible to tooling without the vue
 * language plugin (type-aware eslint resolves them as any).
 */
export interface BookingBadge {
  label: string
  variant: 'live' | 'today' | 'tomorrow' | 'done' | 'cancelled' | 'no_show' | 'calculating'
}
