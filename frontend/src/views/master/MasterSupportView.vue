<!--
  VELO Frontend -- MasterSupportView (Phase-3 Master DS, 2026-06-13)

  Support / contact form, reached from the master profile hub («Поддержка»).
  Built to SVGs «5 Support» / «5 Support 2» / «5 Support (files added)» /
  «Check-in Success» (the form's success screen).

  WIRED (FE-104, owner ruling BE-162): «Отправить» creates a NEW ticket -- the
  topic as a CODE and the message, one call (@/api/support::createTicket) under
  the appeal's Idempotency-Key (::createAppealKeys: the same key while the
  topic and the text stay the same, so a retry after a failed send is the same
  ticket). «Другое» has no free text of its own (owner): the substance is the
  message. New master topic: «Жалоба на пользователя» (`complaint_user`).
  The success screen's copy was written for the old stub, became FALSE the
  moment this screen started delivering, was rewritten at PROMPT №712, and is
  REWRITTEN AGAIN at FE-103 (owner ruling 25.10), identical to the user
  screen's: the reply now arrives in «Сообщения» (BE-163), and after the send
  the form opens that conversation itself. ⚠ Do not "improve" it -- wording is
  the owner's call. Attachments stay
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
    <VHeader
      v-if="!submitted"
      :title="t('masterScreens.masterSupport.title')"
      show-back
      @back="router.back()"
    />

    <!-- ===================== TERMINAL (delivery HAS happened) ================
         Mirrors the user SupportView. Reached only after the ticket call
         resolved, so it may state receipt: `submitted` is set inside the try,
         after createTicket, and a failure toasts and leaves the form standing.
         The old text here said there was no support backend and refused to
         claim delivery -- correct for the stub, false since PROMPT №712. -->
    <div v-if="submitted" class="support__success">
      <div class="support__ok-circle">
        <IconSupportChat :size="48" />
      </div>
      <h2 class="support__ok-title">
        {{ t('masterScreens.masterSupport.toast.thanks') }}
      </h2>
      <p class="support__ok-text">
        {{ t('masterScreens.masterSupport.thanks.text') }}
      </p>
      <VButton variant="primary" block class="support__ok-cta" @click="onGoHome">
        {{ t('common.backHome') }}
      </VButton>
    </div>

    <!-- ===================== FORM ===================== -->
    <div v-else class="support__content">
      <div class="support__hero">
        <IconSupportChat :size="56" class="support__hero-ic" />
        <div class="support__hero-title">
          {{ t('masterScreens.masterSupport.title') }}
        </div>
        <div class="support__hero-sub">
          {{ t('masterScreens.masterSupport.responseHint') }}
        </div>
      </div>

      <!-- Topic -->
      <section class="support__section">
        <h2 class="support__title">{{ t('masterScreens.masterSupport.topic.label') }}</h2>
        <div class="support__card">
          <VRadioGroup v-model="topic" :options="topicOptions" />
        </div>
      </section>

      <!-- Message -->
      <section class="support__section">
        <h2 class="support__title">{{ t('masterScreens.masterSupport.message.label') }}</h2>
        <VTextarea
          v-model="message"
          :rows="5"
          maxlength="4000"
          :placeholder="t('masterScreens.masterSupport.message.placeholder')"
          @focus="onFieldFocus"
        />
      </section>

      <!-- Attachments (UI built; files captured locally, NOT uploaded — stub) -->
      <section class="support__section">
        <h2 class="support__title">{{ t('masterScreens.masterSupport.attachFile') }}</h2>
        <div class="support__upload">
          <button type="button" class="support__drop" @click="openFilePicker">
            <IconFile :size="26" />
            <span>{{ t('masterScreens.masterSupport.addFile') }}</span>
          </button>
          <input
            ref="fileInput"
            type="file"
            multiple
            class="support__file-input"
            :aria-label="t('masterScreens.masterSupport.attachFile')"
            @change="onFilesPicked"
          />
          <div v-if="attachments.length" class="support__thumbs">
            <button
              v-for="(file, i) in attachments"
              :key="i"
              type="button"
              class="support__thumb"
              :title="file.name"
              :aria-label="t('masterScreens.masterSupport.removeFile')"
              @click="removeAttachment(i)"
            >
              <IconClose :size="12" />
            </button>
          </div>
        </div>
      </section>

      <a class="support__email" :href="emailHref">{{ t('common.supportEmailHint') }}</a>

      <VButton
        variant="primary"
        block
        :disabled="!canSubmit"
        :loading="submitting"
        class="support__submit"
        @click="onSubmit"
      >
        {{ t('common.submitSend') }}
      </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { VHeader } from '@/components/layout'
import { VButton, VRadioGroup, VTextarea } from '@/components/ui'
import { IconSupportChat, IconFile, IconClose } from '@/components/icons'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { createAppealKeys, createTicket, type SupportTopicCode } from '@/api/support'
import { listChats } from '@/api/chats'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'
import { supportTopicLabel } from '@/utils/supportTopics'

const router = useRouter()
const toast = useToast()

// Scroll the «Сообщение» textarea above the soft keyboard once it settles (M5).
const { onFieldFocus } = useKeyboardFieldScroll()

// -- Topic catalog (L7) -----------------------------------------------------
// Mirrors the user SupportView pattern: each topic carries an INTERNAL priority
// (P0/P1/P2 — future routing/sort signal) that is deliberately NOT rendered to
// the master. «Добавить направление практики» is a PLAIN free-text topic (no
// special form/route). «Вопрос по отклоненной заявке» removed (operator L7).
// FE-104: codes only; labels from the one table (supportTopics). The
// complaint topic's priority is P0, as the user form's complaint.
type SupportPriority = 'P0' | 'P1' | 'P2'
interface SupportTopic {
  value: SupportTopicCode
  priority: SupportPriority
}
const TOPICS: SupportTopic[] = [
  { value: 'withdrawal', priority: 'P0' },
  { value: 'practices', priority: 'P1' },
  { value: 'technical', priority: 'P2' },
  { value: 'add_direction', priority: 'P2' },
  { value: 'complaint_user', priority: 'P0' },
  { value: 'other', priority: 'P2' },
]
// VRadioGroup only needs {value,label}; priority stays off the rendered options.
const topicOptions = TOPICS.map((t) => ({ value: t.value, label: supportTopicLabel(t.value) }))
const topic = ref<SupportTopicCode>('withdrawal')
const message = ref('')
const appealKey = createAppealKeys()

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

const canSubmit = computed(() => message.value.trim().length > 0)

const submitted = ref(false)
const submitting = ref(false)

// FE-104: wired the same way as the user SupportView -- one call, a new
// ticket with its first message. Attachments stay CAPTURED-LOCALLY-ONLY as
// before (no upload/storage backend exists; out of this task's scope) -- they
// are not sent anywhere. `priority` stays internal-only: nothing sends it.
async function onSubmit(): Promise<void> {
  if (!canSubmit.value || submitting.value) return
  const text = message.value.trim()

  submitting.value = true
  try {
    await createTicket(topic.value, text, appealKey(topic.value, text))
    submitted.value = true
    void openConversation()
  } catch (e) {
    toast.error(extractApiError(e, t('masterScreens.masterSupport.toast.sendFailed')))
  } finally {
    submitting.value = false
  }
}

// FE-103 (owner ruling 25.10): after the send the form hands over to the
// conversation itself -- the support row from listChats() IS the thread.
// The success screen stays for the rare case the row is not there yet.
async function openConversation(): Promise<void> {
  try {
    const { threads } = await listChats()
    const support = threads.find((t) => t.channel === 'support')
    if (support) await router.push({ name: 'master-chat', params: { id: support.id } })
  } catch {
    // The success screen is the honest fallback (the reply lands in
    // «Сообщения» regardless); a failed lookup must not toast over success.
  }
}

function onGoHome(): void {
  void router.push({ name: 'master-dashboard' })
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
  font-size: var(--velo-fs-28);
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
