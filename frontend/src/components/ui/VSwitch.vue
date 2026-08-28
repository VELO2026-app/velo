<!--
  VELO Frontend -- VSwitch Component (Profile redesign Screen E)

  Boolean on/off switch (pill track + sliding knob), matching the Figma
  notifications toggles. Reusable primitive: any future on/off setting
  should use this.

  Usage:
    <VSwitch v-model="enabled" />
    <VSwitch v-model="enabled" :disabled="true" aria-label="Push" />
-->

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="ariaLabel || undefined"
    class="v-switch"
    :class="{ 'v-switch--on': modelValue, 'v-switch--disabled': disabled }"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="v-switch__knob" />
  </button>
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue?: boolean
    disabled?: boolean
    ariaLabel?: string
  }>(),
  {
    modelValue: false,
    disabled: false,
    ariaLabel: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

function toggle(): void {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<style scoped>
.v-switch {
  position: relative;
  flex-shrink: 0;
  width: 42px;
  height: 25px;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--velo-border);
  cursor: pointer;
  transition: background-color var(--transition-base);
}

/* [FE-26] 44px touch-target bar: the track STAYS 42x25 visually (it sits in
   tight settings rows next to its label -- growing the track would reflow
   every row); the tappable zone grows to 44x45 via an invisible overlay
   centred on the control. Taps land on the overlay = the button itself.
   A disabled button suppresses pointer events entirely, disabled state
   is unaffected. */
.v-switch::after {
  content: '';
  position: absolute;
  inset: -10px -1px;
}

.v-switch--on {
  background: var(--velo-primary);
}

.v-switch--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.v-switch__knob {
  position: absolute;
  top: 2.5px;
  left: 2.5px;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  background: var(--velo-white);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform var(--transition-base);
}

.v-switch--on .v-switch__knob {
  transform: translateX(17px);
}
</style>
