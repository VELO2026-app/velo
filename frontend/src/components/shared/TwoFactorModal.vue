<!--
  VELO Frontend -- TwoFactorModal (Admin DS, 2026-06-14, operator SVG «Confirm payment 2»)

  2FA gate for the admin payout approval: shield + «Одобрить {amount} (выплата) для
  {master}» + a 6-digit code + Подтвердить / Отмена.

  STUB (build-full-design-now): there is no 2FA-verify backend (the approve endpoint takes
  only an optional note), so the code is a UI gate — once 6 digits are entered, «Подтвердить»
  emits `submit` and the parent fires the real approve. Roadmap (Zod): a real 2FA verify step.
-->

<template>
  <VModal :open="open" @close="$emit('close')" :show-close="false">
    <div class="tfa">
      <span class="tfa__shield"><IconShield2FA :size="28" /></span>
      <h2 class="tfa__title">Подтверждение 2FA</h2>
      <p class="tfa__sub">Одобрить {{ amount }} (выплата) для {{ master }}</p>

      <div class="tfa__boxes">
        <input
          v-for="(d, i) in digits"
          :key="i"
          :ref="(el) => setBox(el, i)"
          class="tfa__box"
          :class="{ 'tfa__box--filled': !!d }"
          :value="d"
          inputmode="numeric"
          maxlength="1"
          aria-label="Цифра кода"
          @input="onInput(i, $event)"
          @keydown.backspace="onBackspace(i)"
        />
      </div>

      <VButton
        variant="primary"
        block
        :loading="loading"
        :disabled="!complete || loading"
        @click="submit"
      >
        Подтвердить
      </VButton>
      <button type="button" class="tfa__cancel" @click="$emit('close')">Отмена</button>
    </div>
  </VModal>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { VModal, VButton } from '@/components/ui'
import { IconShield2FA } from '@/components/icons'

const props = defineProps<{
  open: boolean
  amount: string
  master: string
  loading?: boolean
}>()

const emit = defineEmits<{
  submit: [code: string]
  close: []
}>()

const digits = ref<string[]>(['', '', '', '', '', ''])

// Plain element array for imperative focus (per-cell refs in a v-for).
const boxes: HTMLInputElement[] = []
function setBox(el: unknown, i: number): void {
  if (el instanceof HTMLInputElement) boxes[i] = el
}

const code = computed<string>(() => digits.value.join(''))
const complete = computed<boolean>(() => code.value.length === 6 && !digits.value.includes(''))

function onInput(i: number, e: Event): void {
  const v = (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(-1)
  digits.value[i] = v
  if (v && i < 5) boxes[i + 1]?.focus()
}

function onBackspace(i: number): void {
  if (!digits.value[i] && i > 0) boxes[i - 1]?.focus()
}

function submit(): void {
  if (complete.value) emit('submit', code.value)
}

// Clear + focus the first cell whenever the sheet opens.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    digits.value = ['', '', '', '', '', '']
    void nextTick(() => boxes[0]?.focus())
  },
)
</script>

<style scoped>
.tfa {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  text-align: center;
}

.tfa__shield {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: var(--radius-full);
  background: var(--velo-blue-100);
  color: var(--velo-blue-400);
}

.tfa__title {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.tfa__sub {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  margin: -8px 0 0;
}

.tfa__boxes {
  display: flex;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
}

.tfa__box {
  width: var(--velo-size-44);
  height: 52px;
  border: 1px solid var(--velo-border);
  border-radius: var(--velo-radius-9);
  background: var(--velo-bg-card-solid);
  font-family: var(--font-body);
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
  text-align: center;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

/* [FE-33] Focus emphasis without geometry: was border-width 1 -> 2px, an
   instant thickening (the transition only covered colour) -- the digit box
   visibly jerked. The 1px border stays; the ring is an outer box-shadow:
   paints outside the box, zero layout impact, follows the same radius. Reads
   as the same emphasis, without the jump. */
.tfa__box:focus {
  outline: none;
  border-color: var(--velo-primary);
  box-shadow: 0 0 0 1px var(--velo-primary);
}

.tfa__box--filled {
  border-color: var(--velo-primary);
}

.tfa__cancel {
  border: none;
  background: none;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  cursor: pointer;
  padding: 0;
}
</style>
