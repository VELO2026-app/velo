<!--
=============================================================================
VELO Frontend — Group invite join (Master GROUPS P4, ПРОМТ №593)
=============================================================================

Landing for the group_invite__<token> deeplink (route /groups/join/:token,
standalone — outside the shells, like /master/invite/:token). Unlike that
one-time claim, this token is REUSABLE (groups_service.get_or_create_group_invite):
many different people open the SAME link over time, each one joining the
group as themselves.

No SVG mock exists for this screen (P4 task note) -- MINIMAL DS-language
design, mirroring MasterInviteClaimView's own state machine exactly:
  SUCCESS -> toast + straight back to the role dashboard (roleRedirect
             already knows where that is; no new "you're in" screen).
  403 (blocked by that group's master) -> honest error state, no retry.
  404 (invite_invalid / unknown token) -> honest error state, no retry.
  anything else (network blip, timeout) -> transient error, offer a retry
    (same W11 discipline as MasterInviteClaimView: a connection hiccup is
    not the same as "this link doesn't work").
=============================================================================
-->

<template>
  <div class="group-join">
    <div class="group-join__content velo-kbd-scroll">
      <!-- Joining -->
      <template v-if="joining">
        <VLoader size="lg" />
        <p class="group-join__subtitle">Проверяем приглашение…</p>
      </template>

      <!-- Transient (network/timeout) -- offer a retry, not a dead-link verdict. -->
      <template v-else-if="transientError">
        <h2 class="group-join__title">Не удалось проверить приглашение</h2>
        <p class="group-join__subtitle">
          Проблема с соединением. Проверьте интернет и попробуйте ещё раз.
        </p>
        <div class="group-join__actions">
          <VButton variant="primary" block :loading="joining" @click="join"> Повторить </VButton>
        </div>
      </template>

      <!-- Honest failure: blocked by the group's master, or an invalid/unknown token. -->
      <template v-else-if="errorTitle">
        <h2 class="group-join__title">{{ errorTitle }}</h2>
        <p class="group-join__subtitle">{{ errorDescription }}</p>
        <div class="group-join__actions">
          <VButton variant="primary" block @click="router.replace({ name: 'root' })">
            На главную
          </VButton>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { joinGroup } from '@/api/groups'
import { ApiResponseError } from '@/api/client'
import { useToast } from '@/composables/useToast'
import VButton from '@/components/ui/VButton.vue'
import VLoader from '@/components/ui/VLoader.vue'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const joining = ref(true)
const transientError = ref(false)
const errorTitle = ref('')
const errorDescription = ref('')

async function join(): Promise<void> {
  joining.value = true
  transientError.value = false
  errorTitle.value = ''
  const token = String(route.params.token ?? '')
  try {
    const res = await joinGroup(token)
    toast.success(`Вы добавлены в группу "${res.group_name}"`)
    void router.replace({ name: 'root' })
  } catch (e) {
    if (e instanceof ApiResponseError && e.status === 403) {
      errorTitle.value = 'Мастер ограничил вам доступ'
      errorDescription.value = 'Вы не сможете присоединиться к этой группе.'
    } else if (e instanceof ApiResponseError && e.status === 404) {
      errorTitle.value = 'Ссылка недействительна'
      errorDescription.value = 'Возможно, ссылка повреждена или устарела.'
    } else {
      transientError.value = true
    }
  } finally {
    joining.value = false
  }
}

onMounted(join)
</script>

<style scoped>
.group-join {
  /* Fill AppFrame's stable height — never dvh/vh (collapse on keyboard). Canon §2. */
  min-height: 100%;
  background: transparent;
  display: flex;
  flex-direction: column;
}

.group-join__content {
  flex: 1;
  /* ROOT-LOCK: own the scroll (html/body/#app no longer absorb overflow). */
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Standalone route (outside MobileLayout) — apply the screen rail directly
     so content matches the app's 24px rail (WS-1). */
  padding: var(--space-8) var(--velo-rail-pad-x) var(--space-5);
  gap: var(--space-4);
}

.group-join__title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  color: var(--velo-text-primary);
  text-align: center;
  -webkit-text-stroke: var(--velo-text-stroke-strong) var(--velo-text-primary);
}

.group-join__subtitle {
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  text-align: center;
  max-width: 300px;
  line-height: 1.5;
  margin: 0;
}

.group-join__actions {
  width: 100%;
  max-width: 300px;
  margin-top: var(--space-4);
}
</style>
