<script lang="ts">
  import { nodeKey } from './mount';

  // プラグインが渡した中身（文字列・要素）を、部品の中に置く。文字列は文字として入る（HTML としては読まない）。
  // 要素は、置き場所の印（<template>）を描いておき、載せ終わったあとに mount.ts が本物の要素と入れ替える
  let { parts }: { parts: readonly (string | Node)[] } = $props();
</script>

{#each parts as p}{#if typeof p === 'string'}{p}{:else}<template data-plugin-node={nodeKey(p)}></template>{/if}{/each}
