<!--
=============================================================================
VELO Frontend — SchoolJoinView (schools FE-18 / GT P3)
=============================================================================

Landing for the school__<token> deeplink (route
/schools/join/:token, standalone — exactly like group-join). Unlike
that screen's fire-and-forget POST, this one is a TWO-STEP flow: the preview
(GET /schools/invites/{token}) DESCRIBES the offer, and only the join CTA
(i18n:masterScreens.schoolJoin.joinCta)
commits (POST /join). The preview is a hint and the join is the gate — between
the two the world can change (token revoked, curator frozen), so join errors
are handled as REAL states here, never as "impossible".

State machine (each renders honestly, none fakes data):
  loading            -> spinner
  transient          -> retry (i18n:common.retry; W11: a connection hiccup is
                        not a verdict)
  404                -> the invalid-invite title
                        (i18n:masterScreens.schoolJoin.invalid.title; one
                        answer for unknown /
                        revoked / frozen / deleted — the backend refuses to
                        distinguish, P-08)
  can_join=false     -> per-reason refusal; own_school / already_member add an
                        open button (i18n:masterScreens.schoolJoin.open) into
                        the school page
  can_join=true      -> school card + join (i18n:masterScreens.schoolJoin.joinCta)
                        / decline (i18n:masterScreens.schoolJoin.decline)
  joined (new user)  -> post-join onboarding overlay (FE-83): an account whose
                        onboarding flag is still false meets the carousel
                        AFTER the join; finishing or skipping it opens the
                        joined school (FE-84)

GT-27: there used to be an upgrade nuance here — a STUDENT opening a MASTER
link got can_join=true with relation="student", because joining would promote
them, so the button stayed active and a hint explained it. One link now, and
it only ever makes students: a member always gets can_join=false,
reason=already_member. School masters are appointed by the curator with the
appointee's confirmation, on a screen of its own. The decline CTA
(i18n:masterScreens.schoolJoin.decline) is a pure
router.replace — no server state, the link keeps working.

FE-81: for an account's FIRST session this screen is the app's entry — the
App.vue gate defers the new-user Welcome/onboarding for a school__ deep link,
so the order is invitation -> join -> onboarding (skippable) -> school.
-->

<template>
  <div class="cg-join">
    <div class="cg-join__content velo-kbd-scroll">
      <!-- Preview in flight -->
      <template v-if="loading">
        <VLoader size="lg" />
        <p class="cg-join__subtitle">
          {{ t('common.inviteChecking') }}
        </p>
      </template>

      <!-- Transient (network/timeout): offer a retry, not a dead-link verdict. -->
      <template v-else-if="transientError">
        <h2 class="cg-join__title">
          {{ t('common.inviteCheckFailed') }}
        </h2>
        <p class="cg-join__subtitle">
          {{ t('common.connProblem') }}
        </p>
        <div class="cg-join__actions">
          <VButton variant="primary" block :loading="loading" @click="loadPreview">
            {{ t('common.retry') }}
          </VButton>
        </div>
      </template>

      <!-- Honest refusal: invalid link, or a described can_join=false reason.
           FE-97: the design-system refusal screen (VEmptyState), not bare
           text -- the same honest-failure plate the rest of the app uses. -->
      <template v-else-if="blocked">
        <VEmptyState :icon="blocked.icon" :title="blocked.title" :description="blocked.description">
          <!-- The blocked-in-school refusal carries the lock face (DSGN-16
               vocabulary); the semantic keys cover the rest. -->
          <template v-if="blocked.icon === 'lock'" #icon>
            <IconLock :size="48" />
          </template>
          <template #action>
            <VButton v-if="blocked.open" variant="primary" block @click="openSchool">
              {{ t('masterScreens.schoolJoin.open') }}
            </VButton>
            <VButton v-else variant="primary" block @click="router.replace({ name: 'root' })">
              {{ t('common.backHome') }}
            </VButton>
          </template>
        </VEmptyState>
      </template>

      <!-- The school card behind the link: the shared invite card (owner
           mockups 2026-10-02 -- logo, name, counters, description, heading;
           no analytics lines, counts only). -->
      <template v-else-if="preview">
        <SchoolInviteCard
          class="cg-join__card"
          :name="preview.school.name"
          :avatar-url="preview.school.avatar_url"
          :students-count="preview.school.students_count"
          :masters-count="preview.school.masters_count"
          :description="preview.school.description"
          :curator-name="preview.school.curator_name"
          :heading="t('masterScreens.schoolJoin.invited.title')"
        />
        <div class="cg-join__actions">
          <VButton variant="primary" block :loading="joining" @click="join">{{
            t('masterScreens.schoolJoin.joinCta')
          }}</VButton>
          <VButton variant="outline" block :disabled="joining" @click="decline">
            {{ t('masterScreens.schoolJoin.decline') }}
          </VButton>
        </div>
      </template>
    </div>
  </div>

  <!-- FE-83/FE-84: the post-join onboarding carousel, full-screen above the
       invitation screen. Teleported to body exactly like the master
       dashboard's carousel: position:absolute against body's frozen box (see
       that overlay's note), and the AppFrame safe-area offset does not cover
       a body-level box, so the top inset is applied here. -->
  <Teleport to="body">
    <div
      v-if="joinedSchoolId"
      class="cg-join__onboarding"
      :style="{ paddingTop: contentSafeTopCss }"
    >
      <OnboardingView @done="finishOnboarding" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getSchoolInvitePreview, joinSchool } from '@/api/schools'
import { ApiResponseError } from '@/api/client'
import type { SchoolInvitePreviewResponse } from '@/api/types'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { useSafeArea } from '@/composables/useSafeArea'
import { useAuthStore } from '@/stores/auth'
import { useQueryCache } from '@pinia/colada'
import { invalidateAfter } from '@/composables/queries/invalidation'
import { ensureSchoolsHub } from '@/composables/queries/schools'
import { IconLock } from '@/components/icons'
import { VButton, VEmptyState, VLoader } from '@/components/ui'
import SchoolInviteCard from '@/components/shared/SchoolInviteCard.vue'
import OnboardingView from '@/views/auth/OnboardingView.vue'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()
const queryCache = useQueryCache()

const loading = ref(true)
const transientError = ref(false)
const notFound = ref(false)
const preview = ref<SchoolInvitePreviewResponse | null>(null)
const joining = ref(false)

const { contentSafeTopCss } = useSafeArea()

/**
 * FE-83: the school the account just joined while its onboarding flag is
 * still false. Non-null shows the carousel overlay instead of navigating;
 * FE-84 consumes it when the carousel emits done (finish OR skip -- the flag
 * is already persisted by then). Kept local on purpose: the overlay, the
 * target and the navigation live in this one component instance.
 */
const joinedSchoolId = ref<string | null>(null)

interface RefusalView {
  title: string
  description: string
  /** own_school / already_member offer a jump straight into the school page. */
  open: boolean
  /** VEmptyState semantic glyph: notfound (dead link), group (already in),
   *  lock (the blocked refusals, FE-97). */
  icon: 'notfound' | 'group' | 'lock'
}

/** The not-found and can_join=false states share one honest-failure layout. */
const blocked = computed<RefusalView | null>(() => {
  if (notFound.value) {
    return {
      title: t('masterScreens.schoolJoin.invalid.title'),
      description: t('masterScreens.schoolJoin.invalid.text'),
      open: false,
      icon: 'notfound',
    }
  }
  const p = preview.value
  if (!p || p.can_join) return null
  switch (p.reason) {
    case 'own_school':
      return {
        title: t('masterScreens.schoolJoin.alreadyOwner.title'),
        description: t('masterScreens.schoolJoin.alreadyOwner.text'),
        open: true,
        icon: 'group',
      }
    case 'already_member':
      return {
        title: t('masterScreens.schoolJoin.alreadyMember.title'),
        description: t('masterScreens.schoolJoin.alreadyMember.text'),
        open: true,
        icon: 'group',
      }
    case 'blocked_by_curator':
      return {
        title: t('masterScreens.schoolJoin.unavailable'),
        description: t('masterScreens.schoolJoin.restricted.text'),
        open: false,
        icon: 'lock',
      }
    // BE-79 (FE-97 final wording): blocked by the curator IN this school --
    // the preview says so, and a join refused 403 re-reads the preview
    // (below).
    case 'blocked_in_school':
      return {
        title: t('masterScreens.schoolJoin.unavailable'),
        description: t('masterScreens.schoolJoin.blocked.title'),
        open: false,
        icon: 'lock',
      }
    default:
      // can_join=false with no reason is not a contract shape; stay honest
      // rather than guessing — same title as blocked, no invented details.
      return {
        title: t('masterScreens.schoolJoin.unavailable'),
        description: '',
        open: false,
        icon: 'lock',
      }
  }
})

/** The school page lives in the viewer's own zone: masters get the master
 *  route, everyone else (user, admin) the user one. Route names resolve in
 *  FE-19/FE-20; the deep link itself only ever needs them AFTER a join. */
function schoolRoute(id: string): { name: string; params: { id: string } } {
  return authStore.role === 'master'
    ? { name: 'master-school', params: { id } }
    : { name: 'user-school', params: { id } }
}

async function loadPreview(): Promise<void> {
  loading.value = true
  transientError.value = false
  notFound.value = false
  try {
    preview.value = await getSchoolInvitePreview(String(route.params.token ?? ''))
  } catch (e) {
    if (e instanceof ApiResponseError && e.status === 404) {
      notFound.value = true
    } else {
      transientError.value = true
    }
  } finally {
    loading.value = false
  }
}

async function join(): Promise<void> {
  if (!preview.value) return
  joining.value = true
  try {
    const res = await joinSchool(String(route.params.token ?? ''))
    toast.success(t('masterScreens.schoolJoin.joinedToast', { name: preview.value.school.name }))
    // The hub may have answered BEFORE this join (the account's first
    // school): without a fresh read the dock tab stays hidden until a full
    // reload (FE-88). This route sits outside the shells, so nothing holds
    // the hub now -- the invalidation only marks it stale, and the read
    // happens HERE, before the navigation lands in a shell that shows the
    // tab at once. Neither rejects: the navigation never fails with a failed
    // read.
    await invalidateAfter(queryCache, 'joinSchool')
    await ensureSchoolsHub(queryCache)
    // FE-83: a first-session user meets the onboarding carousel AFTER the
    // join, not before the invitation -- the gate let them straight in. The
    // joined school is remembered locally; the overlay consumes it on done.
    if (!authStore.user?.onboarding_completed) {
      joinedSchoolId.value = res.school_id
      return
    }
    void router.replace(schoolRoute(res.school_id))
  } catch (e) {
    if (e instanceof ApiResponseError) {
      if (e.status === 404) {
        // The link died between preview and join — the gate re-validated.
        preview.value = null
        notFound.value = true
        return
      }
      if (e.status === 403 || e.status === 409) {
        // Refused at the gate (blocked / own_school):
        // re-read the preview, which DESCRIBES the reason instead of us
        // guessing from the status code.
        await loadPreview()
        return
      }
    }
    toast.error(extractApiError(e, t('masterScreens.schoolJoin.toast.joinFailed')))
  } finally {
    joining.value = false
  }
}

/** Refusal creates NO server state — the link keeps working for others. */
function decline(): void {
  void router.replace({ name: 'root' })
}

function openSchool(): void {
  const id = preview.value?.school.id
  if (id) void router.replace(schoolRoute(id))
}

/** FE-84: the done (i18n:auth.onboarding.done) and skip (i18n:common.skip)
 *  buttons both emit done (the carousel persists the
 *  flag either way) -- the main screen of the school just joined opens. */
function finishOnboarding(): void {
  const id = joinedSchoolId.value
  joinedSchoolId.value = null
  if (id) void router.replace(schoolRoute(id))
}

onMounted(loadPreview)
</script>

<style scoped>
.cg-join {
  /* Fill AppFrame's stable height — never dvh/vh (collapse on keyboard). Canon §2. */
  min-height: 100%;
  background: transparent;
  display: flex;
  flex-direction: column;
}

.cg-join__content {
  flex: 1;
  /* ROOT-LOCK: own the scroll (html/body/#app no longer absorb overflow). */
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Standalone route (outside MobileLayout) — apply the screen rail directly
     so content matches the app's rail (WS-1), same as GroupJoinView. */
  padding: var(--space-8) var(--velo-rail-pad-x) var(--space-5);
  gap: var(--space-4);
}

.cg-join__title {
  font-family: var(--font-body);
  font-size: var(--velo-fs-32);
  color: var(--velo-text-primary);
  text-align: center;
  -webkit-text-stroke: var(--velo-text-stroke-strong) var(--velo-text-primary);
}

.cg-join__subtitle {
  font-size: var(--velo-fs-18);
  color: var(--velo-text-secondary);
  text-align: center;
  max-width: var(--velo-content-width-narrow);
  line-height: 1.5;
  margin: 0;
}

/* The shared invite card owns its internals; the screen owns the width. */
.cg-join__card {
  width: 100%;
  max-width: var(--velo-content-width-narrow);
}

.cg-join__hint {
  font-size: var(--velo-fs-16);
  color: var(--velo-text-secondary);
  line-height: 1.5;
  margin: 0;
  padding-top: var(--space-2);
  border-top: 1px solid var(--velo-border-card);
}

.cg-join__actions {
  width: 100%;
  max-width: var(--velo-content-width-narrow);
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* The post-join onboarding overlay -- same recipe as the master dashboard's
   carousel overlay (MasterDashboardView): body-level absolute box (body is
   position:relative with a frozen height, ROOT-LOCK), its own opaque paint of
   the photo background (it must sit ABOVE #app to obscure the invitation, so
   #app-bg behind #app cannot show through), and below the toast layer. */
.cg-join__onboarding {
  position: absolute;
  inset: 0;
  z-index: var(--z-popup);
  background: var(--velo-app-bg-image) center / cover no-repeat;
  box-sizing: border-box;
}
</style>
