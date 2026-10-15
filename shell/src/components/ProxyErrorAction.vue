<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../stores/app'
import { editProxySource } from '../services/proxy/profiles'
import type { ProxySource } from '../services/proxy/types'
const props = defineProps<{ source?: ProxySource; message: string }>()
const visible = computed(() => props.source && (props.message.includes('代理') || props.message.includes('PROXY_ERROR'))
  && (props.source.kind === 'saved' ? store.proxies : store.hosts).some(item => item.id === props.source!.id))
</script>
<template><button v-if="visible" type="button" class="proxy-text-button" @click="editProxySource(source!)">编辑代理配置</button></template>
