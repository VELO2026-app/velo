<!--
  VELO Frontend -- TargetUserCard (measured, ПРОМТ №610)

  The "who this is about" card -- avatar + name on a tinted plate. Owner Q9:
  goes in THREE places (ReportUserSheet, and both block-flow VConfirmDialog
  instances on MasterStudentProfileView) -- built once here, not copied
  three times.

  Measured from Report a user.svg / Report a user 2.svg: full width, rx10,
  primary @15% (= --velo-glass-blue-15, the same token every other
  primary-tinted plate in this app already uses), avatar circle Ø41
  (--velo-size-41, an existing token -- AdminParticipantsView/
  AdminPracticeDetailView already use it for their own hand-rolled avatar
  circles), name Marmelad 18 (--text-base).

  Reuses VAvatar (image + initials-fallback logic) rather than hand-rolling
  a third avatar implementation -- the 41px override below is scoped to
  THIS card only, VAvatar's own size variants are untouched.
-->

<template>
  <div class="target-user-card">
    <VAvatar
      :name="name"
      :url="avatarUrl ?? undefined"
      size="md"
      class="target-user-card__avatar"
    />
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

/* Measured Ø41 -- VAvatar's own "md" is 40px, close but not exact; forced
   to the precise token here rather than adding a one-off size variant to
   the shared component for a 1px difference nothing else needs. */
.target-user-card__avatar {
  width: var(--velo-size-41) !important;
  height: var(--velo-size-41) !important;
}

.target-user-card__name {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}
</style>
