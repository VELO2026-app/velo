<!--
  VELO Frontend -- ConsoleLoading (FE-262)

  The loader of a console screen that has nothing to show yet: a large
  spinner in the middle of the free space.
-->

<template>
  <div class="console-loading"><VLoader size="lg" /></div>
</template>

<script setup lang="ts">
import { VLoader } from '@/components/ui'
</script>

<style scoped>
.console-loading {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}
</style>
