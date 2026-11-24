<!--
  VELO Frontend -- ConsoleMailView (FE-268, FE-262 slice 5)

  The mail module of the web console: the form of a new announcement
  (AnnouncementForm) and, beside it, the card of the sent ones.

  The sent ones are not there: the server keeps no row of an announcement,
  and `GET /admin/announcements` needs BE-256. The card says so (an empty
  state, no fake rows) until the history exists.
-->

<template>
  <ConsolePage
    :title="t('console.modules.mail')"
    :crumbs="t('console.groups.growth')"
    testid="console-mail"
  >
    <div class="mail">
      <AnnouncementForm />
      <ConsoleCard :title="t('console.mail.history.title')" data-testid="announcement-history">
        <OverviewEmpty
          :title="t('console.mail.history.emptyTitle')"
          :description="t('console.mail.history.emptyBody')"
        />
      </ConsoleCard>
    </div>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import OverviewEmpty from '@/components/console/overview/OverviewEmpty.vue'
import AnnouncementForm from '@/components/console/mail/AnnouncementForm.vue'
</script>

<style scoped>
.mail {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

/* Under 1100 px the form and the history stand one over the other. */
@media (max-width: 1099px) {
  .mail {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
