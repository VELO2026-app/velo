<!--
  VELO Frontend -- MasterCard (shared)

  Master info card used on practice/booking detail screens (Figma 15 / 18 /
  Calendar frame 4):
    - Avatar: VAvatar (real photo when master_avatar_url is set, initials
      from the name otherwise -- the project-wide avatar pattern).
    - Name + verified check
    - Method tags (VTag, cycling blue / pink / sand)

  The WHOLE card is the tap target -> master public profile (/user/masters/:id).
  (operator 2026-06-09: the separate "Подробнее" arrow link was removed; tapping
  anywhere on the card opens the master.) Same button pattern as PracticeListCard.

  Extracted from PracticeDetailView so screens 15 / 18 / frame 4 share one card.
-->

<template>
  <button type="button" class="master-card master-card--clickable" @click="onMore">
    <VAvatar :url="avatarUrl ?? ''" :name="masterName ?? 'Мастер'" size="xl" />
    <div class="master-card__info">
      <div class="master-card__name">
        {{ masterName ?? 'Мастер' }}
        <span class="master-card__verified">
          <IconCheck :size="14" />
        </span>
      </div>
      <div v-if="methods?.length" class="master-card__tags">
        <VTag
          v-for="(method, i) in methods"
          :key="method"
          :variant="TAG_VARIANTS[i % TAG_VARIANTS.length]"
        >
          {{ method }}
        </VTag>
      </div>
    </div>
  </button>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { VTag, VAvatar } from '@/components/ui'
import { IconCheck } from '@/components/icons'
import { useToast } from '@/composables/useToast'

const props = withDefaults(
  defineProps<{
    masterName?: string | null
    methods?: string[] | null
    /** Master avatar URL (User.avatar_url). Null -> placeholder glyph. */
    avatarUrl?: string | null
    /** Master user id -- target of the public-profile link. */
    masterId?: string | null
  }>(),
  {
    masterName: null,
    methods: null,
    avatarUrl: null,
    masterId: null,
  },
)

// Master method tags cycle through three tints (Figma: blue / pink / sand).
const TAG_VARIANTS = ['blue', 'pink', 'sand'] as const

const router = useRouter()
const toast = useToast()

function onMore(): void {
  if (!props.masterId) {
    // No id to navigate to (defensive -- detail always passes master_id).
    toast.info('Профиль мастера недоступен')
    return
  }
  router.push({ name: 'user-master-public', params: { id: props.masterId } })
}
</script>

<style scoped>
.master-card {
  width: 100%;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  /* Figma: base card height 104 (avatar xl=80 + padding-y 12+12). min-height
   * (not fixed height) so many wrapped method tags grow the card instead of
   * spilling out of it; with the usual 3-4 tags it stays at 104. */
  min-height: var(--velo-card-height-list);
  padding: 12px var(--space-3);
  display: flex;
  align-items: center;
  /* Figma: tags start at x=111 от card left = 14 padding + 80 avatar + 17 gap.
   * Round 17 до space-4=16 — расхождение 1px. */
  gap: var(--space-4);
  box-sizing: border-box;
  text-align: left;
  font-family: var(--font-body);
  color: var(--velo-text-primary);
}

/* Whole card is the tap target (same pattern as PracticeListCard). */
.master-card--clickable {
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.master-card--clickable:active {
  opacity: 0.85;
}

.master-card__info {
  flex: 1;
  min-width: 0;
}

.master-card__name {
  display: flex;
  align-items: center;
  /* Figma: gap name->verified ≈ 12 (233-221). Round до space-2=8. */
  gap: var(--space-2);
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  margin-bottom: var(--space-1);
}

.master-card__verified {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Figma: verified circle r=13 -> 26×26 (был 18). */
  width: 26px;
  height: 26px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-600);
}

.master-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-1);
}

/* T21-2 (ПРОМТ №546): a stored method is ONE flat "Направление — Вид" string
   (methodTaxonomy.ts SEP), so a single composite tag can be long -- flex-wrap
   above only wraps BETWEEN tags, it cannot help one tag whose own content
   overflows. VTag's shared default is white-space:nowrap (correct everywhere
   else it's used, short bounded labels). Same escape hatch already proven at
   AdminCatalogView.vue's chips (ПРОМТ №503) -- scoped via :deep() so the
   shared component's nowrap default is untouched everywhere else it's used. */
.master-card__tags :deep(.v-tag) {
  white-space: normal;
  overflow-wrap: anywhere;
  max-width: 100%;
}
</style>
