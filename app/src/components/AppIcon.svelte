<script lang="ts">
  // icon.svg と同じ形。stroke は currentColor なので文字色で着色される
  let { size = 24 }: { size?: number } = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="m3 17.5-1.065 3.29a1 1 0 001.236 1.168l3.413-.998A10 10 0 103 6.5z" />
</svg>
