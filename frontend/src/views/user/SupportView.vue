<!--
  VELO Frontend -- SupportView (USER zone, batch I)

  User support / contact form, reached from the user profile hub («Поддержка»).
  Mirrors MasterSupportView's structure (topic picker + message + submit) but with
  the USER-facing topic catalog and an INTERNAL priority per topic (P0/P1/P2 — NOT
  shown to the user, and NOT sent anywhere yet either; see PROMPT №712's own
  report on why a comms thread has no sortable home for it today).

  WIRED (PROMPT №712, owner ruling B): submitting opens the caller's one eternal
  support thread (@/api/support::openSupportThread) and delivers the topic label
  + message as its first (or next) message (::sendSupportMessage) -- this is the
  messaging module (comms sections), not the `SupportTicket` model
  VELO-Backend-Tasks.md describes elsewhere (that plan stays Zod's, untouched).
  The terminal screen's copy was written for the old stub and became FALSE the
  moment this screen started delivering -- it promised a channel that had just
  arrived and sent the reader to email instead. Rewritten at PROMPT №712 to the
  owner's own approved wording: the reply comes back HERE, and email is now the
  fallback for a late answer rather than the substitute for a missing channel.
  ⚠ Do not "improve" this wording. Words a human reads are the owner's call on
  this project, and this screen already cost one round of exactly that.

  Route: /user/support (name 'user-support').
-->
<template>
  <div class="support">
    <!-- Header hidden on the terminal screen (no back — «На главную» is the exit). -->
    <VHeader v-if="!submitted" title="Поддержка" show-back @back="router.back()" />

    <!-- ===================== TERMINAL (honest) ===================== -->
    <div v-if="submitted" class="support__done">
      <div class="support__ok-circle">
        <IconSupportChat :size="48" />
      </div>
      <h2 class="support__ok-title">Спасибо за обращение</h2>
      <p class="support__ok-text">Мы получили ваше обращение и ответим здесь же, в приложении.</p>
      <VButton variant="primary" block class="support__ok-cta" @click="goHome">
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

      <a class="support__email" :href="emailHref"
        >Не дождались ответа? Напишите на support@velo.app</a
      >

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
import { IconSupportChat } from '@/components/icons'
import { useKeyboardFieldScroll } from '@/composables/useKeyboardFieldScroll'
import { openSupportThread, sendSupportMessage } from '@/api/support'
import { useToast } from '@/composables/useToast'
import { extractApiError } from '@/composables/useApiError'

const router = useRouter()
const toast = useToast()

// Lift the «Сообщение» textarea above the soft keyboard once it settles (shared M5).
const { onFieldFocus } = useKeyboardFieldScroll()

// -- Topic catalog (batch I). priority is INTERNAL routing/sort metadata — it is
//    deliberately NOT rendered to the user. --
type SupportPriority = 'P0' | 'P1' | 'P2'
interface SupportTopic {
  value: string
  label: string
  priority: SupportPriority
}
const TOPICS: SupportTopic[] = [
  { value: 'payment', label: 'Проблема с оплатой / транзакцией', priority: 'P1' },
  { value: 'complaint_master', label: 'Жалоба на мастера', priority: 'P0' },
  { value: 'practice', label: 'Проблема с практикой', priority: 'P1' },
  { value: 'technical', label: 'Технический вопрос', priority: 'P2' },
  { value: 'other', label: 'Другое', priority: 'P2' },
]
// VRadioGroup only needs {value,label}; priority stays off the rendered options.
const topicOptions = TOPICS.map((t) => ({ value: t.value, label: t.label }))

const topic = ref<string>(TOPICS[0]!.value)
const otherText = ref('')
const message = ref('')

const emailHref = 'mailto:support@velo.app'

const canSubmit = computed(() => {
  const hasMessage = message.value.trim().length > 0
  const hasTopic = topic.value !== 'other' || otherText.value.trim().length > 0
  return hasMessage && hasTopic
})

const submitted = ref(false)
const submitting = ref(false)

// PROMPT №712 (owner ruling B): the topic picker stays the entry; submit now
// opens the caller's one eternal support thread and delivers the topic +
// message as its first (or next) message -- two calls, same open-then-send
// split api/chats.ts already uses. `priority` stays INTERNAL-only routing
// metadata (unchanged from the stub): PROMPT №712 measured that a comms
// thread has no server-side-sortable field for it, so nothing here sends it
// anywhere yet -- see that prompt's report for the open question.
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

function goHome(): void {
  router.push({ name: 'user-dashboard' })
}
</script>

<style scoped>
.support {
  display: flex;
  flex-direction: column;
}

.support__content {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-2) 0 var(--space-4);
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
  letter-spacing: 0.02em;
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

/* PROMPT №679: .support__other-input (below) is borderless by design; unlike
   DiaryComposer this wrapper already has a rest-state border, so focus adds
   a RING around the existing border rather than changing its colour. */
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

/* -- Terminal screen (honest — no «отправлено» server claim) -- */
.support__done {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--space-8) var(--space-4);
  gap: var(--space-4);
}

.support__ok-circle {
  width: 93px;
  height: 93px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-teal-30);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--velo-primary);
  margin-bottom: var(--space-1);
}

.support__ok-title {
  font-family: var(--font-body);
  font-size: var(--text-lg);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.support__ok-text {
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  line-height: 1.4;
  max-width: var(--velo-content-width-narrow);
  margin: 0;
}

.support__ok-text a {
  color: var(--velo-primary);
  text-decoration: none;
}

.support__ok-cta {
  margin-top: var(--space-4);
}
</style>
