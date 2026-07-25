<!--
  VELO Frontend -- MasterPendingView (verdict screens, slice-2 C2)

  Standalone route (no MasterShell, no tab bar). Shown after a master
  application is submitted, or when masterStatusGuard sends a non-verified
  master here. Restyled to the operator Figma — three distinct states keyed on
  the application status:

    1. «Заявка отправлена» (pending) — SVG-6. role='user' just applied (can't
       fetch /masters/me yet) OR role='master' pending. Keeps the polling
       («Обновить статус») + «Вернуться к каталогу».
    2. «Ваша заявка одобрена!» (verified) — SVG-7. Explicit approved screen with
       a single «Войти в кабинет» CTA → master dashboard (which chains into the
       post-approval onboarding carousel). Replaces the old auto-redirect.
    3. «Отказ» (rejected) — SVG-8. Amber, generic reason until rejection_reason
       is exposed (Zod E14); TWO CTAs (FORK-4, restored 2026-07-12): «Написать
       в поддержку» AND «Подать новую заявку» — reapply is backend-supported
       (POST /masters/apply updates the existing rejected profile in place,
       see test_apply_master_reapply_after_rejection) and /master/apply is
       reachable for a rejected role='user' (applyGuard only intercepts
       role='master').

  Illustrations extracted from the design SVGs to public/onboarding/master-verdict-*.svg.
-->

<template>
  <div class="pending-view">
    <div
      class="pending-view__content velo-kbd-scroll"
      :class="{ 'pending-view__content--centered': !masterStore.profileLoading && isPending }"
    >
      <template v-if="masterStore.profileLoading">
        <VLoader size="lg" />
      </template>

      <!-- ================= APPROVED (verified) =================
           White VCard подложка (R1 fix, ПРОМТ №391 — operator-approved preview
           .tmp/batch-r/r1-application-states.html): was rendering directly on
           the transparent fog bg, unlike SENT below which already had it. -->
      <template v-else-if="profileStatus === 'verified'">
        <VCard class="pending-view__card">
          <img
            src="/onboarding/master-verdict-approved.svg"
            alt=""
            class="pending-view__illu pending-view__illu--lg"
          />
          <h2 class="pending-view__title">Ваша заявка одобрена!</h2>
          <p class="pending-view__subtitle">
            Переключитесь в режим мастера, чтобы открыть кабинет. Вернуться в режим
            пользователя можно в любой момент из настроек.
          </p>
          <div class="pending-view__actions">
            <VButton variant="primary" block :loading="switching" @click="enterMasterMode">
              Войти в кабинет
            </VButton>
          </div>
        </VCard>
      </template>

      <!-- ================= REJECTED ================= (R1 fix, same as above) -->
      <template v-else-if="profileStatus === 'rejected'">
        <VCard class="pending-view__card">
          <img
            src="/onboarding/master-verdict-reject.svg"
            alt=""
            class="pending-view__illu pending-view__illu--lg"
          />
          <h2 class="pending-view__title">Спасибо за заявку!</h2>
          <p class="pending-view__subtitle">К сожалению, мы пока не можем одобрить вашу заявку.</p>

          <div class="pending-view__reason">
            <div class="pending-view__reason-label">Причина:</div>
            <div class="pending-view__reason-text">{{ rejectionReason }}</div>
          </div>

          <div class="pending-view__actions">
            <VButton variant="primary" block @click="router.push({ name: 'master-support' })">
              Написать в поддержку
            </VButton>
            <VButton variant="outline" block @click="router.push({ name: 'master-apply' })">
              Подать новую заявку
            </VButton>
          </div>
        </VCard>
      </template>

      <!-- ================= SENT (pending) =================
           White VCard подложка, vertically centered (K2). A discreet text
           link (F4, not a block button -- ПРОМТ №418: this screen exists so
           a person waits calmly; a full-width button would read as an
           invitation to leave). -->
      <template v-else>
        <VCard class="pending-view__card">
          <img src="/onboarding/master-verdict-sent.svg" alt="" class="pending-view__illu" />
          <h2 class="pending-view__title">Заявка отправлена!</h2>
          <p class="pending-view__subtitle">Рассмотрим за 24–48 часов, сообщим в push и на email</p>
          <button type="button" class="pending-view__withdraw-link" @click="confirmWithdrawOpen = true">
            Отозвать заявку
          </button>
        </VCard>
      </template>
    </div>

    <VConfirmDialog
      :open="confirmWithdrawOpen"
      message="Отозвать заявку? Вы вернётесь к обычному аккаунту пользователя. Подать новую заявку можно в любой момент."
      confirm-label="Отозвать"
      danger
      :loading="withdrawing"
      @confirm="onWithdraw"
      @cancel="confirmWithdrawOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VButton, VLoader, VCard, VConfirmDialog } from '@/components/ui'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { useMasterStore } from '@/stores/master'
import { withdrawMasterApplication } from '@/api/masters'
import { extractApiError } from '@/composables/useApiError'
import { MASTER_APPLIED_KEY, masterApprovedSeenKey, masterRejectionSeenKey } from '@/utils/constants'

const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()
const masterStore = useMasterStore()

const switching = ref(false)

// -- Derived application status --
// T4: approval no longer flips role — an approved applicant stays role='user'
// and gains master CAPABILITY (a verified MasterProfile), surfaced as 'master'
// in authStore.allowedRoles (GET /users/me role_switch). So:
//   role='master'                    -> the loaded profile status.
//   role='user' + capability(master) -> approved ('verified').
//   role='user' + cancelled_by_user  -> withdrawn (F4: onMounted bounces this
//                                       to /user/dashboard, same destination
//                                       masterPendingGuard's "neither" case
//                                       already sends a never-applied user to
//                                       -- no dedicated card, see onMounted).
//   otherwise                        -> 'pending'.
// (A rejected applicant is role='user' with no capability -> shows 'pending'
//  here; surfacing the rejection to a role='user' account is deferred to T5.)
const profileStatus = computed(() => {
  if (authStore.role === 'master') return masterStore.profile?.status ?? 'pending'
  if (authStore.allowedRoles.includes('master')) return 'verified'
  // T5: a rejected applicant stays role='user' with no capability; the verdict
  // is surfaced on GET /users/me (master_application) so the reject screen is
  // reachable without the master-only /masters/me endpoint.
  if (authStore.masterApplication?.status === 'rejected') return 'rejected'
  if (authStore.masterApplication?.status === 'cancelled_by_user') return 'withdrawn'
  return 'pending'
})

// Pending is the only state that centers on a bare card (K2); approved/rejected
// keep their card + CTA layout.
const isPending = computed(() => profileStatus.value === 'pending')

// Real rejection reason from the profile (E14: surfaced on MasterProfileResponse
// from data.account.rejection_reason). Falls back to a generic line when the
// admin left no reason (or on the preview path).
const rejectionReason = computed((): string => {
  if (profileStatus.value !== 'rejected') return ''
  return (
    masterStore.profile?.rejection_reason ??
    authStore.masterApplication?.rejection_reason ??
    'Заявка не прошла верификацию. Свяжитесь с поддержкой для повторной заявки.'
  )
})

// On mount: refresh the account so the status-keyed state renders. For a
// role='master' account load the profile; for role='user' re-fetch /users/me so
// a just-granted master capability (approval) is reflected in allowedRoles.
onMounted(async () => {
  if (authStore.role === 'master') {
    await masterStore.fetchMyProfile(true)
  } else {
    await authStore.fetchMe()
  }
  // Bug 1 fix (ПРОМТ №405): mark the per-user key once the rejection screen
  // has actually rendered, mirroring masterApprovedSeenKey's placement for
  // the approved case, so roleRedirect stops routing here on future opens
  // (operator decision: show the verdict once, then treat as an ordinary user).
  if (profileStatus.value === 'rejected' && authStore.user?.id) {
    localStorage.setItem(masterRejectionSeenKey(authStore.user.id), '1')
  }
  // F4: a withdrawn application has nothing left to show here -- bounce to
  // the ordinary user dashboard, same destination masterPendingGuard already
  // sends a never-applied user to. Covers a stale/second tab that lands on
  // this route after the withdraw button (below) already navigated away.
  if (profileStatus.value === 'withdrawn') {
    router.replace({ name: 'user-dashboard' })
  }
})

// -- Enter master mode -- (T4: approved applicant self-switches role user->master)
async function enterMasterMode(): Promise<void> {
  if (switching.value) return
  switching.value = true
  try {
    await authStore.switchRole('master')
    // MA3: mark this celebratory screen as seen (persists across sessions) so
    // future self-switches (RoleSwitchSection) go straight to the dashboard
    // instead of detouring back through here.
    if (authStore.user?.id) {
      localStorage.setItem(masterApprovedSeenKey(authStore.user.id), '1')
    }
    router.push({ name: 'master-dashboard' })
  } catch {
    toast.error('Не удалось переключиться в режим мастера')
  } finally {
    switching.value = false
  }
}

// -- Withdraw application -- (F4: candidate pulls back their own pending
// application; status flip only, the account stays an ordinary user)
const confirmWithdrawOpen = ref(false)
const withdrawing = ref(false)

async function onWithdraw(): Promise<void> {
  if (withdrawing.value) return
  withdrawing.value = true
  try {
    await withdrawMasterApplication()
    // Drop the applicant marker so a future load of this route (or the
    // guard) doesn't mistake a stale session for a still-pending applicant.
    sessionStorage.removeItem(MASTER_APPLIED_KEY)
    toast.success('Заявка отозвана')
    router.replace({ name: 'user-dashboard' })
  } catch (e) {
    // 409 means someone else (e.g. an admin) already acted on it between
    // opening this dialog and confirming -- a generic message covers both
    // that race and any other failure without guessing which happened.
    toast.error(extractApiError(e, 'Не удалось отозвать заявку'))
  } finally {
    withdrawing.value = false
    confirmWithdrawOpen.value = false
  }
}

</script>

<style scoped>
.pending-view {
  /* Fill AppFrame's stable height — never dvh/vh (collapse on keyboard). Canon §2. */
  min-height: 100%;
  background: transparent;
  display: flex;
  flex-direction: column;
}

.pending-view__content {
  flex: 1;
  /* ROOT-LOCK: own the scroll (html/body/#app no longer absorb overflow). */
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* Standalone route (outside MobileLayout) — apply the screen rail directly
     so content matches the app's 24px rail (WS-1, 2026-06-19). */
  padding: var(--space-8) var(--velo-rail-pad-x) var(--space-5);
  gap: var(--space-4);
}

/* Pending (K2d): vertically center the card, drop the top-heavy padding. */
.pending-view__content--centered {
  justify-content: center;
  padding-top: var(--space-5);
}

/* Pending card подложка (K2b): icon + title + subtext on a white plate. */
.pending-view__card {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-8) var(--space-5);
}

/* -- Verdict illustration (extracted from the design SVGs) -- */
.pending-view__illu {
  width: 96px;
  height: 96px;
  object-fit: contain;
  flex-shrink: 0;
}

.pending-view__illu--lg {
  width: 160px;
  height: 160px;
}

.pending-view__title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  color: var(--velo-text-primary);
  text-align: center;
  -webkit-text-stroke: var(--velo-text-stroke-strong) var(--velo-text-primary);
}

.pending-view__subtitle {
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  text-align: center;
  max-width: 300px;
  line-height: 1.5;
  margin: 0;
}

/* -- Withdraw link (F4): deliberately quiet -- text button, not a CTA. -- */
.pending-view__withdraw-link {
  background: none;
  border: none;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-muted);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
  padding: var(--space-2);
  margin-top: var(--space-2);
}

/* -- Rejection reason (amber) -- */
.pending-view__reason {
  width: 100%;
  background: var(--velo-warning-bg);
  border: var(--velo-banner-border-width) solid var(--velo-warning-border);
  border-radius: var(--velo-radius-9);
  padding: var(--space-3) var(--space-4);
}

.pending-view__reason-label {
  font-size: var(--text-xs);
  color: var(--velo-warning-text);
  letter-spacing: 0.02em;
}

.pending-view__reason-text {
  font-size: var(--text-base);
  color: var(--velo-warning-text);
  line-height: 1.4;
  margin-top: var(--space-1);
}

/* -- Actions -- */
.pending-view__actions {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
