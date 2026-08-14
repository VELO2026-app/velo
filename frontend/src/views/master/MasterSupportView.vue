<!--
  VELO Frontend -- MasterSupportView (Phase-3 Master DS, 2026-06-13)

  Support / contact form, reached from the master profile hub («Поддержка»).
  Built to SVGs «5 Support» / «5 Support 2» / «5 Support (files added)» /
  «Check-in Success» (the form's success screen).

  WIRED (PROMPT №712, owner ruling B): «Отправить» opens the caller's one
  eternal support thread (@/api/support::openSupportThread) and delivers the
  topic label + message as its first (or next) message (::sendSupportMessage)
  -- the messaging module (comms sections), NOT the `SupportTicket` model
  VELO-Backend-Tasks.md describes elsewhere (that plan stays Zod's, untouched).
  ⚠ The success screen's copy ("Поддержка в приложении скоро заработает...")
  is now FALSE -- written for the old stub, still says there is no in-app
  channel. NOT rewritten here on purpose: user-facing wording is the owner's
  call (PROMPT №712 flagged the exact lines, not touched). Attachments stay
  CAPTURED-LOCALLY-ONLY, unwired, out of that prompt's scope (no
  upload/storage backend exists).

  Roadmap beyond this prompt: file upload + storage; the «Добавить
  направление практики» topic may route to its own flow.

  Route: /master/support (name 'master-support', meta.hideTabBar — back-nav
  screen, no tab bar per the design).
-->
<template>
  <div class="support">
    <!-- Header hidden on the success screen — it's a terminal state with no back
         (operator 2026-06-19); «На главную» is the only exit. -->
    <VHeader v-if="!submitted" title="Поддержка" show-back @back="router.back()" />

    <!-- ===================== TERMINAL (honest — no delivery claim) ===========
         Mirrors the user SupportView: there is no support backend, so we do NOT
         say «отправлено». Honest coming-soon wording + the real mailto channel. -->
    <div v-if="submitted" class="support__success">
      <div class="support__ok-circle">
        <IconSupportChat :size="48" />
      </div>
      <h2 class="support__ok-title">Спасибо за обращение</h2>
      <p class="support__ok-text">
        Поддержка в приложении скоро заработает. Если вопрос срочный — напишите нам на
        <a :href="emailHref">support@velo.app</a>.
      </p>
      <VButton variant="primary" block class="support__ok-cta" @click="onGoHome">
        На главную
      </VButton>
    </div>

    <!-- ===================== FORM ===================== -->
    <div v-else class="support__content">
      <div class="support__hero">
        <IconSupportChat :size="56" class="support__hero-ic" />
        <div class="support__hero-title">Как мы можем помочь?</div>
        <div class="support__hero-sub">Обычно отвечаем в течение 24 часов</div>
      </div>

      <!-- Topic -->
      <section class="support__section">
        <h2 class="support__title">Тема</h2>
        <div class="support__card">
          <VRadioGroup v-model="topic" :options="topicOptions" />
          <div v-if="topic === 'other'" class="support__other">
            <input
              v-model="otherText"
              type="text"
              class="support__other-input"
              placeholder="Укажите ваш вариант"
              @focus="onFieldFocus"
            />
            <IconArrowRight :size="18" class="support__other-arrow" />
          </div>
        </div>
      </section>

      <!-- Message -->
      <section class="support__section">
        <h2 class="support__title">Сообщение</h2>
        <VTextarea
          v-model="message"
          :rows="5"
          placeholder="Опишите вашу проблему или вопрос..."
          @focus="onFieldFocus"
        />
      </section>

      <!-- Attachments (UI built; files captured locally, NOT uploaded — stub) -->
      <section class="support__section">
        <h2 class="support__title">Прикрепить файл</h2>
        <div class="support__upload">
          <button type="button" class="support__drop" @click="openFilePicker">
            <IconFile :size="26" />
            <span>+ Добавить файл (5MB)</span>
          </button>
          <input
            ref="fileInput"
            type="file"
            multiple
            class="support__file-input"
            @change="onFilesPicked"
          />
          <div v-if="attachments.length" class="support__thumbs">
            <button
              v-for="(file, i) in attachments"
              :key="i"
              type="button"
              class="support__thumb"
              :title="file.name"
              aria-label="Удалить файл"
              @click="removeAttachment(i)"
            >
              <IconClose :size="12" />
            </button>
          </div>
        </div>
      </section>

      <a class="support__email" :href="emailHref">Или напишите: support@velo.app</a>

      <VButton
        variant="primary"
        block
        :disabled="!canSubmit"
        :loading="submitting"
        class="support__submit"
        @click="onSubmit"
      >
        Отправить
      </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VRadioGroup, VTextarea } from '@/components/ui'
import { IconSupportChat, IconFile, IconClose, IconArrowRight } from '@/components/icons'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { openSupportThread, sendSupportMessage } from '@/api/support'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()
const toast = useToast()

// Scroll the «Сообщение» textarea above the soft keyboard once it settles (M5).
const { onFieldFocus } = useKeyboardFieldScroll()

// -- Topic catalog (L7) -----------------------------------------------------
// Mirrors the user SupportView pattern: each topic carries an INTERNAL priority
// (P0/P1/P2 — future routing/sort signal) that is deliberately NOT rendered to
// the master. «Добавить направление практики» is a PLAIN free-text topic (no
// special form/route). «Вопрос по отклоненной заявке» removed (operator L7).
type SupportPriority = 'P0' | 'P1' | 'P2'
interface SupportTopic {
  value: string
  label: string
  priority: SupportPriority
}
const TOPICS: SupportTopic[] = [
  { value: 'withdrawal', label: 'Проблема с выводом', priority: 'P0' },
  { value: 'practices', label: 'Вопрос по практикам', priority: 'P1' },
  { value: 'technical', label: 'Технические проблемы', priority: 'P2' },
  { value: 'add_direction', label: 'Добавить направление практики', priority: 'P2' },
  { value: 'other', label: 'Другое', priority: 'P2' },
]
// VRadioGroup only needs {value,label}; priority stays off the rendered options.
const topicOptions = TOPICS.map((t) => ({ value: t.value, label: t.label }))
const topic = ref('withdrawal')
const otherText = ref('')
const message = ref('')

// -- Attachments (captured locally only; no upload backend — see header) -----
const MAX_FILES = 5
const attachments = ref<File[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

function openFilePicker(): void {
  fileInput.value?.click()
}

function onFilesPicked(e: Event): void {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  attachments.value = [...attachments.value, ...Array.from(input.files)].slice(0, MAX_FILES)
  // Reset so picking the same file again re-triggers change.
  input.value = ''
}

function removeAttachment(i: number): void {
  attachments.value.splice(i, 1)
}

// -- Submit (flow В) --------------------------------------------------------
const emailHref = 'mailto:support@velo.app'

const canSubmit = computed(() => {
  const hasMessage = message.value.trim().length > 0
  const hasTopic = topic.value !== 'other' || otherText.value.trim().length > 0
  return hasMessage && hasTopic
})

const submitted = ref(false)
const submitting = ref(false)

// PROMPT №712 (owner ruling B): wired the same way as the user SupportView --
// open the caller's eternal support thread, then deliver the topic + message
// as its first (or next) message. Attachments stay CAPTURED-LOCALLY-ONLY as
// before (no upload/storage backend exists; out of this task's scope) -- they
// are not sent anywhere. `priority` stays internal-only; see PROMPT №712's
// report on why a comms thread has nowhere sortable to put it yet.
async function onSubmit(): Promise<void> {
  if (!canSubmit.value || submitting.value) return
  const selected = TOPICS.find((t) => t.value === topic.value)
  const topicLabel =
    topic.value === 'other' ? otherText.value.trim() : (selected?.label ?? topic.value)
  const text = message.value.trim()

  submitting.value = true
  try {
    await openSupportThread(topicLabel)
    await sendSupportMessage(topicLabel, text)
    submitted.value = true
  } catch (e) {
    toast.error(extractApiError(e, 'Не удалось отправить обращение'))
  } finally {
    submitting.value = false
  }
}

function onGoHome(): void {
  router.push({ name: 'master-dashboard' })
}
</script>

<style scoped>
.support {
  display: flex;
  flex-direction: column;
  margin: calc(-1 * var(--space-4));
}

.support__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: 0 var(--space-4) var(--space-4);
}

/* Drop VTextarea's form-stacking bottom margin inside a gap'd section. */
.support__section :deep(.v-textarea) {
  margin-bottom: 0;
}

/* -- Hero -- */
.support__hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--velo-gap-6);
  text-align: center;
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-5);
}

.support__hero-ic {
  color: var(--velo-primary);
}

.support__hero-title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong) currentColor;
}

.support__hero-sub {
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
}

/* -- Section -- */
.support__section {
  display: flex;
  flex-direction: column;
  gap: var(--velo-card-meta-row-gap);
}

.support__title {
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
  -webkit-text-stroke: var(--velo-text-stroke-strong) currentColor;
}

/* -- Topic card -- */
.support__card {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--velo-inset-row);
}

.support__other {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  height: var(--velo-size-40);
  padding: 0 var(--space-4);
  border: 1.5px solid var(--velo-primary);
  border-radius: var(--radius-full);
  transition: box-shadow var(--transition-fast);
}

/* PROMPT №679: mirrors user SupportView.vue's identical structure -- ring
   around the existing border on focus, no colour change to the border. */
.support__other:focus-within {
  box-shadow: 0 0 0 3px var(--velo-glass-blue-60);
}

.support__other-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--velo-text-primary);
}

.support__other-input::placeholder {
  color: var(--velo-text-muted);
}

.support__other-arrow {
  flex-shrink: 0;
  color: var(--velo-primary);
}

/* -- Attachments -- */
.support__upload {
  background: var(--velo-bg-card-solid);
  border: 1px solid var(--velo-border-card);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.support__drop {
  width: 100%;
  min-height: 80px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--velo-gap-6);
  border: 1px dashed var(--velo-text-primary);
  border-radius: var(--velo-radius-9);
  background: transparent;
  color: var(--velo-text-primary);
  cursor: pointer;
  font-family: var(--font-body);
  font-size: var(--text-base);
}

.support__file-input {
  display: none;
}

.support__thumbs {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--velo-card-meta-row-gap);
  flex-wrap: wrap;
}

.support__thumb {
  width: 54px;
  height: 54px;
  padding: 4px;
  border-radius: var(--velo-radius-9);
  background: var(--velo-glass-blue-15);
  border: 1px solid var(--velo-border-light);
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  color: var(--velo-text-secondary);
  cursor: pointer;
  flex-shrink: 0;
}

/* -- Email fallback + submit -- */
.support__email {
  text-align: center;
  font-size: var(--text-xs);
  color: var(--velo-text-secondary);
  text-decoration: none;
}

.support__submit {
  margin-top: var(--space-1);
}

/* -- Success -- */
/* Full-bleed solid white terminal screen (operator 2026-06-19): covers the photo
   background entirely and sits over the header (no back button on success). */
.support__success {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: var(--velo-bg-card-solid);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  /* Spacing is per-element margin (circle→title→text→CTA) to match the comp's
     rhythm. padding = --space-8 (33px) restores the side margins lost when the
     stale `var(--space-6)` token (removed in the DS cleanup) collapsed to 0. */
  padding: var(--space-8);
}

.support__ok-circle {
  width: 93px;
  height: 93px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-teal-30);
  display: flex;
  align-items: center;
  justify-content: center;
  /* Honest stub: a support-chat glyph (not a triumphant «sent» check). */
  color: var(--velo-primary);
}

.support__ok-title {
  font-family: var(--font-body);
  font-size: 28px;
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: var(--space-5) 0 0;
  -webkit-text-stroke: var(--velo-text-stroke-strong) currentColor;
}

.support__ok-text {
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  line-height: 1.35;
  max-width: 290px;
  margin: var(--space-4) 0 0;
}

.support__ok-text a {
  color: var(--velo-primary);
  text-decoration: none;
}

.support__ok-cta {
  width: 100%;
  max-width: 336px;
  align-self: center;
  margin-top: var(--space-8);
  /* Heavier label (operator 2026-06-19) — Marmelad is single-weight, so thicken
     with the 0.3px stroke trick used by the section titles. */
  -webkit-text-stroke: var(--velo-text-stroke-strong) currentColor;
}
</style>
