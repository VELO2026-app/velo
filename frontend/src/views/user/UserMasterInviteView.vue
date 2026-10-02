<!--
  VELO Frontend -- UserMasterInviteView (invite screens, owner 2026-10-02)

  The landing page of the «Вас приглашают стать мастером» inbox row. The
  row itself is still the client-side simulation (UserInboxView injects it
  for telegram_id 388101199; search: MASTER_INVITE_SIMULATION) — the
  backend does not emit master.invite yet, so there is NO payload to bind
  and no server state to change: the page is the invitation card and the
  hand-off, nothing more. «Принять» goes to the apply wizard, the same
  hand-off the one-time claim flow uses (MasterInviteClaimView: claim ->
  apply); no success toast — nothing has succeeded on the server yet.

  When the real emitter ships, this page binds its payload here (and if
  the invite turns out school-scoped, SchoolInviteCard composes in — the
  join/offer screens already share it). Route: /user/master-invite (name
  'user-master-invite'), user zone, tab bar hidden.
-->

<template>
  <div class="master-invite">
    <VHeader title="Приглашение" show-back @back="router.back()" />

    <div class="master-invite__content velo-kbd-scroll">
      <VCard class="master-invite__card">
        <span class="master-invite__icon" aria-hidden="true">
          <IconMeditation :size="48" />
        </span>
        <h2 class="master-invite__heading">Вас приглашают стать мастером</h2>
        <p class="master-invite__text">
          Примите приглашение и подайте заявку — после верификации вы сможете вести свои практики.
        </p>
      </VCard>
      <div class="master-invite__actions">
        <VButton variant="primary" block @click="accept">Принять</VButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VCard } from '@/components/ui'
import { IconMeditation } from '@/components/icons'

const router = useRouter()

/** The hand-off the claim flow already uses: the apply wizard (and its
 *  applyGuard) owns everything that follows. No toast — no server state
 *  has changed while the invite is still the simulation. */
function accept(): void {
  void router.push({ name: 'master-apply' })
}
</script>

<style scoped>
.master-invite {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.master-invite__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-8) var(--velo-rail-pad-x) var(--space-5);
  gap: var(--space-4);
}

.master-invite__card {
  width: 100%;
  max-width: var(--velo-content-width-narrow);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-3);
}

/* The masters' semantic icon on the same light plate the who-this-is-about
   cards use — an invitation mark, not a verdict illustration. */
.master-invite__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  border-radius: var(--radius-full);
  background: var(--velo-glass-blue-15);
  color: var(--velo-primary);
}

.master-invite__heading {
  margin: var(--space-2) 0 0;
  font-family: var(--font-body);
  font-size: var(--text-xl);
  line-height: 1.3;
  color: var(--velo-text-primary);
  text-align: center;
  -webkit-text-stroke: var(--velo-text-stroke-strong) var(--velo-text-primary);
}

.master-invite__text {
  margin: 0;
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  line-height: 1.5;
  max-width: var(--velo-content-width-narrow);
}

.master-invite__actions {
  width: 100%;
  max-width: var(--velo-content-width-narrow);
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
