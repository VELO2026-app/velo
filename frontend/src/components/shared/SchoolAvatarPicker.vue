<!--
  VELO Frontend -- SchoolAvatarPicker (tz-curator.md §1.5 / §7.2)

  The school's avatar upload section: a full-width white card holding a
  rectangular outline zone («+ Загрузить фото» with the upload affordance);
  a chosen file renders as a preview with «Заменить / Убрать» INSIDE the same
  card (§1.5: the states must never leave their card). Rendered ONLY behind
  the SCHOOL_MEDIA_UPLOAD_ENABLED kill-switch (utils/constants.ts): there is
  no upload backend yet (§7.1 №4), so the picker holds a LOCAL object-URL
  preview and persists nothing -- the v-model is a preview handle, not a
  server URL. When the BE contract lands, the same v-model becomes the
  uploaded URL and the object-URL plumbing is the only thing to retire.

  The object URL we mint is ours to revoke: replacing a preview revokes the
  previous one, unmount revokes the last (no leaks across picks).
-->

<template>
  <label class="sap" :aria-label="ariaLabel">
    <input
      ref="inputEl"
      class="sap__input"
      type="file"
      accept="image/*"
      tabindex="-1"
      @change="onChange"
    />
    <span class="sap__card">
      <img v-if="modelValue" :src="modelValue" class="sap__img" alt="" />
      <span v-else class="sap__zone">
        <IconCamera :size="22" />
        <span>+ Загрузить фото</span>
      </span>
      <span v-if="modelValue" class="sap__actions">
        <!-- .stop keeps the inner buttons from re-triggering the label's
             file dialog; each button drives the input explicitly. -->
        <button type="button" class="sap__action" @click.stop="inputEl?.click()">Заменить</button>
        <button type="button" class="sap__action" @click.stop="onRemove">Убрать</button>
      </span>
    </span>
  </label>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { IconCamera } from '@/components/icons'

defineProps<{
  /** LOCAL preview URL (object URL) while no backend exists. */
  modelValue?: string | null
  ariaLabel?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
}>()

const inputEl = ref<HTMLInputElement | null>(null)

/** The one object URL this picker has minted and not yet handed over. */
let mintedUrl: string | null = null

function onChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset FIRST so picking the same file again still fires a change.
  input.value = ''
  if (!file) return
  if (mintedUrl) URL.revokeObjectURL(mintedUrl)
  mintedUrl = URL.createObjectURL(file)
  emit('update:modelValue', mintedUrl)
}

function onRemove(): void {
  if (mintedUrl) URL.revokeObjectURL(mintedUrl)
  mintedUrl = null
  emit('update:modelValue', null)
}

onBeforeUnmount(() => {
  if (mintedUrl) URL.revokeObjectURL(mintedUrl)
})
</script>

<style scoped>
.sap {
  display: block;
  cursor: pointer;
}

/* The native input is invisible: the card below is the whole control. */
.sap__input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.sap__card {
  display: block;
  width: 100%;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  transition: opacity var(--transition-fast);
}

.sap:active .sap__card {
  opacity: 0.85;
}

/* The §1.5 zone: rectangular outline, centred icon + «+ Загрузить фото». */
.sap__zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 96px;
  border: 1.5px dashed var(--velo-border-card);
  border-radius: var(--radius-md);
  color: var(--velo-text-secondary);
  font-size: var(--text-sm);
}

.sap__img {
  display: block;
  width: 100%;
  height: 160px;
  object-fit: cover;
  border-radius: var(--radius-md);
}

.sap__actions {
  display: flex;
  justify-content: center;
  gap: var(--space-4);
  padding-top: var(--space-2);
}

.sap__action {
  border: none;
  background: none;
  padding: 0;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-primary);
  cursor: pointer;
}

.sap__card:focus-within {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}
</style>
