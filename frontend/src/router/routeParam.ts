import type { RouteLocationNormalizedLoaded } from 'vue-router'

type ParamSource = Pick<RouteLocationNormalizedLoaded, 'params' | 'name'>

/**
 * Read one path parameter of the route as a single non-empty string, or `null`.
 *
 * For reactive reads (a `watch` source, a `useQuery` key, a template binding):
 * while a screen leaves, the router already shows the NEXT route to it, so the
 * param can be gone and a throwing read would break the leaving screen.
 * vue-router types a param as `string | string[]`; a missing, empty or
 * repeated param gives `null`.
 *
 * @param route - The current route (`useRoute()`).
 * @param name - The param name from the route record's path (`:name`).
 * @returns The param value, or `null` when it is not a single non-empty string.
 */
export function optionalRouteParam(route: ParamSource, name: string): string | null {
  const value = route.params[name]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Read one required path parameter of the route as a string.
 *
 * Replaces `route.params.x as string` and `String(route.params.x)`: the cast
 * hid a missing or repeated param. For reads that run while the screen is
 * alive (setup, a handler, `onMounted`); reactive reads use
 * `optionalRouteParam`.
 *
 * @param route - The current route (`useRoute()`).
 * @param name - The param name from the route record's path (`:name`).
 * @returns The param value.
 * @throws Error when the param is missing, empty, or repeated (an array).
 */
export function routeParam(route: ParamSource, name: string): string {
  const value = optionalRouteParam(route, name)
  if (value === null) {
    const where = typeof route.name === 'string' ? ` of route "${route.name}"` : ''
    throw new Error(`Route param "${name}"${where} is missing or not a single value`)
  }
  return value
}
