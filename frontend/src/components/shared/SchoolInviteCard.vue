<!--
  VELO Frontend -- SchoolInviteCard (invite screens, owner mockups 2026-10-02)

  The school card of the INVITATION screens («Вас пригласили в школу!» /
  «Приглашение стать мастером школы!»): the mockup's anatomy -- the SQUARE
  school logo, the name, ONE counters line («N учеников · N мастеров»), the
  school's own description and the bold invitation heading at the card's
  bottom. NO banner strip (that is the page hero's, SchoolHeroCard) and NO
  analytics lines: by owner ruling (2026-10-02) an invitation card carries
  the participant and master COUNTS only -- nothing personal, nothing
  weekly.

  Everything is the existing canon, restated once: the logo priority and
  the counters idiom are SchoolHeroCard's (avatar_url wins → the flat
  SchoolMandalaBadge → VAvatar initials), the branding hash is derived
  from the name exactly like CuratorGroupRow when the caller has no hash
  yet (§5.2 variant A). The screens around it keep the standalone-invite
  skeleton of CuratorGroupJoinView.
-->

<template>
  <VCard class="school-invite">
    <div class="school-invite__logo-frame">
      <VAvatar
        v-if="avatarUrl"
        square
        size="xl"
        :name="name"
        :url="avatarUrl"
        class="school-invite__logo"
      />
      <SchoolMandalaBadge
        v-else-if="resolvedHash"
        class="school-invite__logo"
        :hash="resolvedHash"
        :size="80"
        :flat="true"
        :mandala-scale="1"
      />
      <VAvatar v-else square size="xl" :name="name" class="school-invite__logo" />
    </div>

    <h2 class="school-invite__name">{{ name }}</h2>

    <p v-if="curatorName" class="school-invite__curator">Куратор: {{ curatorName }}</p>

    <div class="school-invite__stats">
      <span><IconUsers :size="18" />{{ studentsLabel }}</span>
      <span><IconMeditation :size="18" />{{ mastersLabel }}</span>
    </div>

    <p v-if="description?.trim()" class="school-invite__description">
      {{ description }}
    </p>

    <p class="school-invite__heading">{{ heading }}</p>
  </VCard>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { IconMeditation, IconUsers } from '@/components/icons'
import { VAvatar, VCard } from '@/components/ui'
import { plural } from '@/utils/plural'
import { schoolHashFromName } from '@/utils/schoolBranding'
import SchoolMandalaBadge from '@/components/shared/SchoolMandalaBadge.vue'

const props = defineProps<{
  name: string
  avatarUrl?: string | null
  /** Branding hash: caller's field when it has one; otherwise derived from
   *  the name (§5.2 variant A, the CuratorGroupRow idiom). */
  hash?: string | null
  studentsCount: number
  mastersCount: number
  /** The school's own description -- rendered only when non-blank. */
  description?: string | null
  /** FE-67's «кто предлагает»: the school's curator, when the caller knows
   *  one. Rendered as a quiet line under the name; omitted, never «Куратор:». */
  curatorName?: string | null
  /** The bold invitation line at the card's bottom («Вас пригласили…!»). */
  heading: string
}>()

// §5.2: no branding_hash on the invite payloads yet -- variant A, the client
// derives it from the name (async: one microtask after mount), unless the
// caller already knows a hash.
const derivedHash = ref<string | null>(null)
onMounted(() => {
  if (props.hash) return
  void schoolHashFromName(props.name).then((h) => {
    derivedHash.value = h
  })
})
const resolvedHash = computed(() => props.hash ?? derivedHash.value)

const studentsLabel = computed(
  () => `${props.studentsCount} ${plural(props.studentsCount, 'ученик', 'ученика', 'учеников')}`,
)
const mastersLabel = computed(
  () => `${props.mastersCount} ${plural(props.mastersCount, 'мастер', 'мастера', 'мастеров')}`,
)
</script>

<style scoped>
.school-invite {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-2);
}

.school-invite__logo-frame {
  display: inline-flex;
  padding: var(--space-1);
  border: 4px solid var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
}

.school-invite__logo {
  display: block;
  background: var(--velo-bg-card-solid);
}

.school-invite__name {
  margin: var(--space-2) 0 0;
  font-size: var(--text-lg);
  color: var(--velo-text-primary);
  overflow-wrap: anywhere;
}

.school-invite__curator {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
}

/* The counters line, students first then masters -- the hero card's idiom
   (same two semantic icons, same pluralised words). */
.school-invite__stats {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-4);
  margin-top: var(--space-2);
  color: var(--velo-text-secondary);
  font-size: var(--text-sm);
}

.school-invite__stats span {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
}

.school-invite__description {
  max-width: var(--velo-content-width-narrow);
  margin: var(--space-3) 0 0;
  color: var(--velo-text-primary);
  font-size: var(--text-sm);
  line-height: 1.45;
}

/* The mockup's bold invitation line: the faux-bold stroke canon, centred,
   closing the card. */
.school-invite__heading {
  margin: var(--space-4) 0 0;
  font-family: var(--font-body);
  font-size: var(--text-lg);
  line-height: 1.3;
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong) var(--velo-text-primary);
}
</style>
