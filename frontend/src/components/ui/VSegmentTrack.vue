<!--
  VELO Frontend -- VSegmentTrack (DS primitive, extracted 2026-06-16)

  The "track + thumb" segmented control: a single glass track with a sliding
  primary fill-pill on the active option. This is the operator-approved master
  idiom and is DISTINCT from VSegment (the two-pill filter on admin lists +
  master practices tabs) — the two idioms intentionally coexist (SHELL fork #5=А).

  Extracted verbatim from two duplicated local copies so the markup + CSS live in
  one place:
    - variant="toggle" — compact auto-width pills (master dashboard period toggle
      + analytics period toggle): track padding 2px, btn text-xs / space-1 space-3,
      inactive colour text-primary.
    - variant="tabs"   — full-width equal segments (analytics tabs + master
      practices tabs): track padding 3px, btn flex:1 / text-sm / 6px 10px,
      inactive colour text-primary.

  Track glass aligned to the operator SVG «1 Practices» (2026-06-18): blue-200 @15
  tint + 2px backdrop blur, and the tabs inactive colour brought to text-primary so
  the Practices and Analytics tab strips are byte-identical (operator fork Б=Г).

  Usage:
    <VSegmentTrack v-model="period" :options="PERIOD_OPTIONS" variant="toggle" />
    <VSegmentTrack v-model="activeTab" :options="TAB_OPTIONS" variant="tabs" />
    <VSegmentTrack v-model="filter" :options="OPTIONS" variant="tabs" scrollable />
-->
<template>
  <div
    class="v-segment-track"
    :class="[`v-segment-track--${variant}`, { 'v-segment-track--scrollable': scrollable }]"
    role="tablist"
    :aria-label="ariaLabel || undefined"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="tab"
      :aria-selected="modelValue === opt.value"
      class="v-segment-track__btn"
      :class="{ 'v-segment-track__btn--active': modelValue === opt.value }"
      @click="emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<script setup lang="ts" generic="T extends string">
interface SegOption {
  value: T
  label: string
}

withDefaults(
  defineProps<{
    /** Currently-selected option value. */
    modelValue: T
    /** Options rendered left→right. */
    options: ReadonlyArray<SegOption>
    /** Shape: compact auto-width pills ('toggle') or full-width segments ('tabs'). */
    variant?: 'toggle' | 'tabs'
    /** Many tabs on one line: content-sized buttons + horizontal swipe scroll
     *  (VSegment's --scrollable recipe) instead of squeezed equal segments. */
    scrollable?: boolean
    ariaLabel?: string
  }>(),
  {
    variant: 'toggle',
    scrollable: false,
    ariaLabel: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: T]
}>()
</script>

<style scoped>
/* Shared track + pill (identical across both variants). */
.v-segment-track {
  display: flex;
  gap: var(--velo-gap-2);
  background: var(--velo-glass-blue-200-15);
  border: 1px solid var(--velo-glass-border);
  border-radius: var(--radius-xl);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.v-segment-track__btn {
  font-family: var(--font-body);
  background: transparent;
  border: none;
  border-radius: var(--radius-xl);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.v-segment-track__btn--active {
  background: var(--velo-primary);
  color: var(--velo-white);
}

/* Toggle: compact auto-width pills (dashboard + analytics period toggles). */
.v-segment-track--toggle {
  padding: 2px;
}

.v-segment-track--toggle .v-segment-track__btn {
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  padding: var(--space-1) var(--space-3);
}

/* Tabs: full-width equal segments (analytics tab segment). */
.v-segment-track--tabs {
  padding: 3px;
}

.v-segment-track--tabs .v-segment-track__btn {
  flex: 1;
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  padding: 6px 10px;
}

/* Active label is white on the primary fill-pill. Declared at variant
   specificity (and after the variant rules) so it wins over the inactive
   per-variant colour above — otherwise `.v-segment-track--toggle
   .v-segment-track__btn` (0,2,0) overrides `.v-segment-track__btn--active`
   (0,1,0) and the active text stays dark. */
.v-segment-track--toggle .v-segment-track__btn--active,
.v-segment-track--tabs .v-segment-track__btn--active {
  color: var(--velo-white);
}

/* -- Scrollable (VSegment's --scrollable recipe, mirrored): many tabs on one
   line -- content-sized buttons + horizontal swipe scroll, scrollbar hidden
   (the overflowing pills themselves hint the overflow). Composes with --tabs,
   whose flex:1 equal segments are overridden to flex-basis auto here. */
.v-segment-track--scrollable {
  overflow-x: auto;
  scrollbar-width: none; /* Firefox */
}

.v-segment-track--scrollable::-webkit-scrollbar {
  display: none; /* WebKit */
}

.v-segment-track--scrollable .v-segment-track__btn {
  flex: 0 0 auto;
  white-space: nowrap;
}
</style>
