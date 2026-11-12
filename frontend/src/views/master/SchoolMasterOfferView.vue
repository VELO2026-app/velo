<!--
=============================================================================
VELO Frontend — SchoolMasterOfferView (BE-59/GT-27, owner mockup 2026-10-02)
=============================================================================

Invitation heading (i18n:masterScreens.schoolMasterOffer.invited.title) —
the consent screen of the curator's
master-role appointment: the curator offers, the appointee confirms, and
the appointment takes effect HERE (POST /schools/{id}/master-offer/
accept turns the member row into a master's). Reached from the
school.master_offered inbox notification (its body text invites the
recipient to run the school), which UserInboxView routes here by TYPE — the
notification rides
the generic open_school action like every school event. Standalone
route like the join screen, no guard: the endpoints decide.

THE CARD AND THE OFFER ARE TWO READS, ON PURPOSE. The school page
(GET /schools/{id}) paints the card — the addressee is a member of
the school, so the page answers; there is deliberately NO member-side
"my offer" endpoint (the offer's state is the curator's view, the roster).
The offer's existence is therefore proven only by the accept itself:

State machine (each renders honestly, none fakes data):
  loading              -> spinner (i18n:common.inviteChecking)
  transient            -> retry (i18n:common.retry; W11: a hiccup is not a
                          verdict)
  gone (page 404)      -> the invalid-invite title
                          (i18n:masterScreens.schoolMasterOffer.invalid.title)
                          — the school is
                          dark/gone or the reader is no longer a member;
                          for the addressee that IS the death of the invite
  offerGone (404 on
  accept)              -> the offer-gone error (i18n:errors.master_offer_not_found) —
                          no offer for you here, one answer (P-08)
  verification (403
  on accept)           -> verification needed
                          (i18n:masterScreens.schoolMasterOffer.verificationNeeded)
                          — the caller's
                          verification lapsed since the offer; the offer
                          SURVIVES, so the way out is the apply wizard,
                          not a retry
  page                 -> SchoolInviteCard + accept
                          (i18n:masterScreens.schoolMasterOffer.accept) /
                          decline (i18n:masterScreens.schoolMasterOffer.decline)

The card is the shared invite card (owner mockup 2026-10-02): logo, name,
the two counters, the school's description, the bold heading. No analytics
lines — counts only, by the same ruling.
=============================================================================
-->

<template>
  <div class="master-offer">
    <div class="master-offer__content velo-kbd-scroll">
      <!-- School page in flight -->
      <template v-if="loading">
        <VLoader size="lg" />
        <p class="master-offer__subtitle">
          {{ t('common.inviteChecking') }}
        </p>
      </template>

      <!-- Transient (network/timeout): a retry, not a verdict. -->
      <template v-else-if="transientError">
        <h2 class="master-offer__title">
          {{ t('common.inviteCheckFailed') }}
        </h2>
        <p class="master-offer__subtitle">
          {{ t('common.connProblem') }}
        </p>
        <div class="master-offer__actions">
          <VButton variant="primary" block :loading="loading" @click="load">{{
            t('common.retry')
          }}</VButton>
        </div>
      </template>

      <!-- The school is dark/gone, or the reader is no longer a member. -->
      <template v-else-if="gone">
        <h2 class="master-offer__title">
          {{ t('masterScreens.schoolMasterOffer.invalid.title') }}
        </h2>
        <p class="master-offer__subtitle">
          {{ t('masterScreens.schoolMasterOffer.unavailable') }}
        </p>
        <div class="master-offer__actions">
          <VButton variant="primary" block @click="router.replace({ name: 'root' })">
            {{ t('common.backHome') }}
          </VButton>
        </div>
      </template>

      <!-- The offer itself turned out dead at the accept gate. -->
      <template v-else-if="offerGone">
        <h2 class="master-offer__title">{{ offerGoneTitle }}</h2>
        <div class="master-offer__actions">
          <VButton variant="primary" block @click="router.replace({ name: 'root' })">
            {{ t('common.backHome') }}
          </VButton>
        </div>
      </template>

      <!-- The caller's master verification lapsed since the offer. -->
      <template v-else-if="verificationRequired">
        <h2 class="master-offer__title">
          {{ t('masterScreens.schoolMasterOffer.verificationNeeded') }}
        </h2>
        <p class="master-offer__subtitle">
          {{ t('masterScreens.schoolMasterOffer.verifyingNote') }}
        </p>
        <div class="master-offer__actions">
          <VButton variant="primary" block @click="router.replace({ name: 'master-apply' })">
            {{ t('masterScreens.schoolMasterOffer.apply') }}
          </VButton>
        </div>
      </template>

      <!-- The school card behind the offer. -->
      <template v-else-if="page">
        <SchoolInviteCard
          class="master-offer__card"
          :name="page.name"
          :avatar-url="page.avatar_url"
          :students-count="page.students_count"
          :masters-count="page.masters_count"
          :description="page.description"
          :curator-name="page.curator.display_name"
          :heading="t('masterScreens.schoolMasterOffer.invited.title')"
        />
        <div class="master-offer__actions">
          <VButton
            variant="primary"
            block
            :loading="accepting"
            :disabled="declining"
            @click="accept"
          >
            {{ t('masterScreens.schoolMasterOffer.accept') }}
          </VButton>
          <VButton
            variant="outline"
            block
            :loading="declining"
            :disabled="accepting"
            @click="decline"
          >
            {{ t('masterScreens.schoolMasterOffer.decline') }}
          </VButton>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { acceptSchoolMasterOffer, declineSchoolMasterOffer, getSchoolPage } from '@/api/schools'
import { ApiResponseError } from '@/api/client'
import type { SchoolPageResponse } from '@/api/types'
import { errorMessage, extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { useQueryCache } from '@pinia/colada'
import { membershipChanged } from '@/composables/queries/schools'
import { VButton, VLoader } from '@/components/ui'
import SchoolInviteCard from '@/components/shared/SchoolInviteCard.vue'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()
const queryCache = useQueryCache()

const loading = ref(true)
const transientError = ref(false)
const gone = ref(false)
const page = ref<SchoolPageResponse | null>(null)

const accepting = ref(false)
const declining = ref(false)
const offerGone = ref(false)
const verificationRequired = ref(false)

/** errorMessages.ts owns the phrase — the screen frames it, the table words it. */
const offerGoneTitle = errorMessage('master_offer_not_found')

/** The school page lives in the viewer's own zone — the join screen's idiom. */
function schoolRoute(id: string): { name: string; params: { id: string } } {
  return authStore.role === 'master'
    ? { name: 'master-school', params: { id } }
    : { name: 'user-school', params: { id } }
}

async function load(): Promise<void> {
  loading.value = true
  transientError.value = false
  gone.value = false
  try {
    page.value = await getSchoolPage(String(route.params.id ?? ''))
  } catch (e) {
    if (e instanceof ApiResponseError && e.status === 404) {
      gone.value = true
    } else {
      transientError.value = true
    }
  } finally {
    loading.value = false
  }
}

async function accept(): Promise<void> {
  if (!page.value || accepting.value || declining.value) return
  accepting.value = true
  try {
    await acceptSchoolMasterOffer(page.value.id)
    toast.success(t('masterScreens.schoolMasterOffer.acceptedToast', { name: page.value.name }))
    // A new membership: this route sits outside the shells, so the hub is
    // re-read HERE, before the shell the navigation lands in (FE-88).
    await membershipChanged(queryCache, 'acceptSchoolMasterOffer')
    void router.replace(schoolRoute(page.value.id))
  } catch (e) {
    if (e instanceof ApiResponseError) {
      if (e.status === 404) {
        // No offer for you here (none, cancelled, accepted elsewhere, school
        // dark -- one answer, P-08). The card is stale: the invite is dead.
        page.value = null
        offerGone.value = true
        return
      }
      if (e.status === 403 && e.code === 'master_required') {
        // master_required: the offer SURVIVES this refusal — the way out is
        // the apply wizard, not a retry (the backend keeps the row).
        verificationRequired.value = true
        return
      }
    }
    toast.error(extractApiError(e, t('masterScreens.schoolMasterOffer.toast.acceptFailed')))
  } finally {
    accepting.value = false
  }
}

async function decline(): Promise<void> {
  if (!page.value || accepting.value || declining.value) return
  declining.value = true
  try {
    await declineSchoolMasterOffer(page.value.id)
    toast.success(t('masterScreens.schoolMasterOffer.toast.declined'))
    // FE-67: BOTH decisions end on the school page — the decliner stays a
    // member of the school they were just offered a role in.
    void router.replace(schoolRoute(page.value.id))
  } catch (e) {
    // Decline answers 204 even when it was not yours — anything here is a
    // transport problem, so the screen stays and the toast says what happened.
    toast.error(extractApiError(e, t('masterScreens.schoolMasterOffer.toast.declineFailed')))
  } finally {
    declining.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.master-offer {
  /* Fill AppFrame's stable height — never dvh/vh (collapse on keyboard). Canon §2. */
  min-height: 100%;
  background: transparent;
  display: flex;
  flex-direction: column;
}

.master-offer__content {
  flex: 1;
  /* ROOT-LOCK: own the scroll (html/body/#app no longer absorb overflow). */
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Standalone route (outside MobileLayout) — apply the screen rail directly
     so content matches the app's rail (WS-1), same as SchoolJoinView. */
  padding: var(--space-8) var(--velo-rail-pad-x) var(--space-5);
  gap: var(--space-4);
}

.master-offer__title {
  font-family: var(--font-body);
  font-size: var(--velo-fs-32);
  color: var(--velo-text-primary);
  text-align: center;
  -webkit-text-stroke: var(--velo-text-stroke-strong) var(--velo-text-primary);
}

.master-offer__subtitle {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-secondary);
  text-align: center;
  max-width: var(--velo-content-width-narrow);
  line-height: 1.5;
  margin: 0;
}

/* The shared invite card owns its internals; the screen owns the width. */
.master-offer__card {
  width: 100%;
  max-width: var(--velo-content-width-narrow);
}

.master-offer__actions {
  width: 100%;
  max-width: var(--velo-content-width-narrow);
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
