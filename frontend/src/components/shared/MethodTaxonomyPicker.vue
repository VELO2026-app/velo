<!--
  VELO Frontend -- MethodTaxonomyPicker (batch L, FOUNDATION-1)

  The two-level направление→вид method picker, extracted from MasterApplyView's
  inline block (batch J) into ONE reusable component so the apply wizard, the
  edit-profile methods block and the pending method-change display all share a
  single source of truth (DS-single-source mandate).

  Presentational + DS-token-clean. Owns: level-1 direction chips, per-direction
  level-2 style chips, the white-card layout, and the «Свой вариант» custom
  input. Selection state is internal; the public contract is a v-model of the
  STORED flat `methods: string[]` («Направление — Вид» vocabulary), seeded and
  flattened through @/utils/methodTaxonomy (drop-unmatched, Q3=В). The outer
  section label + any validation error stay with the parent (they differ per
  screen: «Направления практик *» vs «Методы»).

  Props:
    - modelValue  : the stored flat methods (v-model).
    - allowCustom : show the «Свой вариант» chip + free-text input (default true;
                    force off in readonly).
    - readonly    : render as a non-interactive summary — only the SELECTED
                    directions/styles, as filled non-clickable chips, no custom
                    control. Used by the pending «ожидают подтверждения» display.

  R5 stage 3b: the OPTIONS offered (which directions/styles render as chips)
  are fetched from the DB-backed catalog (GET /api/v1/taxonomy, active-only)
  on mount, falling back to the hardcoded DIRECTION_OPTIONS/
  STYLE_OPTIONS_BY_DIRECTION on fetch failure -- never blocks the picker.
  The SELECTION mechanics (parseMethods/flattenMethods, i.e. how a chosen
  chip round-trips to the stored `methods: string[]`) are UNCHANGED --
  still keyed against the hardcoded taxonomy internally. The catalog's seed
  is byte-identical to those consts, so this is safe today; a later stage
  can teach methodTaxonomy.ts itself to read the catalog if the two ever
  diverge (e.g. once stage-4 auto-promote adds a genuinely new value).
-->

<template>
  <div class="mtp">
    <!-- Level 1: directions (+ «Свой вариант» when editable). -->
    <VCard class="mtp__chip-card" padding="none">
      <div class="mtp__chips">
        <VChip
          v-for="dir in level1Directions"
          :key="dir.value"
          size="md"
          :clickable="!readonly"
          :active="selection.directions.includes(dir.value)"
          @click="toggleDirection(dir.value)"
        >
          {{ dir.label }}
        </VChip>
        <VChip
          v-if="allowCustom && !readonly"
          size="md"
          clickable
          :active="selection.customEnabled"
          @click="toggleCustom"
        >
          Свой вариант
        </VChip>
        <!-- Readonly display of the custom variant (R3/R4 fix, PROMPT №391):
             parseMethods now SURFACES an unmatched string instead of
             dropping it (Q3=А, was Q3=В) -- this chip is what actually shows
             it, matching the selected-direction chips above rather than
             bespoke markup. -->
        <VChip v-if="readonly && selection.customEnabled" size="md" :active="true">
          {{ selection.customText }}
        </VChip>
      </div>
    </VCard>

    <!-- Level 2: per selected direction that has (in readonly: chosen) styles. -->
    <VCard
      v-for="card in styleCards"
      :key="`styles-${card.dir}`"
      class="mtp__chip-card mtp__styles"
      padding="none"
    >
      <span class="mtp__styles-title">{{ card.label }}</span>
      <div class="mtp__chips">
        <VChip
          v-for="st in card.styles"
          :key="st.value"
          size="md"
          :clickable="!readonly"
          :active="(selection.styles[card.dir] ?? []).includes(st.value)"
          @click="toggleStyle(card.dir, st.value)"
        >
          {{ st.label }}
        </VChip>
      </div>
    </VCard>

    <!-- «Свой вариант»: a custom direction not in the base taxonomy. -->
    <VInput
      v-if="allowCustom && !readonly && selection.customEnabled"
      v-model="customText"
      placeholder="Укажите направление…"
      class="mtp__other"
      @focus="onFieldFocus"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { VCard, VChip, VInput } from '@/components/ui'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import {
  DIRECTION_OPTIONS,
  stylesForDirection,
  type DirectionOption,
  type StyleOption,
} from '@/utils/practiceOptions'
import {
  flattenMethods,
  parseMethods,
  directionLabel,
  applyTaxonomyCatalog,
  taxonomyCatalogVersion,
  type MethodSelection,
} from '@/utils/methodTaxonomy'
import { getActiveTaxonomy, type TaxonomyListResponse } from '@/api/taxonomy'
import type { PracticeDirection } from '@/api/types'

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    allowCustom?: boolean
    readonly?: boolean
  }>(),
  {
    allowCustom: true,
    readonly: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [methods: string[]]
}>()

// Lift the focused «Свой вариант» field above the soft keyboard once it settles
// (shared composable — same behaviour the wizard had inline).
const { onFieldFocus } = useKeyboardFieldScroll()

// -- Internal selection state (mirrors the wizard's inline refs) -------------
const selection = reactive<MethodSelection>({
  directions: [],
  styles: {},
  customEnabled: false,
  customText: '',
})

// Order-insensitive set equality (flatten output has no duplicates).
function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x))
}

// PROMPT №503 commit 2: the sameSet() guard above is necessary (without it,
// our own emitChange -> parent v-model -> this watch would loop) but it was
// ALSO blocking a legitimate reparse. A value first parsed against a COLD
// catalog (this component's own onMounted fetch hasn't resolved yet -- the
// immediate watch below always runs before onMounted) lands in
// selection.customText verbatim; flattenMethods echoes customText back
// UNCHANGED regardless of catalog state, so once the catalog warms and the
// parent re-supplies the exact same text, sameSet() reads "unchanged" and
// bails forever -- the picker never re-interprets it as the now-matched chip
// it actually is. That is the exact mechanism behind "Иглоукалывание", a
// real existing chip, staying stuck in the free-text box.
//
// Fix: also watch taxonomyCatalogVersion (bumped once per
// applyTaxonomyCatalog() call, commit 1) and track which version produced
// the CURRENT selection. A version bump forces exactly one reparse even when
// sameSet() says the text is unchanged -- the anti-echo-loop guard still
// applies within a single catalog version (our own emit never changes the
// version), so the loop it was written to prevent cannot reappear.
const parsedAtCatalogVersion = ref<number | null>(null)
watch(
  [() => props.modelValue, taxonomyCatalogVersion],
  ([val, version]) => {
    const incoming = val ?? []
    if (parsedAtCatalogVersion.value === version && sameSet(flattenMethods(selection), incoming)) {
      return
    }
    const parsed = parseMethods(incoming)
    selection.directions = parsed.directions
    selection.styles = parsed.styles
    selection.customEnabled = parsed.customEnabled
    selection.customText = parsed.customText
    parsedAtCatalogVersion.value = version
  },
  { immediate: true },
)

function emitChange(): void {
  emit('update:modelValue', flattenMethods(selection))
}

// -- R5 stage 3b: DB-backed catalog, offline/error fallback to the hardcoded
// consts. null until the fetch resolves (or if it fails) -- callers below
// treat null the same as "use the fallback", so nothing blocks on this.
const catalog = ref<TaxonomyListResponse | null>(null)

onMounted(async () => {
  try {
    catalog.value = await getActiveTaxonomy()
    // Bug 5 leak 1 fix (PROMPT №408): feed the SAME fetch into methodTaxonomy.ts's
    // shared module cache. Every screen embeds this picker, so this is what
    // actually warms parseMethods/flattenMethods/directionLabel for a
    // catalog-only value -- a screen no longer has to separately remember its
    // own primeMethodTaxonomyCatalog() call (MasterApplyView never did, which
    // is exactly how «custom_vwxosjci» leaked into the applicant's methods).
    applyTaxonomyCatalog(catalog.value)
  } catch {
    catalog.value = null // offline/error -- fall back to DIRECTION_OPTIONS below
  }
})

/** All directions, catalog-first. Cast is safe: the seeded catalog is
 *  byte-identical to DIRECTION_OPTIONS today (see header comment). */
function allDirectionOptions(): DirectionOption[] {
  if (!catalog.value) return [...DIRECTION_OPTIONS]
  return catalog.value.directions.map((d) => ({
    value: d.value as PracticeDirection,
    label: d.label,
  }))
}

/** Styles for one direction, catalog-first. */
function catalogStylesForDirection(dir: PracticeDirection): StyleOption[] {
  if (!catalog.value) return stylesForDirection(dir)
  const entry = catalog.value.directions.find((d) => d.value === dir)
  return entry ? (entry.styles ?? []).map((s) => ({ value: s.value, label: s.label })) : []
}

// -- Level 1 (directions) ----------------------------------------------------
// Editable: the whole taxonomy. Readonly: only the chosen directions.
const level1Directions = computed<DirectionOption[]>(() => {
  const all = allDirectionOptions()
  return props.readonly ? all.filter((o) => selection.directions.includes(o.value)) : all
})

// -- Level 2 (styles per selected direction) ---------------------------------
// Editable: every style of the direction (active ones highlighted). Readonly:
// only the chosen styles. A direction with no styles (or, in readonly, no
// chosen styles) contributes no level-2 card.
const styleCards = computed<{ dir: PracticeDirection; label: string; styles: StyleOption[] }[]>(
  () => {
    const cards: { dir: PracticeDirection; label: string; styles: StyleOption[] }[] = []
    for (const dir of selection.directions) {
      const all = catalogStylesForDirection(dir)
      if (all.length === 0) continue
      const chosen = selection.styles[dir] ?? []
      const styles = props.readonly ? all.filter((s) => chosen.includes(s.value)) : all
      if (props.readonly && styles.length === 0) continue
      cards.push({ dir, label: directionLabel(dir), styles })
    }
    return cards
  },
)

// -- Toggles -----------------------------------------------------------------
function toggleDirection(dir: PracticeDirection): void {
  if (props.readonly) return
  const idx = selection.directions.indexOf(dir)
  if (idx === -1) {
    selection.directions.push(dir)
  } else {
    selection.directions.splice(idx, 1)
    // Deselecting a direction drops any styles picked under it.
    delete selection.styles[dir]
  }
  emitChange()
}

function toggleStyle(dir: PracticeDirection, style: string): void {
  if (props.readonly) return
  const list = selection.styles[dir] ?? (selection.styles[dir] = [])
  const idx = list.indexOf(style)
  if (idx === -1) list.push(style)
  else list.splice(idx, 1)
  emitChange()
}

function toggleCustom(): void {
  if (props.readonly) return
  selection.customEnabled = !selection.customEnabled
  if (!selection.customEnabled) selection.customText = ''
  emitChange()
}

const customText = computed<string>({
  get: () => selection.customText,
  set: (v: string) => {
    selection.customText = v
    emitChange()
  },
})
</script>

<style scoped>
.mtp {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* White VCard подложка around each chip group (J2c/J2d). */
.mtp__chip-card {
  padding: var(--space-3);
}

.mtp__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* Level-2 (виды) card: a small direction heading above its style chips. */
.mtp__styles {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.mtp__styles-title {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
}

.mtp__other {
  margin-top: var(--space-1);
}
</style>
