<script setup lang="ts">
import { useId } from 'vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'

defineProps<{ modelValue: boolean; label: string; description?: string; disabled?: boolean }>()
defineEmits<{ 'update:modelValue': [value: boolean] }>()
const id = useId()
</script>

<template>
  <div class="settings-switch-row">
    <label :for="id" class="settings-switch-label">
      <span :id="`${id}-label`">{{ label }}</span>
      <small v-if="description" :id="`${id}-description`">{{ description }}</small>
    </label>
    <div class="settings-switch-actions">
      <slot />
      <SwitchRoot :id="id" class="settings-switch" :model-value="modelValue" :disabled="disabled"
        :aria-labelledby="`${id}-label`" :aria-describedby="description ? `${id}-description` : undefined"
        @update:model-value="$emit('update:modelValue', $event)">
        <SwitchThumb class="settings-switch-thumb" />
      </SwitchRoot>
    </div>
  </div>
</template>
