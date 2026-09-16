<!--
  VELO Frontend -- Landing (parked Phase A master web auth)

  Unlinked /auth/landing route (G1=А): the master-web entry. Never reached by
  App.vue / role redirects; lives until the web-auth backend (Zod E17) wires it.

  «Подать заявку» is an inert stub -> «недоступно» toast (registration backend =
  E17); «Войти» links to the parked /auth/login. Built 100% from DS over the
  classic app background. Geometry + copy mirror "1 Landing.svg". The three
  feature-card icons are the real Figma raster icons, extracted + downscaled
  into public/icons/ (feat-audience/analytics/automation).
-->

<template>
  <div class="auth velo-kbd-scroll">
    <VeloLogo variant="lockup" :size="120" class="auth__logo" />
    <h1 class="auth__title">Станьте мастером</h1>
    <p class="auth__brand">VELΘ</p>

    <div class="auth__cards">
      <article v-for="f in features" :key="f.title" class="feature-card">
        <img class="feature-card__icon" :src="f.icon" alt="" aria-hidden="true" />
        <div class="feature-card__body">
          <h2 class="feature-card__title">{{ f.title }}</h2>
          <p class="feature-card__desc">{{ f.desc }}</p>
        </div>
      </article>
    </div>

    <VButton variant="primary" block class="auth__cta" @click="apply">Подать заявку</VButton>

    <p class="auth__footer">
      Уже есть аккаунт?
      <button type="button" class="auth__footer-link" @click="goLogin">Войти</button>
    </p>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { VButton } from '@/components/ui'
import { VeloLogo } from '@/components/ui'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const toast = useToast()

const features = [
  {
    icon: '/icons/feat-audience.png',
    title: 'Новая аудитория',
    desc: 'Экосистема рекомендует вас участникам, которым нужна именно ваша специализация',
  },
  {
    icon: '/icons/feat-analytics.png',
    title: 'AI-аналитика',
    desc: 'Вы видите, с чем приходит группа, и что меняется после практики, система замечает ранние сигналы кризисных состояний',
  },
  {
    icon: '/icons/feat-automation.png',
    title: 'Автоматизация рутины',
    desc: 'Запись, оплата, ссылки на сессию и напоминания работают сами, пока вы готовитесь к практике',
  },
]

// Registration backend is not built (Zod E17): inert stub.
function apply(): void {
  toast.info('Подача заявки появится в веб-версии')
}
function goLogin(): void {
  router.push({ name: 'auth-login' })
}
</script>

<style scoped>
.auth {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100%;
  /* ROOT-LOCK: own the scroll (html/body/#app no longer absorb overflow). */
  overflow-y: auto;
  padding: var(--space-8) var(--velo-screen-padding);
  background: transparent;
  text-align: center;
}

.auth__logo {
  margin-bottom: var(--space-2);
}

.auth__title {
  font-size: var(--text-xl);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

/* Brand wordmark below the heading — faux-bold via the DS stroke token. */
.auth__brand {
  font-size: var(--text-46);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  -webkit-text-stroke: var(--velo-text-stroke-strong) currentColor;
  margin: 0 0 var(--space-5);
}

.auth__cards {
  width: 100%;
  max-width: var(--velo-content-width);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.feature-card {
  display: flex;
  gap: var(--velo-gap-15);
  align-items: flex-start;
  padding: var(--space-5) var(--velo-card-padding-x);
  background: var(--velo-bg-card-solid);
  border-radius: var(--radius-md);
  text-align: left;
}

.feature-card__icon {
  flex-shrink: 0;
  width: var(--velo-size-46);
  height: auto;
  object-fit: contain;
}

.feature-card__title {
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin: 0 0 var(--space-1);
}

.feature-card__desc {
  font-size: var(--text-xs);
  line-height: 1.2;
  color: var(--velo-text-secondary);
  letter-spacing: 0.02em;
  margin: 0;
}

.auth__cta {
  width: 100%;
  max-width: var(--velo-content-width);
  margin-top: var(--space-8);
}

/* Auth CTA label is 20px in the Figma; scoped :deep override beats VButton's
   internal .v-btn--md (--text-sm). VButton's app-wide default is untouched. */
.auth :deep(.v-btn) {
  font-size: var(--text-lg);
}

.auth__footer {
  font-size: var(--text-xs);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  margin-top: var(--space-4);
}

.auth__footer-link {
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--text-base);
  color: var(--velo-text-primary);
  letter-spacing: 0.02em;
  -webkit-text-stroke: var(--velo-text-stroke-strong) currentColor;
}
</style>
