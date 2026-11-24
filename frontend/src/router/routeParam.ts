import type { RouteLocationNormalizedLoaded } from 'vue-router'

/**
 * Read one required path parameter of the current route as a string.
 *
 * Replaces `route.params.x as string`: vue-router types a param as
 * `string | string[]`, and the cast hid a missing or repeated param.
 *
 * @param route - The current route (`useRoute()`).
 * @param name - The param name from the route record's path (`:name`).
 * @returns The param value.
 * @throws Error when the param is missing, empty, or repeated (an array).
 */
export function routeParam(
  route: Pick<RouteLocationNormalizedLoaded, 'params' | 'name'>,
  name: string,
): string {
  const value = route.params[name]
  if (typeof value !== 'string' || value === '') {
    const where = typeof route.name === 'string' ? ` of route "${route.name}"` : ''
    throw new Error(`Route param "${name}"${where} is missing or not a single value`)
  }
  return value
}
