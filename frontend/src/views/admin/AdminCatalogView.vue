<!--
  VELO Frontend -- AdminCatalogView (batch P, P2; made editable R5 stage 3c)

  The practice-taxonomy catalog: each direction with its styles (виды).
  Reached from the Admin dashboard «Каталог практик» row.

  R5 stage 3c: now editable, backed by the stage-2 admin CRUD API
  (GET/POST/PATCH /api/v1/admin/taxonomy/*) -- add direction, add style
  under a direction, edit label, deactivate/reactivate (is_active toggle,
  NEVER a hard delete -- existing masters' stored methods strings must keep
  resolving against a retired direction/style). Source badge (seed/custom)
  shows which rows came from the R5 migration vs were added here or
  auto-promoted (R5 stage 4) from an approved custom method.

  Scope: governs the MASTER METHODS picker (R5) AND, since T2 (2026-07-15,
  backend practices/service.py: _validate_taxonomy()), practice-creation
  taxonomy too -- as a UNION with settings.practice_allowed_directions/
  practice_allowed_styles_by_direction (config), so adding a direction/style
  here now also reaches POST/PATCH /api/v1/practices, not just the methods
  picker. The practice-CREATE screen itself (CreatePracticeView) does not yet
  read this catalog -- that is stage 2, a separate follow-up batch.

  Every mutation refetches the full catalog rather than patching local state
  -- simplest correct approach for a low-traffic admin screen with a nested
  direction->styles shape.
-->

<template>
  <div class="admin-catalog">
    <header class="admin-catalog__top">
      <VBackButton @click="router.back()" />
      <span class="admin-catalog__title">Каталог практик</span>
    </header>

    <VCard class="admin-catalog__note" padding="none">
      Управление каталогом. Изменения видны мастерам сразу при выборе методов.
    </VCard>

    <!-- Add direction -->
    <VCard class="admin-catalog__add" padding="none">
      <VInput
        v-model="newDirectionLabel"
        placeholder="Новое направление…"
        class="admin-catalog__add-input"
      />
      <VButton
        variant="primary"
        size="sm"
        :loading="addingDirection"
        :disabled="!newDirectionLabel.trim()"
        @click="addDirection"
      >
        + Добавить
      </VButton>
    </VCard>

    <div v-if="loading" class="admin-catalog__loader"><VLoader size="lg" /></div>

    <VEmptyState
      v-else-if="error"
      icon="warning"
      title="Не удалось загрузить каталог"
      description="Проверьте соединение и попробуйте ещё раз"
    >
      <template #action><VButton variant="primary" @click="load">Повторить</VButton></template>
    </VEmptyState>

    <VCard
      v-else
      v-for="dir in directions"
      :key="dir.id"
      class="admin-catalog__dir"
      :class="{ 'admin-catalog__dir--inactive': !dir.is_active }"
      padding="none"
    >
      <div class="admin-catalog__dir-head">
        <template v-if="editingDirectionId === dir.id">
          <VInput v-model="draftLabel" class="admin-catalog__edit-input" />
          <button type="button" class="admin-catalog__icon-btn" aria-label="Сохранить" @click="saveDirectionLabel(dir)">
            <IconCheck :size="18" />
          </button>
          <button type="button" class="admin-catalog__icon-btn" aria-label="Отмена" @click="cancelEdit">
            <IconClose :size="18" />
          </button>
        </template>
        <template v-else>
          <span class="admin-catalog__dir-title">{{ dir.label }}</span>
          <VBadge :variant="dir.source === 'seed' ? 'muted' : 'blue'">{{ dir.source }}</VBadge>
          <button type="button" class="admin-catalog__icon-btn" aria-label="Редактировать" @click="startEditDirection(dir)">
            <IconEdit :size="18" />
          </button>
          <VButton
            v-if="dir.is_active"
            variant="ghost"
            size="sm"
            :loading="togglingId === dir.id"
            @click="toggleDirectionActive(dir)"
          >
            Деактивировать
          </VButton>
          <VButton
            v-else
            variant="secondary"
            size="sm"
            :loading="togglingId === dir.id"
            @click="toggleDirectionActive(dir)"
          >
            Активировать
          </VButton>
        </template>
      </div>

      <template v-if="dir.is_active">
        <div v-if="(dir.styles ?? []).length" class="admin-catalog__chips">
          <VChip
            v-for="st in dir.styles ?? []"
            :key="st.id"
            size="sm"
            :class="{ 'admin-catalog__chip--inactive': !st.is_active }"
            clickable
            @click="toggleStyleActive(st)"
          >
            {{ st.label }} {{ st.is_active ? '✕' : '· Активировать' }}
          </VChip>
        </div>
        <div v-else class="admin-catalog__none">Без видов</div>

        <div class="admin-catalog__add-style">
          <VInput
            v-model="newStyleLabel[dir.id]"
            placeholder="Новый вид…"
            class="admin-catalog__add-style-input"
          />
          <VButton
            variant="secondary"
            size="sm"
            :loading="addingStyleFor === dir.id"
            :disabled="!(newStyleLabel[dir.id] ?? '').trim()"
            @click="addStyle(dir)"
          >
            +
          </VButton>
        </div>
      </template>
      <div v-else class="admin-catalog__none">
        Неактивно — скрыто у мастеров, старые методы сохраняются
      </div>
    </VCard>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { VBackButton, VCard, VChip, VInput, VButton, VBadge, VLoader, VEmptyState } from '@/components/ui'
import { IconEdit, IconClose, IconCheck } from '@/components/icons'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import {
  getFullTaxonomy,
  createTaxonomyDirection,
  createTaxonomyStyle,
  updateTaxonomyDirection,
  updateTaxonomyStyle,
  type TaxonomyDirectionItem,
  type TaxonomyStyleItem,
} from '@/api/taxonomy'

const router = useRouter()
const toast = useToast()

const directions = ref<TaxonomyDirectionItem[]>([])
const loading = ref(false)
const error = ref(false)

async function load(): Promise<void> {
  loading.value = true
  error.value = false
  try {
    const res = await getFullTaxonomy()
    directions.value = res.directions
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

// -- Add direction --
const newDirectionLabel = ref('')
const addingDirection = ref(false)

/** Cyrillic labels have no natural ASCII slug and nothing reads `value` for
 *  a display purpose (every consumer shows `label`) -- same synthetic-slug
 *  approach as the backend's stage-4 auto-promote. */
function genSlug(): string {
  return `custom_${Math.random().toString(36).slice(2, 10)}`
}

async function addDirection(): Promise<void> {
  const label = newDirectionLabel.value.trim()
  if (!label || addingDirection.value) return
  addingDirection.value = true
  try {
    await createTaxonomyDirection({ value: genSlug(), label })
    newDirectionLabel.value = ''
    toast.success('Направление добавлено')
    await load()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось добавить направление'))
  } finally {
    addingDirection.value = false
  }
}

// -- Add style (per direction) --
const newStyleLabel = reactive<Record<string, string>>({})
const addingStyleFor = ref<string | null>(null)

async function addStyle(dir: TaxonomyDirectionItem): Promise<void> {
  const label = (newStyleLabel[dir.id] ?? '').trim()
  if (!label || addingStyleFor.value) return
  addingStyleFor.value = dir.id
  try {
    await createTaxonomyStyle(dir.id, { value: genSlug(), label })
    newStyleLabel[dir.id] = ''
    toast.success('Вид добавлен')
    await load()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось добавить вид'))
  } finally {
    addingStyleFor.value = null
  }
}

// -- Edit label (direction only -- styles are short enough not to need it
//    from this screen; deactivate/reactivate covers the common style edit) --
const editingDirectionId = ref<string | null>(null)
const draftLabel = ref('')
const savingDirectionId = ref<string | null>(null)

function startEditDirection(dir: TaxonomyDirectionItem): void {
  editingDirectionId.value = dir.id
  draftLabel.value = dir.label
}

function cancelEdit(): void {
  editingDirectionId.value = null
}

async function saveDirectionLabel(dir: TaxonomyDirectionItem): Promise<void> {
  const label = draftLabel.value.trim()
  if (!label || savingDirectionId.value) return
  savingDirectionId.value = dir.id
  try {
    await updateTaxonomyDirection(dir.id, { label })
    editingDirectionId.value = null
    toast.success('Сохранено')
    await load()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось сохранить'))
  } finally {
    savingDirectionId.value = null
  }
}

// -- Deactivate / reactivate --
const togglingId = ref<string | null>(null)

async function toggleDirectionActive(dir: TaxonomyDirectionItem): Promise<void> {
  if (togglingId.value) return
  togglingId.value = dir.id
  try {
    await updateTaxonomyDirection(dir.id, { is_active: !dir.is_active })
    await load()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось изменить статус'))
  } finally {
    togglingId.value = null
  }
}

async function toggleStyleActive(st: TaxonomyStyleItem): Promise<void> {
  if (togglingId.value) return
  togglingId.value = st.id
  try {
    await updateTaxonomyStyle(st.id, { is_active: !st.is_active })
    await load()
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось изменить статус'))
  } finally {
    togglingId.value = null
  }
}

onMounted(load)
</script>

<style scoped>
.admin-catalog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.admin-catalog__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--velo-size-44);
}

.admin-catalog__title {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.admin-catalog__note {
  padding: var(--space-3);
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  line-height: 1.4;
}

.admin-catalog__loader {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

/* -- Add direction -- */
.admin-catalog__add {
  padding: var(--space-3);
  display: flex;
  gap: var(--space-2);
  align-items: center;
  /* T21-9 (ПРОМТ №546): the input can shrink to 0 (min-width:0 below) but
     VButton is white-space:nowrap with no min-width override, so on a narrow
     card it cannot shrink below "+ Добавить"'s full width and pokes out past
     the card edge. Same escape hatch already used at .admin-catalog__dir-head
     (Bug 6b, ПРОМТ №408) -- let the button drop to its own line instead. */
  flex-wrap: wrap;
}

.admin-catalog__add-input {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
}

.admin-catalog__dir {
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.admin-catalog__dir--inactive {
  opacity: 0.6;
}

.admin-catalog__dir-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* Bug 6b (ПРОМТ №408, operator-approved .tmp/promt407-bug4-bug6-preview.html):
     lets the toggle button drop to its own line when the title's real width
     doesn't leave room for it, instead of the title painting through the
     source badge (see .admin-catalog__dir-title below for why). */
  flex-wrap: wrap;
}

.admin-catalog__dir-title {
  /* flex-basis: auto (was `flex: 1` = 0%) so an unbreakable long Cyrillic
     label's real content width counts toward the flex-wrap decision above --
     basis:0% hides it from that decision entirely, which is why the row
     never wrapped and the title just painted through the badge next to it. */
  flex: 1 1 auto;
  min-width: 0;
  /* ПРОМТ №503 commit 4: min-width:0 only lets this item SHRINK below its
     content size -- it doesn't give the text itself anywhere to break. A
     single long unbreakable label (admin free text or an auto-promoted
     custom method has no length cap under 100 chars) still overflowed this
     box and, with it, the whole .admin-layout__main content area
     horizontally. overflow-wrap lets it break within the word as a last
     resort, same as any other real-content flex item in this app. */
  overflow-wrap: anywhere;
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
}

.admin-catalog__edit-input {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
}

.admin-catalog__icon-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--velo-glass-blue-15);
  color: var(--velo-primary);
  border: none;
  cursor: pointer;
  flex-shrink: 0;
}

.admin-catalog__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* ПРОМТ №503 commit 4: VChip's shared default is white-space:nowrap (correct
   everywhere else it's used -- short, bounded labels). This screen's style
   labels are admin free text or auto-promoted custom methods with no length
   cap under 100 chars, so a long one rendered as a single unbreakable pill
   wider than the viewport -- flex-wrap on the row above only wraps BETWEEN
   chips, not inside one. Scoped to this screen's chips only via :deep(), so
   the shared component's nowrap default is untouched everywhere else. */
.admin-catalog__chips :deep(.v-chip) {
  white-space: normal;
  overflow-wrap: anywhere;
  max-width: 100%;
}

.admin-catalog__chip--inactive {
  opacity: 0.55;
}

.admin-catalog__none {
  font-size: var(--text-xs);
  color: var(--velo-text-muted);
}

.admin-catalog__add-style {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.admin-catalog__add-style-input {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
}
</style>
