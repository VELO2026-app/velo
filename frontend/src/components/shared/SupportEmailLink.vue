<!--
  VELO Frontend -- SupportEmailLink (FE-251)

  The "no reply? write to <address>" line under the support forms (user and
  master). The address is the brand's: the supportEmail of the skin package's
  brand record (contract 2.2), served as SKIN_SUPPORT_EMAIL. The core build
  and a package without the field have no address -- the line is not shown
  at all, so no instance ever sends mail to another brand's support.

  Usage: <SupportEmailLink />
-->

<template>
  <a v-if="email" class="support-email" :href="`mailto:${email}`">
    {{ t('common.supportEmailHint', { email }) }}
  </a>
</template>

<script setup lang="ts">
import { SKIN_SUPPORT_EMAIL } from 'virtual:skin-brand'
import { t } from '@/locales'

const email = SKIN_SUPPORT_EMAIL
</script>

<style scoped>
.support-email {
  text-align: center;
  font-size: var(--velo-fs-14);
  color: var(--velo-text-secondary);
  text-decoration: none;
}
</style>
