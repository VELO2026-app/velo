// =============================================================================
// VELO Frontend -- the backend's time zone catalog (BE-157)
// =============================================================================
//
// The timezone picker builds its rows from GET /api/v1/users/timezones, not
// from the browser engine: engines spell zones differently (V8 lists and
// resolves "Asia/Katmandu", JavaScriptCore returns a name as given) while the
// backend stores one canonical spelling ("Asia/Kathmandu"). With the
// backend's names as rows, the row of the saved zone is found with ===.
//
// Loaded once per session and shared by every picker. Only a success is kept:
// a failed request leaves `catalog` null (the picker then shows its curated
// rows plus the saved zone) and is tried again on the next mount.
//
// The generated type renders the two maps as Record<string, unknown>, so the
// response is checked and narrowed here; a response of any other shape counts
// as a failed load.
// =============================================================================

import { readonly, ref, type DeepReadonly, type Ref } from 'vue'
import { getTimezoneCatalog } from '@/api/users'

export interface TimezoneCatalog {
  /** Every name the backend stores unchanged. */
  names: string[]
  /** Every other accepted spelling -> the name stored for it. */
  aliases: Record<string, string>
  /** Russian CLDR city / country per name, where CLDR has one. */
  labels: Record<string, { city_ru: string | null; country_ru: string | null }>
}

const catalog = ref<TimezoneCatalog | null>(null)
let inflight: Promise<void> | null = null

function narrow(body: unknown): TimezoneCatalog | null {
  if (typeof body !== 'object' || body === null) return null
  const { names, aliases, labels } = body as Record<string, unknown>
  if (!Array.isArray(names) || typeof aliases !== 'object' || aliases === null) return null
  const out: TimezoneCatalog = {
    names: names.filter((n): n is string => typeof n === 'string'),
    aliases: {},
    labels: {},
  }
  for (const [spelling, stored] of Object.entries(aliases)) {
    if (typeof stored === 'string') out.aliases[spelling] = stored
  }
  if (typeof labels === 'object' && labels !== null) {
    for (const [name, label] of Object.entries(labels)) {
      if (typeof label !== 'object' || label === null) continue
      const { city_ru, country_ru } = label as Record<string, unknown>
      out.labels[name] = {
        city_ru: typeof city_ru === 'string' ? city_ru : null,
        country_ru: typeof country_ru === 'string' ? country_ru : null,
      }
    }
  }
  return out.names.length ? out : null
}

function load(): void {
  if (catalog.value || inflight) return
  inflight = Promise.resolve()
    .then(() => getTimezoneCatalog())
    .then((body) => {
      catalog.value = narrow(body)
    })
    .catch(() => {
      // Failed: the picker keeps its curated rows and the saved zone; the
      // next mount tries again. No toast -- the screen still works.
    })
    .finally(() => {
      inflight = null
    })
}

/** The catalog (null until loaded or after a failed load); starts the load. */
export function useTimezoneCatalog(): Readonly<Ref<DeepReadonly<TimezoneCatalog> | null>> {
  load()
  return readonly(catalog)
}
