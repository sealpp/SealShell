<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { store, type HostProfile } from '../stores/app'
import { addTab, createHost } from '../services/ws'
import { DEFAULT_ENCODING, ENCODINGS } from '../services/encodings'
import { saveCredentialRecord } from '../services/vault'
import { randomId } from '../utils/id'
import UiDialog from '../components/UiDialog.vue'

const name = ref('')
const address = ref('')
const port = ref(22)
const username = ref('root')
const password = ref('')
const encoding = ref(DEFAULT_ENCODING)
const localError = ref('')
const saving = ref(false)
const nameBlurred = ref(false)
const addressTouched = ref(false)
const syncing = ref(false)

onMounted(init)

watch(() => store.editingHostId, init)

const isNew = computed(() => !store.editingHostId)

const title = computed(() => (isNew.value ? '新建连接' : '编辑主机'))

function init() {
  localError.value = ''
  store.error = ''
  saving.value = false

  const h = store.hosts.find((host) => host.id === store.editingHostId)
  if (h) {
    name.value = h.name
    address.value = h.address
    port.value = h.port
    username.value = h.username
    encoding.value = h.encoding ?? DEFAULT_ENCODING
  } else {
    name.value = ''
    address.value = ''
    port.value = 22
    username.value = 'root'
    encoding.value = DEFAULT_ENCODING
  }
  password.value = ''
  nameBlurred.value = false
  addressTouched.value = false
  syncing.value = false
}

function onNameInput() {
  if (nameBlurred.value || addressTouched.value) return
  if (!syncing.value && address.value === '') {
    syncing.value = true
  }
  if (syncing.value) {
    address.value = name.value
  }
}

function onNameBlur() {
  nameBlurred.value = true
  syncing.value = false
}

function onAddressFocus() {
  addressTouched.value = true
  syncing.value = false
}

function onAddressInput() {
  addressTouched.value = true
  syncing.value = false
}

function hostFromForm(): HostProfile {
  const id = store.editingHostId || randomId()
  return {
    id,
    name: name.value,
    address: address.value,
    port: port.value,
    username: username.value,
    encoding: encoding.value,
    folderId: store.editingHostId
      ? (store.hosts.find((item) => item.id === store.editingHostId)?.folderId ?? null)
      : store.newHostFolderId,
  }
}

function isValid(): boolean {
  if (name.value.trim() === '') {
    localError.value = '名称不能为空'
    return false
  }
  if (address.value.trim() === '') {
    localError.value = '地址不能为空'
    return false
  }
  return true
}

async function saveCredential(id: string) {
  if (!password.value) return
  await saveCredentialRecord(id, { password: password.value })
}

async function saveHost(): Promise<HostProfile | undefined> {
  localError.value = ''
  store.error = ''
  if (!isValid()) return

  saving.value = true
  try {
    const host = hostFromForm()
    await createHost(host)
    store.editingHostId = host.id
    await saveCredential(host.id)

    saving.value = false
    return host
  } catch (reason) {
    saving.value = false
    const message = reason instanceof Error ? reason.message : String(reason)
    localError.value = message
    return undefined
  }
}

async function confirm() {
  const host = await saveHost()
  if (host) close()
}

async function login() {
  const host = await saveHost()
  if (!host) return

  const insertAfterTabId = store.insertAfterTabId
  store.insertAfterTabId = ''
  addTab(host, password.value, insertAfterTabId)
  close()
}

function close() {
  store.connectionModalOpen = false
  store.editingHostId = ''
  store.newHostFolderId = null
  store.insertAfterTabId = ''
  localError.value = ''
  saving.value = false
}
</script>

<template>
  <UiDialog
    :open="true"
    :title="title"
    description="输入 SSH 主机连接信息；凭据会在 PWA 本地加密保存。"
    width="520px"
    @close="close"
  >
    <div class="form-group">
      <label for="host-name">名称</label>
      <input
        id="host-name"
        v-model="name"
        placeholder="名称"
        required
        @input="onNameInput"
        @blur="onNameBlur"
      />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label for="host-address">地址</label>
        <input
          id="host-address"
          v-model="address"
          placeholder="127.0.0.1"
          required
          @focus="onAddressFocus"
          @input="onAddressInput"
        />
      </div>
      <div class="form-group">
        <label for="host-port">端口</label>
        <input id="host-port" v-model.number="port" type="number" placeholder="port" />
      </div>
    </div>
    <div class="form-group">
      <label for="host-username">用户名</label>
      <input id="host-username" v-model="username" placeholder="username" />
    </div>
    <div class="form-group">
      <label for="host-password">密码</label>
      <input id="host-password" v-model="password" type="password" placeholder="password" />
    </div>
    <div class="form-group">
      <label for="host-encoding">编码</label>
      <select id="host-encoding" v-model="encoding">
        <option v-for="item in ENCODINGS" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
    </div>
    <p v-if="localError || store.error" class="error">{{ localError || store.error }}</p>

    <template #actions>
      <button
        type="button"
        class="workbench-dialog-button workbench-dialog-button--default"
        @click="close"
      >
        取消
      </button>
      <button
        type="button"
        class="workbench-dialog-button"
        :disabled="saving"
        @click="confirm"
      >
        {{ saving ? '保存中…' : '确认' }}
      </button>
      <button
        type="button"
        class="workbench-dialog-button workbench-dialog-button--primary"
        :disabled="saving"
        @click="login"
      >
        {{ saving ? '保存中…' : '登录' }}
      </button>
    </template>
  </UiDialog>
</template>

<style scoped>
.form-row {
  display: grid;
  grid-template-columns: 3fr 1fr;
  gap: var(--workbench-space-3);
}

.form-group {
  margin-bottom: var(--workbench-space-3);
}

.form-group label {
  display: block;
  margin-bottom: var(--workbench-space-1);
  color: var(--workbench-text-muted);
  font-size: 12px;
}

input,
select {
  width: 100%;
  box-sizing: border-box;
  padding: var(--workbench-space-2);
  border: 1px solid var(--workbench-border);
  border-radius: 4px;
  background: var(--workbench-input-bg);
  color: var(--workbench-text);
  font-size: 13px;
}

.error {
  margin: 0;
  color: #f87171;
  font-size: 12px;
}
</style>
