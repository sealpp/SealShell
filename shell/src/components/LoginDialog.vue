<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { store } from '../stores/app'
import { loadCredentialRecord, saveCredentialRecord } from '../services/vault'
import { addTab, reconnectTab } from '../services/ws'
import UiDialog from './UiDialog.vue'

const password = ref('')
const rememberPassword = ref(false)
const localError = ref('')
const saving = ref(false)

const host = () => store.hosts.find((h) => h.id === store.loginDialogHostId)

onMounted(() => {
  password.value = ''
  rememberPassword.value = false
  localError.value = store.loginDialogError
  saving.value = false
})

watch(
  () => store.loginDialogOpen,
  (open) => {
    if (!open) return
    password.value = ''
    rememberPassword.value = false
    localError.value = store.loginDialogError
    saving.value = false
  },
)

async function login() {
  const h = host()
  if (!h) return
  if (!password.value) {
    localError.value = '请输入 SSH 密码'
    return
  }

  localError.value = ''
  store.loginDialogError = ''
  saving.value = true

  try {
    if (rememberPassword.value) {
      await saveCredentialRecord(h.id, { ...await loadCredentialRecord(h.id), password: password.value })
    }
    saving.value = false
  } catch (reason) {
    saving.value = false
    const message = reason instanceof Error ? reason.message : String(reason)
    localError.value = message
    return
  }

  if (store.loginDialogTabId) {
    const tab = store.tabs.find((t) => t.id === store.loginDialogTabId)
    if (!tab) {
      localError.value = 'tab not found'
      return
    }
    reconnectTab(tab, h, password.value, { allowLoginDialog: false })
  } else {
    addTab(h, password.value, store.loginDialogInsertAfterTabId, {
      allowLoginDialog: false,
      initialCwd: store.loginDialogInitialCwd,
    })
  }
}

function close() {
  store.loginDialogOpen = false
  store.loginDialogHostId = ''
  store.loginDialogTabId = ''
  store.loginDialogError = ''
  store.loginDialogInsertAfterTabId = ''
  store.loginDialogInitialCwd = undefined
  password.value = ''
  rememberPassword.value = false
  localError.value = ''
  saving.value = false
}
</script>

<template>
  <UiDialog
    :open="true"
    :title="host() ? `登录到 ${host()!.name || ''}` : '登录'"
    description="输入 SSH 密码以连接。"
    width="420px"
    @close="close"
  >
    <div v-if="host()" class="host-info">
      <div class="info-row">
        <span class="info-label">名称</span>
        <span class="info-value">{{ host()!.name }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">端口</span>
        <span class="info-value">{{ host()!.port }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">用户名</span>
        <span class="info-value">{{ host()!.username }}</span>
      </div>
    </div>
    <div v-else class="error">主机不存在</div>

    <div class="form-group">
      <label for="login-password">密码</label>
      <input
        id="login-password"
        v-model="password"
        type="password"
        placeholder="password"
        @keyup.enter="login"
      />
    </div>

    <div class="form-group remember">
      <label class="checkbox">
        <input v-model="rememberPassword" type="checkbox" />
        <span>记住密码</span>
      </label>
    </div>

    <p v-if="localError || store.loginDialogError" class="error">
      {{ localError || store.loginDialogError }}
    </p>

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
.host-info {
  margin-bottom: var(--workbench-space-3);
  padding: var(--workbench-space-2);
  background: var(--workbench-input-bg, #1e1e1e);
  border-radius: 4px;
  border: 1px solid var(--workbench-border, #333);
}

.info-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  padding: 2px 0;
}

.info-label {
  color: var(--workbench-text-muted, #858585);
}

.info-value {
  color: var(--workbench-text, #cccccc);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
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

.remember {
  margin-bottom: 0;
}

.form-group label.checkbox {
  display: inline-flex;
  align-items: center;
  gap: var(--workbench-space-2);
  color: var(--workbench-text, #cccccc);
  font-size: 13px;
  line-height: 1.25;
  cursor: pointer;
}

.checkbox input {
  appearance: none;
  width: 14px;
  height: 14px;
  margin: 0;
  padding: 0;
  flex-shrink: 0;
  border: 1px solid var(--workbench-border, #555);
  border-radius: 3px;
  background: var(--workbench-input-bg, #1e1e1e);
  cursor: pointer;
}

.checkbox input:checked {
  background: var(--workbench-accent, #4aaaff) url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%20fill%3D%27none%27%20stroke%3D%27%23ffffff%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpolyline%20points%3D%273%208%206%2011%2013%204%27%2F%3E%3C%2Fsvg%3E") center/9px no-repeat;
  border-color: var(--workbench-accent, #4aaaff);
}

.checkbox input:focus {
  outline: none;
  box-shadow: 0 0 0 2px var(--workbench-accent, #4aaaff);
}

.checkbox span {
  line-height: inherit;
}

input {
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
  margin: 0 0 var(--workbench-space-2) 0;
  color: #f87171;
  font-size: 12px;
}
</style>
