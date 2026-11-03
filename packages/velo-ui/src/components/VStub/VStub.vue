<!--
  @velo/ui -- VStub: the P1 pipeline specimen (FE-116, tz-ui-package.md §3.5)
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  Proves the whole skeleton end-to-end while NO real component has migrated
  yet: the folder-per-component layout, the lib build + dts, vitest, the
  stylelint token gate, the token contract test and Storybook all run
  through this file. It is NOT part of the migration map (§2) and carries no
  product meaning -- delete it in the batch-A PR (P2) that lands the first
  real component folder.

  The style block carries the package law (§3.3/§3.6): values are
  var(--…) tokens ONLY -- no hex, no raw sizes; every token below sits in
  the README contract and in the golden variables.css.
-->
<template>
  <span class="v-stub" data-velo-stub><slot /></span>
</template>

<style scoped>
.v-stub {
  display: inline-flex;
  align-items: center;
  padding: var(--space-2) var(--space-4);
  border: var(--velo-border-width) solid var(--velo-border);
  border-radius: var(--radius-md);
  color: var(--velo-text-primary);
  font-family: var(--font-body);
  font-size: var(--velo-fs-14);
}
</style>
