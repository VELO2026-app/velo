<!--
  VELO Frontend -- SchoolStudentProfileView (tz-curator.md §1.11.4, owner
  decision 2026-09-22)

  A school student's profile IN THE SCHOOL CONTEXT, reached from the §1.11
  roster. Students have no public profile endpoint -- the roster row IS the
  safe contract (name, avatar), so the hero renders from it directly; what
  the screen adds is the curator's action set that §1.11.4 placed on a row
  action sheet (the owner moved it here when the rows became navigational):

    - «Предложить стать мастером» (POST master-offers): the appointment does
      NOT take effect here -- the roster changes only when the appointee
      accepts, so success mutates nothing locally. 403 master_required is
      already phrased by errorMessages.
    - «Исключить из школы» (remove-preview advisory + confirm + DELETE).

  Both are curator-of-THIS-school only (viewer.relation, §1.12.1's access
  rule) and both live in the header «⋯» menu (VMenu/VMenuItem, the §1.12.3
  component rule). Masters of the school do NOT land here -- their rows
  open the existing public master profile.
-->

<template>
  <div class="ssp">
    <VHeader title="Ученик" show-back @back="goBack">
      <template v-if="isCurator && loaded" #action>
        <VMenu aria-label="Действия с учеником">
          <template #default="{ close }">
            <VMenuItem
              :icon="IconUser"
              ariaLabel="Предложить стать мастером"
              @click="onOfferClick(close)"
            />
            <VMenuItem
              :icon="IconTrash"
              ariaLabel="Исключить из школы"
              danger
              @click="onRemoveClick(close)"
            />
          </template>
        </VMenu>
      </template>
    </VHeader>

    <div class="ssp__content">
      <!-- The school context is gone or not ours (P-08 masking). -->
      <VEmptyState
        v-if="schoolNotFound"
        icon="notfound"
        title="Школа недоступна"
        description="Возможно, она была удалена или вы в ней не состоите."
      >
        <template #action>
          <VButton variant="primary" @click="goBack">К списку учеников</VButton>
        </template>
      </VEmptyState>

      <VEmptyState
        v-else-if="schoolError"
        icon="warning"
        title="Не удалось загрузить школу"
        description="Проверьте соединение и попробуйте ещё раз."
      >
        <template #action>
          <VButton variant="outline" @click="load">Повторить</VButton>
        </template>
      </VEmptyState>

      <div v-else-if="loading" class="ssp__state">
        <VLoader size="lg" />
      </div>

      <template v-else>
        <!-- Hero: the roster row's own safe fields. -->
        <VCard class="ssp__hero" padding="none">
          <VAvatar :name="studentName" :url="studentAvatar" size="xl" />
          <h1 class="ssp__name">{{ studentName }}</h1>
        </VCard>
      </template>
    </div>

    <!-- Исключение: advisory preview, idempotent DELETE (the leave/remove
         contract -- a failed preview is "no advice", never a blocked button). -->
    <VConfirmDialog
      :open="removeOpen"
      :message="removeMessage"
      confirm-label="Исключить"
      danger
      :loading="removing"
      @confirm="onRemoveConfirm"
      @cancel="removeOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  getCuratorGroupPage,
  getCuratorGroupRemovePreview,
  offerCuratorGroupMaster,
  removeCuratorGroupMember,
} from '@/api/curatorGroups'
import { ApiResponseError } from '@/api/client'
import type { CuratorGroupPageResponse } from '@/api/types'
import { IconTrash, IconUser } from '@/components/icons'
import {
  VAvatar,
  VButton,
  VCard,
  VConfirmDialog,
  VEmptyState,
  VLoader,
  VMenu,
  VMenuItem,
} from '@/components/ui'
import VHeader from '@/components/layout/VHeader.vue'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const groupId = computed(() => String(route.params.groupId ?? ''))
const userId = computed(() => String(route.params.userId ?? ''))

const studentName = computed(() => String(route.query.name ?? 'Ученик'))
const studentAvatar = computed(() => String(route.query.avatar ?? ''))

const inMasterZone = computed(() => String(route.name ?? '').startsWith('master'))

const rosterRoute = computed(() => ({
  name: inMasterZone.value ? 'master-curator-group-members' : 'user-curator-group-members',
  params: { id: groupId.value },
  // Back lands on the roster the row came from (the §1.11 switcher tab).
  query: { kind: 'student' },
}))

function goBack(): void {
  void router.push(rosterRoute.value)
}

const loading = ref(true)
const loaded = ref(false)
const schoolNotFound = ref(false)
const schoolError = ref(false)
const school = ref<CuratorGroupPageResponse | null>(null)

const isCurator = computed(() => school.value?.viewer.relation === 'curator')

async function load(): Promise<void> {
  loading.value = true
  schoolNotFound.value = false
  schoolError.value = false
  try {
    school.value = await getCuratorGroupPage(groupId.value)
    loaded.value = true
  } catch (e) {
    if (e instanceof ApiResponseError && e.status === 404) {
      schoolNotFound.value = true
    } else {
      schoolError.value = true
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})

// Router reuse under the same record: reload for the new student.
watch([groupId, userId], () => {
  if (groupId.value && userId.value) void load()
})

// -- «Предложить стать мастером» ----------------------------------------------

const offering = ref(false)

function onOfferClick(close: () => void): void {
  close()
  if (offering.value) return
  offering.value = true
  // Idempotent per candidate; 204 does NOT change the roster -- the member
  // must accept first, so nothing mutates locally (the wrapper's contract).
  void offerCuratorGroupMaster(groupId.value, userId.value)
    .then(() => toast.success('Предложение отправлено'))
    .catch((e: unknown) => toast.error(extractApiError(e, 'Не удалось отправить предложение')))
    .finally(() => {
      offering.value = false
    })
}

// -- «Исключить из школы» -------------------------------------------------------

const removeOpen = ref(false)
const removing = ref(false)
const removeAdvisory = ref<number | null>(null)

const removeMessage = computed(() => {
  const base = `Исключить ученика «${studentName.value}» из школы «${school.value?.name ?? ''}»?`
  const n = removeAdvisory.value
  if (n === null || n === 0) return base
  const word = n === 1 ? 'практика' : n < 5 ? 'практики' : 'практик'
  return `${base} ${n} предстоящ${n === 1 ? 'ая' : 'их'} ${word} этой школы станут скрыты.`
})

function onRemoveClick(close: () => void): void {
  close()
  removeAdvisory.value = null
  removeOpen.value = true
  // Lazy: only fetched when the dialog actually opens.
  void getCuratorGroupRemovePreview(groupId.value, userId.value)
    .then((res) => {
      removeAdvisory.value = res.upcoming_practices_targeting_group
    })
    .catch(() => {
      removeAdvisory.value = null
    })
}

async function onRemoveConfirm(): Promise<void> {
  removing.value = true
  try {
    await removeCuratorGroupMember(groupId.value, userId.value)
    removeOpen.value = false
    toast.success('Ученик исключён из школы')
    void router.replace(rosterRoute.value)
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось исключить ученика'))
  } finally {
    removing.value = false
  }
}
</script>

<style scoped>
.ssp {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.ssp__content {
  flex: 1;
  padding: var(--space-2) 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ssp__state {
  display: flex;
  justify-content: center;
  padding: var(--space-6) 0;
}

/* Hero: the MasterPublicView card recipe, roster-fed. */
.ssp__hero {
  padding: var(--space-5) var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-2);
}

.ssp__name {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  margin: 0;
}
</style>
