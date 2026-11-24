<!--
  VELO Frontend -- TicketAside (FE-262, slice 2)

  The right-hand panel of the support screen: the person who wrote and the
  facts of the ticket -- only what the ticket row carries (status, category,
  dates, who holds it, who resolved it, the person's rating). The actions on
  the ticket are in the header of the conversation. The person's role,
  practices, payments and profile link are not in the ticket (see the PR:
  needs backend).
-->

<template>
  <div class="ticket-aside" data-testid="ticket-aside">
    <h2 class="ticket-aside__title">{{ t('console.support.user.title') }}</h2>
    <template v-if="ticket">
      <div class="ticket-aside__person">
        <VAvatar :name="openerName" :url="ticket.opener?.avatar_url ?? undefined" size="md" />
        <span class="ticket-aside__name">{{ openerName }}</span>
      </div>

      <dl class="ticket-aside__facts">
        <div class="ticket-aside__fact">
          <dt>{{ t('console.support.user.status') }}</dt>
          <dd>
            <RequestStatusBadge :tone="supportStatusBadge(ticket.status)">
              {{ supportStatusLabel(ticket.status) }}
            </RequestStatusBadge>
          </dd>
        </div>
        <div class="ticket-aside__fact">
          <dt>{{ t('console.support.user.category') }}</dt>
          <dd>{{ supportCategoryLabel(ticket.category) }}</dd>
        </div>
        <div class="ticket-aside__fact">
          <dt>{{ t('console.support.user.opened') }}</dt>
          <dd>{{ formatDate(ticket.created_at, viewerTz) }}</dd>
        </div>
        <div class="ticket-aside__fact">
          <dt>{{ t('console.support.user.changed') }}</dt>
          <dd>{{ formatDate(ticket.status_changed_at, viewerTz) }}</dd>
        </div>
        <div class="ticket-aside__fact">
          <dt>{{ t('console.support.user.taker') }}</dt>
          <dd data-testid="ticket-taker">{{ takerText }}</dd>
        </div>
        <div v-if="ticket.status === 'resolved' && ticket.resolved_by" class="ticket-aside__fact">
          <dt>{{ t('console.support.user.resolvedBy') }}</dt>
          <dd>{{ ticket.resolved_by.name ?? adminFallback }}</dd>
        </div>
      </dl>

      <!-- The person's rating: the stars, the comment as written (the backend
           does not translate it), its language and the admin it is about. -->
      <div v-if="ticket.rating" class="ticket-aside__rating" data-testid="ticket-rating">
        <RatingStars :stars="ticket.rating.stars" :size="18" />
        <p v-if="ticket.rating.comment" class="ticket-aside__comment">
          {{ ticket.rating.comment }}
        </p>
        <p v-if="ticket.rating.comment && ticket.rating.comment_locale" class="ticket-aside__meta">
          {{
            t('adminScreens.adminSupport.rating.commentIn', {
              language: localeName(ticket.rating.comment_locale),
            })
          }}
        </p>
        <p v-if="ratingResolverName" class="ticket-aside__meta">
          {{ t('adminScreens.adminSupport.rating.aboutResolver', { name: ratingResolverName }) }}
        </p>
      </div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { VAvatar } from '@/components/ui'
import RatingStars from '@/components/console/requests/RatingStars.vue'
import RequestStatusBadge from '@/components/console/requests/RequestStatusBadge.vue'
import { takerLabel } from '@/components/console/requests/ticketTaker'
import type { AdminSupportTicket } from '@/api/support'
import { useViewerTimezone } from '@/composables/useViewerTimezone'
import { formatDate } from '@/utils/format'
import { supportCategoryLabel, supportStatusBadge, supportStatusLabel } from '@/utils/supportTopics'

const props = defineProps<{
  /** The ticket, or null while it loads or is missing. */
  ticket: AdminSupportTicket | null
  /** The viewing admin's id: "mine" in the taker line. */
  myId: string
}>()

const viewerTz = useViewerTimezone()
const adminFallback = computed(() => t('adminScreens.adminSupport.claimedBy.adminFallback'))

const openerName = computed(
  () => props.ticket?.opener?.name ?? t('adminScreens.adminSupport.userFallback'),
)

const takerText = computed(() => takerLabel(props.ticket?.claimed_by ?? null, props.myId))

const ratingResolverName = computed(() => {
  const resolver = props.ticket?.rating?.rated_resolver
  return resolver ? (resolver.name ?? adminFallback.value) : ''
})

/** The comment's likely language, signed for the admin. An unknown code shows itself. */
function localeName(code: string): string {
  const label = t(`adminScreens.adminSupport.rating.locales.${code}`)
  return label === `adminScreens.adminSupport.rating.locales.${code}` ? code : label
}
</script>

<style scoped>
.ticket-aside {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.ticket-aside__title {
  margin: 0;
  font-size: var(--velo-fs-18);
  font-weight: inherit;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.ticket-aside__person {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.ticket-aside__name {
  min-width: 0;
  font-size: var(--velo-fs-16);
  color: var(--velo-text-primary);
  overflow-wrap: anywhere;
}

.ticket-aside__facts {
  display: flex;
  flex-direction: column;
  margin: 0;
}

.ticket-aside__fact {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 42px;
  border-bottom: 1px solid var(--velo-border-light);
  font-size: var(--velo-fs-14);
}

.ticket-aside__fact dt {
  flex-shrink: 0;
  color: var(--velo-text-secondary);
}

.ticket-aside__fact dd {
  margin: 0;
  min-width: 0;
  text-align: right;
  color: var(--velo-text-primary);
}

.ticket-aside__rating {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--velo-radius-10);
  background: var(--velo-bg-subtle);
}

.ticket-aside__comment {
  margin: 0;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ticket-aside__meta {
  margin: 0;
  font-size: var(--velo-fs-12);
  /* On the grey rating block the secondary text is under 4.5:1. */
  color: var(--velo-text-primary);
}
</style>
