<!--
=============================================================================
VELO Frontend — CuratorGroupJoinView (schools FE-18 / GT P3)
=============================================================================

Landing for the curator_group_invite__<token> deeplink (route
/curator-groups/join/:token, standalone — exactly like group-join). Unlike
that screen's fire-and-forget POST, this one is a TWO-STEP flow: the preview
(GET /curator-groups/invites/{token}) DESCRIBES the offer, and only «Вступить»
commits (POST /join). The preview is a hint and the join is the gate — between
the two the world can change (token revoked, curator frozen), so join errors
are handled as REAL states here, never as "impossible".

State machine (each renders honestly, none fakes data):
  loading            -> spinner
  transient          -> «Повторить» (W11: a connection hiccup is not a verdict)
  404                -> «Приглашение недействительно» (one answer for unknown /
                        revoked / frozen / deleted — the backend refuses to
                        distinguish, P-08)
  can_join=false     -> per-reason refusal; own_group / already_member add an
                        «Открыть» button into the school page
  can_join=true      -> school card + «Вступить» / «Отказаться»

The upgrade nuance (brif §7): a STUDENT member opening a MASTER link gets
can_join=true with relation="student" — they are already inside and the link
still does something (kind upgrade). The button stays active and a hint
explains what will happen. «Отказаться» is a pure router.replace — no server
state, the link keeps working.
-->

<template>
  <div class="cg-join">
    <div class="cg-join__content velo-kbd-scroll">
      <!-- Preview in flight -->
      <template v-if="loading">
        <VLoader size="lg" />
        <p class="cg-join__subtitle">Проверяем приглашение…</p>
      </template>

      <!-- Transient (network/timeout): offer a retry, not a dead-link verdict. -->
      <template v-else-if="transientError">
        <h2 class="cg-join__title">Не удалось проверить приглашение</h2>
        <p class="cg-join__subtitle">
          Проблема с соединением. Проверьте интернет и попробуйте ещё раз.
        </p>
        <div class="cg-join__actions">
          <VButton variant="primary" block :loading="loading" @click="loadPreview">
            Повторить
          </VButton>
        </div>
      </template>

      <!-- Honest refusal: invalid link, or a described can_join=false reason. -->
      <template v-else-if="blocked">
        <h2 class="cg-join__title">{{ blocked.title }}</h2>
        <p v-if="blocked.description" class="cg-join__subtitle">{{ blocked.description }}</p>
        <div class="cg-join__actions">
          <VButton v-if="blocked.open" variant="primary" block @click="openSchool">
            Открыть
          </VButton>
          <VButton v-else variant="primary" block @click="router.replace({ name: 'root' })">
            На главную
          </VButton>
        </div>
      </template>

      <!-- The school card behind the link. -->
      <template v-else-if="preview">
        <VCard class="cg-join__card">
          <p class="cg-join__kind">
            {{
              preview.kind === 'master'
                ? 'Приглашение в школу как мастер'
                : 'Приглашение в школу как ученик'
            }}
          </p>
          <h1 class="cg-join__name">{{ preview.group.name }}</h1>
          <p v-if="curatorName" class="cg-join__curator">Куратор: {{ curatorName }}</p>
          <p v-if="preview.group.description" class="cg-join__description">
            {{ preview.group.description }}
          </p>
          <p class="cg-join__counts">
            Мастеров: {{ preview.group.masters_count }} · Учеников:
            {{ preview.group.students_count }}
          </p>
          <p v-if="upgradeHint" class="cg-join__hint">{{ upgradeHint }}</p>
        </VCard>
        <div class="cg-join__actions">
          <VButton variant="primary" block :loading="joining" @click="join">Вступить</VButton>
          <VButton variant="outline" block :disabled="joining" @click="decline">
            Отказаться
          </VButton>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getCuratorGroupInvitePreview, joinCuratorGroup } from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { CuratorGroupInvitePreviewResponse } from '@/api/types'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import VButton from '@/components/ui/VButton.vue'
import VCard from '@/components/ui/VCard.vue'
import VLoader from '@/components/ui/VLoader.vue'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const loading = ref(true)
const transientError = ref(false)
const notFound = ref(false)
const preview = ref<CuratorGroupInvitePreviewResponse | null>(null)
const joining = ref(false)

const curatorName = computed(() => preview.value?.group.curator_name?.trim() || null)

/** The student-opens-master-link upgrade (can_join=true + relation="student"):
 *  meaningful action, not "already a member" — explain it, keep the button. */
const upgradeHint = computed(() => {
  const p = preview.value
  if (!p || !p.can_join) return ''
  if (p.kind === 'master' && p.relation === 'student') {
    return 'Вы уже ученик этой школы — вступление повысит вас до мастера школы.'
  }
  return ''
})

interface RefusalView {
  title: string
  description: string
  /** own_group / already_member offer a jump straight into the school page. */
  open: boolean
}

/** The not-found and can_join=false states share one honest-failure layout. */
const blocked = computed<RefusalView | null>(() => {
  if (notFound.value) {
    return {
      title: 'Приглашение недействительно',
      description: 'Возможно, ссылка повреждена, устарела или была отозвана.',
      open: false,
    }
  }
  const p = preview.value
  if (!p || p.can_join) return null
  switch (p.reason) {
    case 'own_group':
      return { title: 'Это ваша школа', description: 'Вы куратор этой школы.', open: true }
    case 'already_member':
      return { title: 'Вы уже в школе', description: 'Вы уже состоите в этой школе.', open: true }
    case 'master_required':
      return {
        title: 'Ссылка для верифицированных мастеров',
        description: 'Вступить по этой ссылке могут только мастера с подтверждённым профилем.',
        open: false,
      }
    case 'blocked_by_curator':
      return {
        title: 'Вступление недоступно',
        description: 'Куратор ограничил вам доступ в эту школу.',
        open: false,
      }
    default:
      // can_join=false with no reason is not a contract shape; stay honest
      // rather than guessing — same title as blocked, no invented details.
      return { title: 'Вступление недоступно', description: '', open: false }
  }
})

/** The school page lives in the viewer's own zone: masters get the master
 *  route, everyone else (user, admin) the user one. Route names resolve in
 *  FE-19/FE-20; the deep link itself only ever needs them AFTER a join. */
function schoolRoute(id: string): { name: string; params: { id: string } } {
  return authStore.role === 'master'
    ? { name: 'master-curator-group', params: { id } }
    : { name: 'user-curator-group', params: { id } }
}

async function loadPreview(): Promise<void> {
  loading.value = true
  transientError.value = false
  notFound.value = false
  try {
    preview.value = await getCuratorGroupInvitePreview(String(route.params.token ?? ''))
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
    const res = await joinCuratorGroup(String(route.params.token ?? ''))
    toast.success(`Вы вступили в школу «${preview.value.group.name}»`)
    void router.replace(schoolRoute(res.group_id))
  } catch (e) {
    if (e instanceof ApiResponseError) {
      if (e.status === 404) {
        // The link died between preview and join — the gate re-validated.
        preview.value = null
        notFound.value = true
        return
      }
      if (e.status === 403 || e.status === 409) {
        // Refused at the gate (master_required / blocked / own_group):
        // re-read the preview, which DESCRIBES the reason instead of us
        // guessing from the status code.
        await loadPreview()
        return
      }
    }
    toast.error(extractApiError(e, 'Не удалось вступить в школу. Попробуйте ещё раз.'))
  } finally {
    joining.value = false
  }
}

/** Refusal creates NO server state — the link keeps working for others. */
function decline(): void {
  void router.replace({ name: 'root' })
}

function openSchool(): void {
  const id = preview.value?.group.id
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
  font-size: var(--text-xl);
  color: var(--velo-text-primary);
  text-align: center;
  -webkit-text-stroke: var(--velo-text-stroke-strong) var(--velo-text-primary);
}

.cg-join__subtitle {
  font-size: var(--text-base);
  color: var(--velo-text-secondary);
  text-align: center;
  max-width: var(--velo-content-width-narrow);
  line-height: 1.5;
  margin: 0;
}

.cg-join__card {
  width: 100%;
  max-width: var(--velo-content-width-narrow);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.cg-join__kind {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  margin: 0;
}

.cg-join__name {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  color: var(--velo-text-primary);
  margin: 0;
}

.cg-join__curator,
.cg-join__counts {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  margin: 0;
}

.cg-join__description {
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  line-height: 1.5;
  margin: 0;
}

.cg-join__hint {
  font-size: var(--text-sm);
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
</style>
