<script setup lang="ts">
import { computed, ref } from 'vue'
import UiDialog from './UiDialog.vue'
import UiStatus from './UiStatus.vue'
import { store } from '../stores/app'
import { respondHostKeyApproval } from '../services/hostKey'

const changed = computed(() => store.hostKeyPrompt?.previousFingerprint != null)
const cancelButton = ref<HTMLButtonElement>()

function focusCancel(event: Event) {
  event.preventDefault()
  cancelButton.value?.focus()
}

function respond(accepted: boolean) {
  respondHostKeyApproval(accepted)
}
</script>

<template>
  <UiDialog
    v-if="store.hostKeyPrompt"
    :open="true"
    :title="changed ? '远端主机密钥已变化' : '确认远端主机密钥'"
    :description="changed
      ? '当前主机密钥与已保存记录不一致。请核对新指纹，确认后再更新并连接。'
      : '首次连接此主机，请向服务器管理员核对指纹后再接受。'"
    width="560px"
    @close="respond(false)"
    @open-auto-focus="focusCancel"
  >
    <UiStatus
      v-if="changed"
      class="host-key-warning"
      kind="warning"
      label="这可能由服务器重装或更换密钥引起，也可能意味着连接被冒用。无法确认时请取消连接。"
    />
    <dl class="host-key-details">
      <div>
        <dt>地址</dt>
        <dd>{{ store.hostKeyPrompt.host }}:{{ store.hostKeyPrompt.port }}</dd>
      </div>
      <div v-if="changed">
        <dt>已保存的 SHA-256 指纹</dt>
        <dd class="fingerprint">{{ store.hostKeyPrompt.previousFingerprint }}</dd>
      </div>
      <div>
        <dt>{{ changed ? '当前的 SHA-256 指纹' : 'SHA-256 指纹' }}</dt>
        <dd class="fingerprint">{{ store.hostKeyPrompt.fingerprint }}</dd>
      </div>
    </dl>

    <template #actions>
      <button ref="cancelButton" type="button" class="workbench-dialog-button workbench-dialog-button--default" @click="respond(false)">取消连接</button>
      <button id="host-key-accept" type="button" class="workbench-dialog-button workbench-dialog-button--primary" @click="respond(true)">{{ changed ? '更新并连接' : '接受并保存' }}</button>
    </template>
  </UiDialog>
</template>

<style scoped>
.host-key-warning {
  margin-bottom: var(--workbench-space-4);
}

.host-key-details {
  margin: 0;
  display: grid;
  gap: var(--workbench-space-3);
}

.host-key-details div {
  display: grid;
  gap: var(--workbench-space-1);
}

.host-key-details dt {
  color: var(--workbench-text-muted);
  font-size: 12px;
}

.host-key-details dd {
  margin: 0;
  color: var(--workbench-text-strong);
  word-break: break-all;
}

.fingerprint {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
