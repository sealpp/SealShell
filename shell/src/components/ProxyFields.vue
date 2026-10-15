<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import type { ProxyDefinition } from '../services/transport/types'

const props = defineProps<{ modelValue: ProxyDefinition; passwordChange?: string | null; savedPassword: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: ProxyDefinition]; 'update:passwordChange': [value: string | null | undefined] }>()
const prefix = useId()
const changingPassword = ref(false)
watch(() => props.savedPassword, saved => { if (!saved) changingPassword.value = true })
function field<K extends keyof ProxyDefinition>(key: K, value: ProxyDefinition[K]) { emit('update:modelValue', { ...props.modelValue, [key]: value }) }
function protocol(event: Event) {
  const type = (event.target as HTMLSelectElement).value as ProxyDefinition['type']
  const oldDefault = props.modelValue.type === 'http' ? 8080 : 1080
  emit('update:modelValue', { ...props.modelValue, type, port: props.modelValue.port === oldDefault ? type === 'http' ? 8080 : 1080 : props.modelValue.port })
}
</script>

<template>
  <div class="proxy-fields">
    <div class="proxy-field">
      <label :for="`${prefix}-type`">代理类型</label>
      <select :id="`${prefix}-type`" :value="modelValue.type" @change="protocol"><option value="http">HTTP CONNECT</option><option value="socks5">SOCKS5</option></select>
    </div>
    <div class="proxy-grid">
      <div class="proxy-field"><label :for="`${prefix}-address`">代理地址</label><input :id="`${prefix}-address`" :value="modelValue.host" placeholder="proxy.example.com" autocomplete="off" @input="field('host', ($event.target as HTMLInputElement).value)"></div>
      <div class="proxy-field"><label :for="`${prefix}-port`">代理端口</label><input :id="`${prefix}-port`" :value="modelValue.port" type="number" min="1" max="65535" @input="field('port', Number(($event.target as HTMLInputElement).value))"></div>
    </div>
    <label class="proxy-toggle"><input type="checkbox" :checked="modelValue.authentication === 'password'" @change="field('authentication', ($event.target as HTMLInputElement).checked ? 'password' : 'none')">需要认证</label>
    <div v-if="modelValue.authentication === 'password'" class="proxy-grid proxy-grid--equal">
      <div class="proxy-field"><label :for="`${prefix}-username`">代理用户名</label><input :id="`${prefix}-username`" :value="modelValue.username" autocomplete="off" @input="field('username', ($event.target as HTMLInputElement).value)"></div>
      <div class="proxy-field">
        <label :for="`${prefix}-password`">代理密码</label>
        <div v-if="savedPassword && !changingPassword && passwordChange === undefined" class="proxy-secret">
          <span>已保存</span><button type="button" @click="changingPassword = true">更换</button><button type="button" @click="emit('update:passwordChange', null); changingPassword = true">清除</button>
        </div>
        <template v-else>
          <input :id="`${prefix}-password`" :value="passwordChange ?? ''" type="password" autocomplete="new-password" :placeholder="savedPassword && passwordChange !== null ? '留空保持已保存密码' : '输入代理密码'" @input="emit('update:passwordChange', ($event.target as HTMLInputElement).value || undefined)">
          <button v-if="savedPassword" type="button" class="proxy-text-button" @click="emit('update:passwordChange', null)">清除已保存密码</button>
        </template>
      </div>
    </div>
  </div>
</template>
