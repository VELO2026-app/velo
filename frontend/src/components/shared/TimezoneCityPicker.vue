<!--
  VELO Frontend -- TimezoneCityPicker (Задача 2, 2026-06-09)

  Searchable city -> timezone picker (Google-Calendar-style), DS-built:
    - VInput search field (type a city) with an IconSearch suffix.
    - A DS glass list of matching cities; each row shows the current local time
      and the UTC offset (computed live via Intl, DST-aware) and an IconCheck on
      the selected one. Tapping a row selects its IANA zone.
    - Search AND manual browse in one (empty query = full list).
    - No match -> a plain "не найдено" hint (operator: keep it simple).

  v-model is the IANA zone id (what the backend stores). The master create/edit
  forms keep the compact VSelect (utils/practiceOptions TIMEZONE_OPTIONS); this
  richer picker is used on the profile + onboarding timezone screens.
-->

<template>
  <div class="tz-picker">
    <VInput v-model="query" :placeholder="placeholder" @focus="onFieldFocus">
      <template #suffix><IconSearch :size="18" /></template>
    </VInput>

    <div v-if="filtered.length" ref="listEl" class="tz-picker__list">
      <button
        v-for="c in filtered"
        :key="c.iana + c.city"
        type="button"
        class="tz-picker__row"
        :class="{ 'tz-picker__row--active': c.iana === modelValue }"
        @click="select(c.iana)"
      >
        <span class="tz-picker__main">
          <span class="tz-picker__city">{{ c.city }}</span>
          <span class="tz-picker__zone">{{ c.iana }}</span>
        </span>
        <span class="tz-picker__meta">
          <span class="tz-picker__time">{{ timeAt(c.iana) }}</span>
          <span class="tz-picker__off">{{ formatUtcOffset(c.iana) }}</span>
        </span>
        <span v-if="c.iana === modelValue" class="tz-picker__check">
          <IconCheck :size="18" />
        </span>
      </button>
    </div>
    <p v-else class="tz-picker__empty">Город не найдено, уточните написание.</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { VInput } from '@/components/ui'
import { IconSearch, IconCheck } from '@/components/icons'
import { TIMEZONE_CITIES } from '@/utils/timezoneCities'
import { formatUtcOffset } from '@/utils/practiceOptions'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'

// Lift the city search above the soft keyboard once it settles (shared M5
// composable) so the field isn't left under the keyboard on focus (K3).
const { onFieldFocus } = useKeyboardFieldScroll()

withDefaults(
  defineProps<{
    /** Selected IANA zone id (what the backend stores). */
    modelValue?: string
    placeholder?: string
  }>(),
  {
    modelValue: '',
    placeholder: 'Ваш город (Берлин, London)…',
  },
)

const emit = defineEmits<{ 'update:modelValue': [iana: string] }>()

const query = ref('')

/** The results list (scrolled back to the FIRST match on every keystroke --
 * see the watch below). */
const listEl = ref<HTMLElement | null>(null)

const filtered = computed(() => {
  const t = query.value.trim().toLowerCase()
  if (!t) return TIMEZONE_CITIES
  return TIMEZONE_CITIES.filter((c) => c.city.toLowerCase().includes(t) || c.q.includes(t))
})

// FE-36 follow-up: with the keyboard open the list is pinned to exactly one
// row (see the keyboard-open styles). A stale scrollTop would leave a MIDDLE
// row in that one-row window after the set shrinks -- the browser only
// clamps it once content is shorter than the scroll offset, which is exactly
// the visible "скролл скачет". Resetting to top on every input change keeps
// the FIRST match (or the only one) in view, deterministically.
watch(query, () => {
  if (listEl.value) listEl.value.scrollTop = 0
})

/** Current local time in the given zone ("14:35"), live + DST-aware. */
function timeAt(iana: string): string {
  try {
    return new Intl.DateTimeFormat('ru', {
      timeZone: iana,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date())
  } catch {
    return ''
  }
}

function select(iana: string): void {
  emit('update:modelValue', iana)
}
</script>

<style scoped>
.tz-picker {
  display: flex;
  flex-direction: column;
  /* FE-36 follow-up: one row's exact box height. Content is pinned by the
     explicit line-heights below (city 22 + zone 16) + vertical padding
     (2 × --space-3 = 28). Deterministic rows make the one-row list window
     below exact, on every platform/font fallback. */
  --tz-row-h: 66px;
}

.tz-picker__list {
  margin-top: var(--space-2);
  /* FE-36: a share of the LIVE visible viewport (--velo-vvh, published by
     useViewportGeometry), not a flat 320px -- with the keyboard open 320px
     is most of what's left and the first rows end up below the fold. At
     rest 45% of any phone viewport still exceeds 320, so the flat cap keeps
     winning there (byte-identical layout, keyboard closed). */
  max-height: min(320px, calc(var(--velo-vvh, 100lvh) * 0.45));
  overflow-y: auto;
  scrollbar-width: none;
  /* Crisp white plate (was murky glass-blue over the photo bg, operator 2026-06-19). */
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
}

.tz-picker__list::-webkit-scrollbar {
  display: none;
}

/* FE-36 follow-up (owner ruling): with the keyboard open the list is pinned
   to EXACTLY ONE row -- the first match (or the only one). The list height
   then never depends on the match count, so typing can neither reflow the
   step (the 1-match collapse was breathing the layout) nor visibly clamp a
   stale scroll offset. The rest of the matches stay reachable by scrolling
   the one-row window; the watch in the script re-tops it on every keystroke.
   (+2px = the list's own 1px top/bottom borders.) */
:global(html.is-keyboard-open) .tz-picker__list {
  height: calc(var(--tz-row-h) + 2px);
  max-height: none;
}

/* The empty hint occupies the same box as the one-row list, so the 0 <-> 1
   match boundary doesn't jump either. */
:global(html.is-keyboard-open) .tz-picker__empty {
  margin: var(--space-2) 0 0;
  height: calc(var(--tz-row-h) + 2px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.tz-picker__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  height: var(--tz-row-h);
  padding: var(--space-3) var(--space-4);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-body);
}

.tz-picker__row + .tz-picker__row {
  border-top: 1px solid var(--velo-border-light);
}

.tz-picker__row--active {
  background: var(--velo-glass-blue-15);
}

.tz-picker__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.tz-picker__city {
  font-size: var(--text-base);
  line-height: 22px;
  color: var(--velo-text-primary);
}

.tz-picker__zone {
  font-size: var(--text-12);
  line-height: 16px;
  color: var(--velo-text-secondary);
}

.tz-picker__meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-shrink: 0;
}

.tz-picker__time {
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
}

.tz-picker__off {
  font-size: var(--text-12);
  color: var(--velo-text-secondary);
}

.tz-picker__check {
  display: inline-flex;
  align-items: center;
  color: var(--velo-teal-600);
  flex-shrink: 0;
}

.tz-picker__empty {
  margin: var(--space-3) 0 0;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  text-align: center;
}
</style>
