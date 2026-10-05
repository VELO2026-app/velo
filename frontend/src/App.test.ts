// =============================================================================
// VELO Frontend -- App.vue Entry Gate Tests (FE-39)
// =============================================================================
//
// The unit under test is App.vue's entry gate: the LoadingView splash and the
// stage machine (welcome | onboarding | app) it feeds. Everything the gate
// READS is real -- the pinia auth store with its isAuthenticated /
// onboarding_completed fields. Everything around it is mocked at module
// boundaries:
//   - @/composables/useAuth: initAuth() is the gate's trigger; the test
//     controls when readiness flips, the same seam the real composable
//     resolves after restoreSession()/loginViaTelegram().
//   - App-root side-effect composables (background stabilizer, viewport
//     geometry, keyboard dismiss, role-freshness poll): window/interval
//     plumbing owned by the app root, not part of the gate's contract.
//   - OnboardingView: a four-step carousel with its own test file; a stub
//     that emits `done` keeps this file about the gate, not the carousel.
// The router is a REAL memory-history router (the same navigation state
// machine the shipped createWebHistory build uses -- see UserShell.test.ts),
// so "stage === 'app'" is observable as RouterView rendering the matched
// stub route. WelcomeView/LoadingView/StandaloneStubView stay real: they are
// cheap markup, and their root classes are the gate's observable output.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import App from '@/App.vue'
import { useAuthStore } from '@/stores/auth'
import type { UserResponse } from '@/api/types'

// Shared refs the mocked useAuth() hands to App.vue. Declared in the module
// body and only DEREFERENCED inside the useAuth() closure -- the vi.mock
// factory itself must not touch them (factories run before module bodies,
// closures run during component setup).
const ready = ref(false)
const standalone = ref(false)
const loggingOut = ref(false)
const initAuth = vi.fn()

vi.mock('@/composables/useAuth', async () => {
  const { computed } = await import('vue')
  const { useAuthStore } = await import('@/stores/auth')
  return {
    useAuth: () => ({
      isReady: ready,
      isStandalone: standalone,
      isLoggingOut: loggingOut,
      isAuthenticated: computed(() => useAuthStore().isAuthenticated),
      initAuth,
    }),
  }
})

vi.mock('@/composables/useBackgroundStabilizer', () => ({
  useBackgroundStabilizer: vi.fn(),
}))
vi.mock('@/composables/useViewportGeometry', () => ({
  useViewportGeometry: vi.fn(),
}))
vi.mock('@/composables/useKeyboardDismiss', () => ({
  useKeyboardDismiss: vi.fn(),
}))
vi.mock('@/composables/useRoleFreshness', () => ({
  startRoleFreshnessPoll: vi.fn(),
}))

// OnboardingView is heavy (carousel, timezone step, profile write) and has
// its own test file; the gate only cares that it emits `done`.
vi.mock('@/views/auth/OnboardingView.vue', () => ({
  default: {
    name: 'OnboardingViewStub',
    emits: ['done'],
    template:
      '<button type="button" class="onboarding-stub" @click="$emit(\'done\')">done</button>',
  },
}))

// guards.test.ts-style minimal fixture: the gate reads only isAuthenticated
// (token + user present) and user.onboarding_completed.
function setAuthUser(overrides: Partial<UserResponse> = {}): void {
  const store = useAuthStore()
  store.token = 'tok'
  store.user = {
    id: 'user_1',
    role: 'user',
    first_name: 'Test',
    last_name: null,
    onboarding_completed: true,
    ...overrides,
  } as UserResponse
}

const RouteStub = { template: '<div class="route-stub" />' }

function buildRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'root', component: RouteStub },
      { path: '/user/dashboard', name: 'user-dashboard', component: RouteStub },
    ],
  })
}

let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

async function mountGate(): Promise<VueWrapper> {
  const router = buildRouter()
  wrapper = mount(App, { global: { plugins: [pinia, router] } })
  await router.isReady()
  return wrapper
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  ready.value = false
  standalone.value = false
  loggingOut.value = false
  initAuth.mockReset()
  // Default: a clean auth init -- the promise resolves AFTER flipping
  // readiness, mirroring initAuth()'s own ordering.
  initAuth.mockImplementation(async () => {
    ready.value = true
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('App entry gate (FE-39)', () => {
  it('keeps the splash up while auth has not resolved -- no empty or premature frame', async () => {
    initAuth.mockImplementation(() => new Promise<void>(() => {}))
    setAuthUser()
    const w = await mountGate()

    expect(w.find('.loading').exists()).toBe(true)
    expect(w.find('.welcome').exists()).toBe(false)
    expect(w.find('.route-stub').exists()).toBe(false)
  })

  it('returning user (onboarding_completed) skips Welcome: splash -> app', async () => {
    setAuthUser({ onboarding_completed: true })
    const w = await mountGate()
    await flushPromises()

    expect(w.find('.loading').exists()).toBe(false)
    expect(w.find('.welcome').exists()).toBe(false)
    expect(w.find('.route-stub').exists()).toBe(true)
  })

  it('new user (onboarding_completed=false) still lands on Welcome', async () => {
    setAuthUser({ onboarding_completed: false })
    const w = await mountGate()
    await flushPromises()

    expect(w.find('.welcome').exists()).toBe(true)
    expect(w.find('.route-stub').exists()).toBe(false)
  })

  it('new user path still works end to end: «Войти» -> onboarding -> done -> app', async () => {
    setAuthUser({ onboarding_completed: false })
    const w = await mountGate()
    await flushPromises()

    const enter = w.findAll('button').find((b) => b.text() === 'Войти')
    expect(enter).toBeDefined()
    await enter!.trigger('click')
    await flushPromises()

    const carousel = w.find('.onboarding-stub')
    expect(carousel.exists()).toBe(true)
    await carousel.trigger('click') // emits done
    await flushPromises()

    expect(w.find('.route-stub').exists()).toBe(true)
  })

  it('no session (user null) still shows the standalone stub, never the app', async () => {
    const store = useAuthStore()
    store.token = null
    store.user = null
    const w = await mountGate()
    await flushPromises()

    expect(w.find('.stub').exists()).toBe(true)
    expect(w.find('.route-stub').exists()).toBe(false)
  })
})
