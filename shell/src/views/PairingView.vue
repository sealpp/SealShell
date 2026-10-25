<script setup lang="ts">
import { ref } from 'vue'
import { store } from '../stores/app'
import { pair } from '../services/ws'
import UiDialog from '../components/UiDialog.vue'

const pin = ref('')
const localError = ref('')

async function submit() {
  localError.value = ''
  store.error = ''
  try {
    await pair(pin.value, { onError: (msg) => { localError.value = msg } })
  } catch {
    return
  }
}

function close() {
  store.pairingModalOpen = false
  localError.value = ''
}
</script>

<template>
  <UiDialog
    :open="true"
    title="配对 Node"
    description="输入 Node 启动时输出的 6 位配对码。"
    width="360px"
    @close="close"
  >
    <div class="form-group">
      <label for="pairing-pin">配对码</label>
      <input
        id="pairing-pin"
        v-model="pin"
        type="text"
        inputmode="numeric"
        maxlength="6"
        pattern="[0-9]*"
        placeholder="000000"
        @keyup.enter="submit"
      />
    </div>
    <p v-if="localError" class="error">{{ localError }}</p>

    <template #actions>
      <button type="button" class="workbench-dialog-button workbench-dialog-button--default" @click="close">取消</button>
      <button type="button" class="workbench-dialog-button workbench-dialog-button--primary" @click="submit">配对</button>
    </template>
  </UiDialog>
</template>

<style scoped>
.form-group {
  margin-bottom: var(--workbench-space-3);
}

.form-group label {
  display: block;
  margin-bottom: var(--workbench-space-1);
  color: var(--workbench-text-muted);
  font-size: 12px;
}

input {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 6px;
  min-height: 26px;
  border: 1px solid var(--workbench-border);
  border-radius: 4px;
  background: var(--workbench-input-bg);
  color: var(--workbench-text);
  font-size: 1.5rem;
  letter-spacing: 0.4rem;
  text-align: center;
}

.error {
  margin: var(--workbench-space-2) 0 0;
  color: var(--workbench-error);
  font-size: 12px;
}
</style>
