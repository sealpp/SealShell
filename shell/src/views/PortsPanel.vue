<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { setBottomPanelActiveTab, store, type PortsTab } from '../stores/app'
import { addPort, configurePort, removePort, retryPorts, portPreferences } from '../services/ports/runtime'
import { parsePortTarget } from '../services/ports/discovery'
import type { PortRow } from '../services/ports/types'
import ProxyErrorAction from '../components/ProxyErrorAction.vue'

const props = defineProps<{ params: { params: { tabId: string } } }>()
const tab = computed(() => store.tabs.find((item): item is PortsTab => item.id === props.params.params.tabId && item.kind === 'port'))
const adding = ref(false)
const target = ref('')
const targetInput = ref<HTMLInputElement>()
const formError = ref('')
const submitting = ref(false)
const password = ref('')
const editing = ref('')
const portDraft = ref('')
const editErrors = ref<Record<string, string>>({})
const labels = { disabled: '未启用', connecting: '正在连接', active: '正在转发', failed: '转发失败' }
const endpoint = (row: PortRow) => `${row.host.includes(':') ? `[${row.host}]` : row.host}:${row.port}`
const localAddress = (row: PortRow) => `${portPreferences.host}:${row.localPort}`

async function beginAdd() { adding.value = true; await nextTick(); targetInput.value?.focus() }
async function submit() {
  if (!tab.value || submitting.value) return
  formError.value = ''
  try {
    parsePortTarget(target.value)
    submitting.value = true
    await addPort(tab.value.id, target.value)
    target.value = ''; adding.value = false
  } catch (error) { formError.value = error instanceof Error ? error.message : String(error) }
  finally { submitting.value = false }
}
function login() {
  const value = password.value
  password.value = ''
  if (tab.value) void retryPorts(tab.value.id, value)
}
function beginEdit(row: PortRow) { editing.value = row.id; portDraft.value = String(row.localPort); delete editErrors.value[row.id] }
function commitPort(row: PortRow) {
  if (editing.value !== row.id || !tab.value) return
  const value = portDraft.value.trim()
  editing.value = ''
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    editErrors.value[row.id] = '本机端口必须为 1–65535。'
    return
  }
  if (Number(value) !== row.localPort) void configurePort(tab.value.id, row.id, { localPort: Number(value) })
}
async function copy(row: PortRow) {
  try { await navigator.clipboard.writeText(localAddress(row)); delete editErrors.value[row.id] }
  catch { editErrors.value[row.id] = '无法复制，请手工选择本机地址。' }
}
</script>

<template>
  <section v-if="tab" class="ports-panel" :data-tab-id="tab.id" @pointerdown="setBottomPanelActiveTab(tab.id, 'ports')">
    <header class="ports-toolbar">
      <span class="codicon codicon-plug" aria-hidden="true"></span>
      <span class="ports-host" :title="`${tab.ports.username}@${tab.ports.address}:${tab.ports.port}`">{{ tab.ports.username }}@{{ tab.ports.address }}:{{ tab.ports.port }}</span>
      <span class="ports-summary">{{ tab.ports.rows.filter(row => row.status === 'active').length }} 个转发</span>
      <button class="ports-icon-button" aria-label="添加端口转发" title="添加端口转发" @click="beginAdd"><span class="codicon codicon-plus" aria-hidden="true"></span></button>
      <button class="ports-icon-button" aria-label="重新连接端口会话" title="重新连接并重试已勾选的转发" :disabled="tab.state === 'connecting'" @click="retryPorts(tab.id)"><span class="codicon codicon-refresh" aria-hidden="true"></span></button>
      <button class="ports-icon-button" aria-label="端口转发设置" title="端口转发设置" @click="store.settingsSection = 'ports'; store.settingsModalOpen = true"><span class="codicon codicon-settings-gear" aria-hidden="true"></span></button>
    </header>
    <div v-if="tab.error" class="ports-notice error" role="status">{{ tab.error }}<ProxyErrorAction :source="tab.proxySource" :message="tab.error" /></div>
    <form v-if="tab.ports.needsPassword" class="ports-login" @submit.prevent="login">
      <label>SSH 密码 <input v-model="password" type="password" autocomplete="current-password" aria-label="端口转发 SSH 密码" /></label><button type="submit">连接</button>
    </form>
    <div v-else-if="tab.state === 'connecting'" class="ports-notice">正在连接会话…</div>
    <div v-else-if="tab.ports.discovery === 'unsupported'" class="ports-notice">此服务器不支持自动发现，可手工添加端口。</div>
    <div v-else-if="tab.ports.discoveryError && !tab.error" class="ports-notice error">{{ tab.ports.discoveryError }}</div>
    <div v-if="tab.ports.saveError" class="ports-notice error" role="status">{{ tab.ports.saveError }}</div>
    <div class="ports-table-scroll">
      <table class="ports-table" aria-label="端口转发规则">
        <thead><tr><th class="ports-check">启用</th><th>远端地址</th><th>本机端口</th><th>状态</th><th>发现</th><th class="ports-actions"><span class="visually-hidden">操作</span></th></tr></thead>
        <tbody>
          <tr v-for="row in tab.ports.rows" :key="row.id" :data-port-id="row.id" :data-status="row.status">
            <td class="ports-check"><input type="checkbox" :checked="row.enabled" :aria-label="`转发 ${endpoint(row)}`" @change="configurePort(tab.id, row.id, { enabled: ($event.target as HTMLInputElement).checked })" /></td>
            <td class="ports-endpoint" :title="endpoint(row)">{{ endpoint(row) }}</td>
            <td class="ports-local"><div class="ports-local-value"><span :title="localAddress(row)">{{ portPreferences.host }}:</span><input :value="editing === row.id ? portDraft : row.localPort" inputmode="numeric" :aria-label="`${endpoint(row)} 本机端口`"
              @focus="beginEdit(row)" @input="portDraft = ($event.target as HTMLInputElement).value" @blur="commitPort(row)" @keydown.enter.prevent="commitPort(row); ($event.target as HTMLInputElement).blur()" @keydown.esc.prevent="editing = ''; ($event.target as HTMLInputElement).blur()" /></div><span v-if="editErrors[row.id]" class="ports-inline-error">{{ editErrors[row.id] }}</span></td>
            <td><span class="ports-state" :title="row.error || labels[row.status]"><i :class="row.status"></i>{{ labels[row.status] }}</span><div v-if="row.error" class="ports-row-error" :title="row.error">{{ row.error }}</div></td>
            <td class="ports-discovery">{{ row.listening === true ? '正在监听' : row.listening === false ? '未发现监听' : '未确认' }}</td>
            <td class="ports-actions">
              <button v-if="row.enabled && row.status === 'failed'" class="ports-icon-button" aria-label="重试转发" title="重试转发" @click="configurePort(tab.id, row.id, { enabled: true })"><span class="codicon codicon-refresh" aria-hidden="true"></span></button>
              <button class="ports-icon-button" aria-label="复制本机地址" title="复制本机地址" @click="copy(row)"><span class="codicon codicon-copy" aria-hidden="true"></span></button>
              <button v-if="row.configured" class="ports-icon-button" aria-label="删除转发规则" title="删除保存的转发规则" @click="removePort(tab.id, row.id)"><span class="codicon codicon-trash" aria-hidden="true"></span></button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!tab.ports.rows.length && tab.ports.discovery === 'ready'" class="ports-empty">尚未发现监听端口。可手工添加服务器能够访问的地址。</div>
      <form v-if="adding" class="ports-add" @submit.prevent="submit">
        <input ref="targetInput" v-model="target" placeholder="端口或地址:端口，例如 3000" aria-label="新的转发目标" :disabled="submitting" @keydown.esc.prevent="adding = false" />
        <button type="submit" :disabled="submitting">{{ submitting ? '正在开启…' : '转发端口' }}</button><button type="button" @click="adding = false">取消</button>
        <span v-if="formError" class="ports-inline-error" role="alert">{{ formError }}</span>
      </form>
      <button v-else class="ports-add-button" @click="beginAdd"><span class="codicon codicon-plus" aria-hidden="true"></span>添加端口转发</button>
    </div>
  </section>
</template>

<style scoped>
.ports-panel{display:flex;flex-direction:column;height:100%;min-width:0;color:#ccc;background:#1e1e1e;font-size:12px;overflow:hidden}
.ports-toolbar{display:flex;align-items:center;gap:8px;min-height:35px;padding:0 10px;border-bottom:1px solid #333;flex-shrink:0}.ports-host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.ports-summary{color:#999;white-space:nowrap}
.ports-icon-button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;background:transparent;color:#aaa;cursor:pointer;flex-shrink:0}.ports-icon-button:hover:not(:disabled){background:#37373d;color:#fff}.ports-icon-button:disabled{opacity:.4;cursor:default}
.ports-notice{padding:8px 12px;color:#aaa}.ports-notice.error,.ports-inline-error{color:#f48771}.ports-table-scroll{overflow:auto;flex:1;min-height:0;scrollbar-width:thin}.ports-table{width:100%;border-collapse:collapse;table-layout:fixed;min-width:620px}.ports-table th{font-weight:400;color:#aaa;text-align:left;background:#252526;position:sticky;top:0;z-index:1}.ports-table th,.ports-table td{padding:7px 10px;border-bottom:1px solid #2d2d2d;vertical-align:top}.ports-table tbody tr:hover{background:#252526}.ports-table .ports-check{width:36px;text-align:center}.ports-check input{accent-color:#3794ff;cursor:pointer}.ports-table .ports-actions{width:82px;white-space:nowrap;padding:4px}.ports-endpoint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace}.ports-local-value{display:flex;align-items:center;min-width:0;gap:2px;font-family:ui-monospace,monospace}.ports-local-value>span{color:#888}.ports-local input{width:52px;min-width:40px;background:transparent;color:#ccc;border:1px solid transparent;padding:1px 3px;font:inherit;font-family:ui-monospace,monospace}.ports-local input:hover{border-color:#555}.ports-local input:focus{outline:1px solid #3794ff;border-color:transparent;background:#3c3c3c}.ports-state{display:flex;align-items:center;gap:6px;white-space:nowrap}.ports-state i{width:7px;height:7px;border-radius:50%;background:#777;flex-shrink:0}.ports-state i.active{background:#4ec9b0}.ports-state i.connecting{background:#dcdcaa}.ports-state i.failed{background:#f14c4c}.ports-row-error{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px;color:#f48771}.ports-discovery{color:#999;white-space:nowrap}.ports-empty{padding:18px 12px;color:#888}.ports-add{display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px}.ports-add input,.ports-login input{padding:5px 7px;background:#3c3c3c;border:1px solid #555;color:#ddd;font:inherit}.ports-add input{flex:1;min-width:190px}.ports-add button,.ports-login button{background:#0e639c;color:#fff;border:0;padding:5px 10px;cursor:pointer;font:inherit}.ports-add-button{display:flex;align-items:center;gap:6px;margin:10px 12px;padding:3px 0;background:none;border:0;color:#75beff;cursor:pointer;font:inherit}.ports-inline-error{display:block;margin-top:4px;font-size:11px}.ports-login{display:flex;align-items:center;gap:8px;padding:8px 12px}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
</style>
