// =============================================================================
// VELO Frontend -- order numbers of catalog items (FE-262)
// =============================================================================

/** Whether the text of an order field is a whole number (blank is not). */
export function isWholeNumber(text: string): boolean {
  return text.trim() !== '' && Number.isInteger(Number(text))
}

/**
 * The order number that puts a new item last: one past the largest in use,
 * or 1 for the first item. The API's default (0) would put it first.
 *
 * @param orders - the `display_order` of every item already in the list
 */
export function nextDisplayOrder(orders: readonly number[]): number {
  return Math.max(0, ...orders) + 1
}
