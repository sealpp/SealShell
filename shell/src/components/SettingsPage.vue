<script setup lang="ts">
import { useId } from 'vue'

defineProps<{ title: string; description?: string }>()
const headingId = useId()
</script>

<template>
  <section class="settings-main" :aria-labelledby="headingId">
    <header class="settings-heading">
      <div><h2 :id="headingId">{{ title }}</h2><p v-if="description">{{ description }}</p></div>
      <div v-if="$slots.actions" class="settings-heading-actions"><slot name="actions" /></div>
      <div v-if="$slots.status" class="settings-heading-feedback"><slot name="status" /></div>
    </header>
    <slot />
  </section>
</template>
