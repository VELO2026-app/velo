type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * vue-router's history.state accepts only JSON-shaped values
 * (HistoryStateValue). API DTOs carry optional props, i.e. `T | undefined`
 * per field, which the state contract rejects -- while the JSON round-trip
 * that views used before simply DROPPED undefined fields. This helper keeps
 * that exact behaviour behind a typed boundary: the parse-any is
 * encapsulated here and asserted to the JSON contract once.
 */
export function toHistoryState<T extends object>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
