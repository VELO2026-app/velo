<!--
  VELO Frontend -- TargetUserCard (measured, PROMPT №610; owner Q11, PROMPT
  №611 -- avatar reverted to the DS's own size)

  The "who this is about" card -- avatar + name on a tinted plate. Owner Q9:
  goes in THREE places (ReportUserSheet, and both block-flow VConfirmDialog
  instances on MasterStudentProfileView) -- built once here, not copied
  three times.

  Measured from Report a user.svg / Report a user 2.svg: full width, rx10,
  primary @15% (= --velo-glass-blue-15, the same token every other
  primary-tinted plate in this app already uses), name Marmelad 18
  (--text-base).

  Owner Q11 (PROMPT №611): the SVG's avatar circle measured at Ø41; this
  component originally forced VAvatar's own "md" (40px) up to that exact
  pixel via a scoped `!important` override. Owner ruled: revert -- the
  mockup tells us WHICH token/size to apply, it doesn't license overriding
  a DS component for a 1px delta invisible to users but visible (and
  copyable) to every developer who opens this file. Plain `size="md"` now,
  no override.
-->

<template>
  <div class="target-user-card">
    <VAvatar :name="name" :url="avatarUrl ?? undefined" size="md" />
    <span class="target-user-card__name">{{ name }}</span>
  </div>
</template>

<script setup lang="ts">
import { VAvatar } from '@/components/ui'

defineProps<{
  name: string
  avatarUrl?: string | null
}>()
</script>

<style scoped>
.target-user-card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--velo-glass-blue-15);
  border-radius: var(--velo-radius-10);
  padding: var(--space-3) var(--space-4);
}

.target-user-card__name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}
</style>
