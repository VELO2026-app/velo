<!--
  VELO Frontend -- AiSummaryView (screen 16, AI-summary)

  Honest placeholder. The personalised weekly AI summary (text, mood trend,
  recommendations) has no backend yet -- the only AI endpoint that exists is
  the master-facing per-practice mock (GET /practices/{id}/ai-summary), which
  is not what this user-facing screen needs.

  Rather than render fake data that could be mistaken for real, this screen
  states plainly that the section is under development. When a real user AI
  summary endpoint exists, replace this with the full Figma 16 layout
  (summary card + mood trend + recommendations).

  Route: /user/ai-summary
-->

<template>
  <div class="ai-summary">
    <VHeader title="AI-саммари" show-back @back="router.back()" />

    <div class="ai-summary__body">
      <span class="ai-summary__icon">
        <IconBrain :size="40" />
      </span>
      <h1 class="ai-summary__title">Этот раздел в разработке</h1>
      <p class="ai-summary__text">
        Скоро здесь появится ваше персональное саммари недели с рекомендациями.
      </p>
      <VButton variant="primary" size="lg" @click="goToDashboard"> На главную </VButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { VButton } from '@/components/ui'
import { VHeader } from '@/components/layout'
import { IconBrain } from '@/components/icons'

const router = useRouter()

function goToDashboard(): void {
  void router.push({ name: 'user-dashboard' })
}
</script>

<style scoped>
.ai-summary {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.ai-summary__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-4);
  padding: var(--space-5);
}

.ai-summary__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  border-radius: var(--radius-full);
  background: var(--velo-glass-teal-30);
  color: var(--velo-teal-600);
}

.ai-summary__title {
  font-family: var(--font-body);
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.ai-summary__text {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-text-secondary);
  max-width: 280px;
  line-height: 1.5;
}
</style>
