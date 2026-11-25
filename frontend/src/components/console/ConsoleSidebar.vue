<!--
  VELO Frontend -- ConsoleSidebar (FE-262)

  The web console's left menu: the instance mark, the module groups
  (utils/console/nav.ts -- only the modules this instance has), and at the
  bottom the way back to the user mode and who is signed in. Masters and Moderation carry the live
  counters of the admin stats query (queries/admin.ts); a
  failed load says so once per run of failures.

  Below 1200px (a tablet, a small laptop) the menu folds to an icon rail:
  captions and labels hide, the name stays as the item's tooltip and
  accessible name, a counter sits on the icon. Colours and sizes are skin
  tokens only.
-->

<template>
  <aside class="console-sidebar" data-testid="console-sidebar">
    <div class="console-sidebar__brand">
      <VeloLogo :size="36" />
      <div class="console-sidebar__brand-text console-sidebar__wide-only">
        <span class="console-sidebar__brand-name">{{ t('common.brandName') }}</span>
        <span class="console-sidebar__brand-sub">{{ t('console.brand') }}</span>
      </div>
    </div>

    <nav class="console-sidebar__nav" :aria-label="t('console.navLabel')">
      <div v-for="group in groups" :key="group.key" class="console-sidebar__group">
        <p
          v-if="groupHasCaption(group.key)"
          class="console-sidebar__caption console-sidebar__wide-only"
        >
          {{ t(`console.groups.${group.key}`) }}
        </p>
        <RouterLink
          v-for="module in group.modules"
          :key="module.key"
          :to="{ name: consoleRouteName(module.key) }"
          class="console-sidebar__item"
          :class="{ 'console-sidebar__item--active': module.key === active }"
          :aria-current="module.key === active ? 'page' : undefined"
          :title="t(`console.modules.${module.key}`)"
          :data-testid="`console-nav-${module.key}`"
        >
          <component :is="module.icon" class="console-sidebar__icon" aria-hidden="true" />
          <span class="console-sidebar__label">{{ t(`console.modules.${module.key}`) }}</span>
          <span
            v-if="module.badge && badges[module.badge] > 0"
            class="console-sidebar__count"
            data-testid="console-nav-count"
          >
            {{ badges[module.badge] }}
          </span>
        </RouterLink>
      </div>
    </nav>

    <div class="console-sidebar__footer">
      <button
        type="button"
        class="console-sidebar__item console-sidebar__item--quiet"
        :title="t('console.userMode')"
        data-testid="console-user-mode"
        @click="toUserMode"
      >
        <IconUserMode class="console-sidebar__icon" aria-hidden="true" />
        <span class="console-sidebar__label">{{ t('console.userMode') }}</span>
      </button>
      <div class="console-sidebar__me" :title="meName">
        <VAvatar :name="meName" :url="meAvatar" size="sm" />
        <div class="console-sidebar__me-text console-sidebar__wide-only">
          <span class="console-sidebar__me-name">{{ meName }}</span>
          <span class="console-sidebar__me-role">{{ t('console.role') }}</span>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VAvatar, VeloLogo } from '@/components/ui'
import { IconUserMode } from '@/components/icons'
import { onFailedRequest, useAdminStats } from '@/composables/queries/admin'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { isOptionEnabled } from '@/platform/instance'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import {
  consoleModuleOf,
  consoleRouteName,
  groupHasCaption,
  type ConsoleBadgeSource,
} from '@/utils/console/modules'
import { consoleNavGroups } from '@/utils/console/nav'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const uiStore = useUiStore()
const toast = useToast()

const groups = consoleNavGroups(isOptionEnabled)
const active = computed(() => consoleModuleOf(route.name))

const adminStats = useAdminStats()
const { pendingVerifications, pendingModeration } = adminStats
const badges = computed<Record<ConsoleBadgeSource, number>>(() => ({
  pendingVerifications: pendingVerifications.value,
  pendingModeration: pendingModeration.value,
}))
onFailedRequest(adminStats.query, (error) =>
  toast.error(extractApiError(error, t('storeErrors.admin.dashboard'))),
)

const meName = computed(() => {
  const user = auth.user
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ')
  return name || t('console.role')
})
const meAvatar = computed(() => auth.user?.avatar_url ?? undefined)

// The router sends an admin on a user screen back to the admin zone unless
// the UI mode is «user» (zoneHomeGuard) -- the same switch AdminProfileView
// makes.
function toUserMode(): void {
  uiStore.setUiMode('user')
  void router.push({ name: 'user-dashboard' })
}
</script>

<style scoped>
.console-sidebar {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: var(--space-2);
  width: 248px;
  height: 100%;
  box-sizing: border-box;
  padding: var(--space-5) var(--space-4) var(--space-4);
  overflow: hidden;
  background: var(--velo-glass-white-70);
  border-right: var(--velo-border-width) solid var(--velo-border-light);
}

.console-sidebar__brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-2) var(--space-3);
}

.console-sidebar__brand-text,
.console-sidebar__me-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.console-sidebar__brand-name {
  font-size: var(--velo-fs-20);
  color: var(--velo-text-primary);
  -webkit-text-stroke: var(--velo-text-stroke-strong);
}

.console-sidebar__brand-sub,
.console-sidebar__caption {
  font-size: var(--velo-fs-12);
  /* The menu is glass over the page: page-text ink, as the crumbs. */
  color: var(--velo-text-on-bg-muted);
}

/* On the white card the muted color is under 4.5:1; secondary is the
   skin's declared pair for text on a card. */
.console-sidebar__me-role {
  font-size: var(--velo-fs-12);
  color: var(--velo-text-secondary);
}

.console-sidebar__nav {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-1);
  min-height: 0;
  overflow-y: auto;
  /* A menu taller than the window scrolls; the fade over the last 12px says
     there is more below. The padding keeps a menu that fits clear of it. */
  padding-bottom: var(--space-3);
  mask-image: linear-gradient(to bottom, black calc(100% - var(--space-3)), transparent);
}

.console-sidebar__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-hairline);
}

.console-sidebar__caption {
  margin: 0;
  padding: var(--space-3) var(--space-3) var(--space-1);
}

.console-sidebar__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 36px;
  box-sizing: border-box;
  padding: 0 var(--space-3);
  border: 0;
  border-radius: var(--velo-radius-12);
  background: transparent;
  font: inherit;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  transition: background var(--velo-dur-fast) var(--velo-ease-out);
}

.console-sidebar__item:hover {
  background: var(--velo-bg-subtle);
}

.console-sidebar__item:focus-visible {
  outline: 2px solid var(--velo-primary);
  outline-offset: 2px;
}

.console-sidebar__item--active,
.console-sidebar__item--active:hover {
  background: var(--velo-primary);
  color: var(--velo-on-accent);
}

.console-sidebar__item--quiet {
  color: var(--velo-text-secondary);
}

.console-sidebar__icon {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
}

.console-sidebar__label {
  flex: 1 1 auto;
  min-width: 0;
}

.console-sidebar__count {
  min-width: 20px;
  box-sizing: border-box;
  padding: 0 var(--space-1);
  border-radius: var(--velo-radius-pill);
  background: var(--velo-pink-300);
  font-size: var(--velo-fs-12);
  color: var(--velo-on-accent);
  text-align: center;
}

.console-sidebar__item--active .console-sidebar__count {
  background: var(--velo-on-accent);
  color: var(--velo-primary);
}

.console-sidebar__footer {
  display: flex;
  flex-direction: column;
  gap: var(--space-hairline);
  padding-top: var(--space-2);
  border-top: var(--velo-border-width) solid var(--velo-border-light);
}

.console-sidebar__me {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--velo-bg-card-solid);
}

.console-sidebar__me-name {
  overflow: hidden;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A tablet or a small laptop: the icon rail. */
@media (max-width: 1199px) {
  .console-sidebar {
    width: 72px;
    padding: var(--space-4) var(--space-2);
  }

  .console-sidebar__brand {
    justify-content: center;
    padding: 0 0 var(--space-3);
  }

  .console-sidebar__wide-only,
  .console-sidebar__label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .console-sidebar__group + .console-sidebar__group {
    padding-top: var(--space-2);
    border-top: var(--velo-border-width) solid var(--velo-border-light);
  }

  .console-sidebar__item {
    justify-content: center;
    min-height: 40px;
    padding: 0;
  }

  .console-sidebar__icon {
    width: 20px;
    height: 20px;
  }

  .console-sidebar__count {
    position: absolute;
    top: 0;
    right: 0;
    min-width: 16px;
    font-size: var(--velo-fs-10);
  }

  .console-sidebar__me {
    justify-content: center;
    padding: var(--space-2) 0;
  }
}

/* A laptop window is about 780px tall once the browser chrome is out: the
   twelve modules, the captions and the footer must all show without
   scrolling the menu (an item below the fold is not found). The menu gets
   denser as the window gets lower, three steps. Last in the file, so it wins
   over the icon rail's sizes. */
@media (max-height: 900px) {
  .console-sidebar {
    gap: var(--space-1);
    padding-top: var(--space-4);
  }

  .console-sidebar__brand {
    padding-bottom: var(--space-2);
  }

  .console-sidebar__caption {
    padding-top: var(--space-2);
  }

  .console-sidebar__item {
    min-height: 32px;
  }

  .console-sidebar__footer {
    padding-top: var(--space-1);
  }

  .console-sidebar__me {
    margin-top: var(--space-1);
    padding-top: var(--space-1);
    padding-bottom: var(--space-1);
  }
}

@media (max-height: 820px) {
  .console-sidebar__caption {
    padding-top: var(--space-1);
  }

  .console-sidebar__item {
    min-height: 30px;
  }
}

/* A very low window: the captions give way to the dividers of the icon rail
   (the captions stay for a screen reader). */
@media (max-height: 740px) {
  .console-sidebar__caption {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .console-sidebar__group + .console-sidebar__group {
    padding-top: var(--space-1);
    border-top: var(--velo-border-width) solid var(--velo-border-light);
  }

  .console-sidebar__item {
    min-height: 28px;
  }
}
</style>
