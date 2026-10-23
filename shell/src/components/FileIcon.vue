<script setup lang="ts">
import '../assets/file-icons/icons.css'

defineProps<{ icon: string; label: string }>()
</script>

<template>
  <span class="file-icon" :data-file-icon="icon" :title="label" aria-hidden="true" />
</template>

<style scoped>
.file-icon {
  display: inline-block;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  color: inherit;
  background-color: currentColor;
  mask-image: var(--file-icon-mask);
  mask-mode: luminance;
  mask-size: contain;
  mask-position: center;
  mask-repeat: no-repeat;
}
</style>
