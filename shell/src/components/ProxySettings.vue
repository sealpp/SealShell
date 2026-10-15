<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { IconPencil, IconPlayerPlay, IconPlus, IconTrash } from '@tabler/icons-vue'
import { store } from '../stores/app'
import { defaultProxy, type ProxyProfile } from '../services/proxy/types'
import { deleteProxyProfile, editProxySource, proxyPassword, proxyReferences } from '../services/proxy/profiles'
import { confirmDialog } from '../services/dialogs'
import { randomId } from '../utils/id'
import type { ProxyConnection } from '../services/transport/types'
import ProxyEditor from './ProxyEditor.vue'
import ProxyTestDialog from './ProxyTestDialog.vue'

const selected = ref<ProxyProfile | null>(null)
const editor = ref<InstanceType<typeof ProxyEditor> | null>(null)
const testing = ref<ProxyConnection | null>(null)
const error = ref('')
const blockedId = ref('')
const references = computed(() => proxyReferences(blockedId.value))
async function flush(): Promise<boolean> { return await editor.value?.flush() ?? true }
async function select(profile: ProxyProfile) {
  if (!await flush()) return
  selected.value = { ...profile }
  error.value = ''
  await nextTick()
  document.getElementById('proxy-name')?.focus()
}
async function add() { await select({ id: randomId(), name: '', ...defaultProxy() }) }
async function remove(profile: ProxyProfile) {
  if (!await flush()) return
  blockedId.value = profile.id
  if (references.value.length) return
  if (!await confirmDialog('删除代理', `删除「${profile.name}」及其保存的凭据？`, { danger: true, confirmLabel: '删除' })) return
  try {
    await deleteProxyProfile(profile.id)
    if (selected.value?.id === profile.id) selected.value = null
    blockedId.value = ''
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
async function test(profile: ProxyProfile) {
  try { testing.value = { ...profile, password: await proxyPassword({ kind: 'saved', id: profile.id }) } }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
watch(() => store.editingProxyId, id => {
  const profile = store.proxies.find(item => item.id === id)
  if (profile) void select(profile)
  store.editingProxyId = ''
}, { immediate: true })
defineExpose({ flush })
</script>

<template>
  <main class="settings-main">
    <div class="settings-heading"><div><h2>代理服务器</h2><p>维护可供多个主机复用的代理，修改后自动保存。</p></div><button type="button" class="settings-reset-all proxy-add" @click="add"><IconPlus :size="15" />添加代理</button></div>
    <div class="proxy-list" aria-label="代理服务器列表">
      <p v-if="!store.proxies.length" class="proxy-empty">尚未添加代理服务器。</p>
      <div v-for="profile in store.proxies" :key="profile.id" class="proxy-row" :class="{ selected: selected?.id === profile.id }">
        <button type="button" class="proxy-row-select" @click="select(profile)"><strong>{{ profile.name }}</strong><span>{{ profile.type === 'http' ? 'HTTP CONNECT' : 'SOCKS5' }} · {{ profile.host }}:{{ profile.port }}</span></button>
        <div class="proxy-row-actions"><button type="button" :aria-label="`编辑 ${profile.name}`" title="编辑" @click="select(profile)"><IconPencil :size="16" /></button><button type="button" :aria-label="`测试 ${profile.name}`" title="测试" @click="test(profile)"><IconPlayerPlay :size="16" /></button><button type="button" :aria-label="`删除 ${profile.name}`" title="删除" @click="remove(profile)"><IconTrash :size="16" /></button></div>
      </div>
    </div>
    <div v-if="references.length" class="proxy-references" role="alert"><p>请先解除以下主机的引用，再删除代理。关闭代理或切换填写方式仍会保留引用。</p><button v-for="host in references" :key="host.id" type="button" class="proxy-text-button" @click="editProxySource({ kind: 'host', id: host.id })">{{ host.name }}</button></div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <ProxyEditor v-if="selected" :key="selected.id" ref="editor" :profile="selected" @test="testing = $event" />
    <ProxyTestDialog v-if="testing" :proxy="testing" @close="testing = null" />
  </main>
</template>
