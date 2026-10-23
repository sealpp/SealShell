<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { columnSizingFeature, columnResizingFeature, createSortedRowModel, createExpandedRowModel, rowSortingFeature, rowSelectionFeature, rowExpandingFeature, sortFns, tableFeatures, useTable, type ColumnDef, type SortingState, type RowSelectionState, type ExpandedState } from '@tanstack/vue-table'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { ContextMenuContent, ContextMenuItem, ContextMenuPortal, ContextMenuRoot, ContextMenuTrigger, DropdownMenuItem } from 'reka-ui'
import { IconChevronDown, IconChevronRight, IconRefresh, IconX } from '@tabler/icons-vue'
import { store, setBottomPanelActiveTab, type ProcessesTab } from '../stores/app'
import { prepareProcessAction, executeProcessAction, cancelProcessAction, refreshProcesses, retryProcesses, setProcessVisible } from '../services/processes/runtime'
import { processViewRows, processStateLabels, outcomeLabels, type ProcessTreeRow } from '../services/processes/view-model'
import type { ProcessPlan, ProcessRow, ProcessScope, ProcessSignal } from '../services/processes/types'
import UiDialog from '../components/UiDialog.vue'
import UiDropdownMenu from '../components/UiDropdownMenu.vue'
import ProxyErrorAction from '../components/ProxyErrorAction.vue'
import ProcessIcon from '../components/ProcessIcon.vue'

const props = defineProps<{ params: { params: { tabId: string } } }>()
function formatFileSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index = bytes > 0 ? Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))) : 0
  return (bytes / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + units[index]
}
const tab = computed(() => store.tabs.find((item): item is ProcessesTab => item.id === props.params.params.tabId && item.kind === 'process'))
const state = computed(() => tab.value?.processes)
const root = ref<HTMLElement>()
const viewport = ref<HTMLElement>()
const query = ref('')
const tree = ref(false)
const password = ref('')
const sorting = ref<SortingState>([{ id: 'cpu', desc: true }])
const selection = ref<RowSelectionState>({})
const expanded = ref<ExpandedState>({})
const detail = ref<ProcessRow>()
const plan = ref<ProcessPlan>()
const executing = ref(false)
let anchor = ''
let visibility: IntersectionObserver | undefined
const features = tableFeatures({
  columnSizingFeature, columnResizingFeature, rowSortingFeature, rowSelectionFeature, rowExpandingFeature,
  sortedRowModel: createSortedRowModel(), expandedRowModel: createExpandedRowModel(), sortFns,
})
const columns: ColumnDef<typeof features, ProcessTreeRow>[] = [
  { id: 'select', header: '', size: 36, minSize: 36, maxSize: 36, enableResizing: false, enableSorting: false },
  { accessorKey: 'name', header: '进程', size: 190, minSize: 120 },
  { accessorKey: 'pid', header: 'PID', size: 75, minSize: 60 },
  { accessorKey: 'user', header: '用户', size: 95, minSize: 65 },
  { accessorKey: 'cpu', header: 'CPU', size: 85, minSize: 65, sortUndefined: 'last' },
  { accessorKey: 'rss', header: '内存', size: 105, minSize: 80 },
  { accessorKey: 'state', header: '状态', size: 85, minSize: 65 },
  { accessorKey: 'command', header: '命令行', size: 300, minSize: 150 },
]
const data = computed(() => processViewRows(state.value?.rows ?? [], query.value, tree.value))
const table = useTable({
  features, columns, get data() { return data.value },
  getRowId: (row: ProcessTreeRow) => row.key, getSubRows: (row: ProcessTreeRow) => row.children,
  enableSubRowSelection: false, autoResetExpanded: false, columnResizeMode: 'onChange',
  state: {
    get sorting() { return sorting.value },
    get rowSelection() { return selection.value },
    get expanded() { return query.value ? true : expanded.value },
  },
  onSortingChange: value => { sorting.value = typeof value === 'function' ? value(sorting.value) : value },
  onRowSelectionChange: value => { selection.value = typeof value === 'function' ? value(selection.value) : value },
  onExpandedChange: value => { expanded.value = typeof value === 'function' ? value(expanded.value) : value },
})
const rows = computed(() => table.getRowModel().rows)
const virtualizer = useVirtualizer(computed(() => ({
  count: rows.value.length, getScrollElement: () => viewport.value ?? null,
  estimateSize: () => 30, overscan: 8, scrollMargin: 32,
  getItemKey: (index: number) => rows.value[index]?.id ?? index,
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const selectedKeys = computed(() => Object.keys(selection.value).filter(key => selection.value[key]))
const actionDisabled = computed(() => !selectedKeys.value.length || tab.value?.state !== 'online' || !!state.value?.busy)
const detailCurrent = computed(() => state.value?.rows.find(row => row.key === detail.value?.key))
const selectedCount = computed(() => selectedKeys.value.length)
const actions: { title: string; signal: ProcessSignal; scope: ProcessScope }[] = [
  { title: '结束进程', signal: 'TERM', scope: 'selected' },
  { title: '强制结束进程', signal: 'KILL', scope: 'selected' },
  { title: '结束进程树', signal: 'TERM', scope: 'tree' },
  { title: '强制结束进程树', signal: 'KILL', scope: 'tree' },
]
const planTitle = computed(() => actions.find(item => item.signal === plan.value?.signal && item.scope === plan.value?.scope)?.title ?? '确认操作')
function focusPane() { if (tab.value) setBottomPanelActiveTab(tab.value.id, 'processes') }
function select(row: ProcessRow, event: MouseEvent, checkbox = false) {
  const ids = rows.value.map(item => item.id)
  if (event.shiftKey && anchor && ids.includes(anchor)) {
    const a = ids.indexOf(anchor), b = ids.indexOf(row.key)
    const next: RowSelectionState = event.ctrlKey || event.metaKey ? { ...selection.value } : {}
    ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(id => { next[id] = true })
    selection.value = next
  } else if (event.ctrlKey || event.metaKey || checkbox) {
    const next = { ...selection.value }; if (next[row.key]) delete next[row.key]; else next[row.key] = true; selection.value = next
    anchor = row.key
  } else { selection.value = { [row.key]: true }; anchor = row.key }
  detail.value = row
}
function contextRow(row: ProcessRow) {
  if (!selection.value[row.key]) selection.value = { [row.key]: true }
  detail.value = row; anchor = row.key
}
function selectAll(checked: boolean) { selection.value = checked ? Object.fromEntries(rows.value.map(row => [row.id, true])) : {} }
function keyboard(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); selectAll(true); return }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !rows.value.length) return
  event.preventDefault()
  const current = rows.value.findIndex(row => row.id === detail.value?.key)
  const index = Math.min(rows.value.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)))
  const row = rows.value[index].original
  selection.value = { [row.key]: true }; detail.value = row; anchor = row.key
  virtualizer.value.scrollToIndex(index)
}
async function prepare(signal: ProcessSignal, scope: ProcessScope) {
  if (!tab.value || actionDisabled.value) return
  plan.value = await prepareProcessAction(tab.value.id, selectedKeys.value, signal, scope)
}
function closePlan() { if (executing.value) return; plan.value = undefined; if (tab.value) cancelProcessAction(tab.value.id) }
async function execute() {
  if (!tab.value || !plan.value || executing.value) return
  executing.value = true
  try { await executeProcessAction(tab.value.id, plan.value) }
  finally { executing.value = false; plan.value = undefined }
}
function login() { const value = password.value; password.value = ''; if (tab.value) void retryProcesses(tab.value.id, value) }
function display(row: ProcessRow, column: string): string {
  if (column === 'cpu') return row.cpu === null ? '—' : row.cpu.toFixed(1) + '%'
  if (column === 'rss') return formatFileSize(row.rss)
  if (column === 'state') return processStateLabels[row.state] ?? row.state
  return String(row[column as keyof ProcessRow] ?? '')
}
watch(() => state.value?.rows, items => {
  const valid = new Set(items?.map(row => row.key))
  selection.value = Object.fromEntries(Object.entries(selection.value).filter(([id, value]) => value && valid.has(id)))
  const updated = items?.find(row => row.key === detail.value?.key)
  if (updated) detail.value = updated
})
onMounted(() => {
  visibility = new IntersectionObserver(entries => setProcessVisible(props.params.params.tabId, entries.some(entry => entry.isIntersecting)))
  if (root.value) visibility.observe(root.value)
})
onBeforeUnmount(() => {
  visibility?.disconnect()
  setProcessVisible(props.params.params.tabId, false)
  if (plan.value && !executing.value) cancelProcessAction(props.params.params.tabId)
})
</script>

<template>
  <section v-if="tab && state" ref="root" class="process-panel" @pointerdown="focusPane">
    <header class="process-toolbar">
      <span class="process-host" :title="state.username + '@' + state.address + ':' + state.port">{{ tab.label }}</span>
      <input v-model="query" type="search" aria-label="搜索进程" placeholder="搜索进程、PID、用户或命令" />
      <button type="button" :aria-pressed="tree" @click="tree = !tree">{{ tree ? '树视图' : '列表视图' }}</button>
      <button type="button" :disabled="tab.state !== 'online' || state.busy" :aria-pressed="state.paused" @click="state.paused = !state.paused">{{ state.paused ? '继续刷新' : '暂停刷新' }}</button>
      <button type="button" aria-label="刷新进程" title="刷新进程" :disabled="state.loading || state.busy || tab.state !== 'online'" @click="refreshProcesses(tab.id)"><IconRefresh :size="15" /></button>
      <UiDropdownMenu align="end" content-class="command-menu-content">
        <template #trigger><button type="button" :disabled="actionDisabled">结束操作{{ selectedCount ? ' · ' + selectedCount : '' }}</button></template>
        <DropdownMenuItem v-for="action in actions" :key="action.title" class="command-menu-item" @select="prepare(action.signal, action.scope)">{{ action.title }}</DropdownMenuItem>
      </UiDropdownMenu>
    </header>
    <div v-if="state.needsPassword" class="process-connection">
      <form @submit.prevent="login"><label>SSH 密码 <input v-model="password" type="password" autocomplete="current-password" /></label><button type="submit">连接</button></form>
    </div>
    <div v-else-if="state.unsupported" class="process-connection">进程管理仅支持具有 /proc 的 Linux 系统。</div>
    <div v-else-if="tab.state === 'error'" class="process-connection">
      <span role="alert">{{ tab.error }}</span><button type="button" @click="retryProcesses(tab.id)">重新连接</button>
      <ProxyErrorAction :source="tab.proxySource" :message="tab.error" />
    </div>
    <div v-else-if="tab.state === 'connecting'" class="process-connection">正在连接 {{ state.address }}…</div>
    <template v-else>
      <div v-if="state.actionError" class="process-error" role="alert">{{ state.actionError }}</div>
      <details v-if="state.outcomes.length" class="process-results" open>
        <summary>操作结果 · {{ state.outcomes.length }} 项（发送信号后可能仍需等待进程退出）</summary>
        <div class="process-result-list"><div v-for="outcome in state.outcomes" :key="outcome.key" :class="{ failed: ['denied', 'failed', 'changed'].includes(outcome.status) }">
          {{ outcome.name }} · {{ outcome.pid }} — {{ outcomeLabels[outcome.status] }}
        </div></div>
        <button type="button" @click="state.outcomes = []">清除结果</button>
      </details>
      <div class="process-workspace">
        <ContextMenuRoot>
          <ContextMenuTrigger as-child>
            <div ref="viewport" class="process-table-scroll" role="grid" aria-label="进程列表" :aria-rowcount="rows.length + 1" aria-multiselectable="true" tabindex="0" @keydown="keyboard">
              <div class="process-table-head" role="row" :style="{ width: table.getTotalSize() + 'px' }">
                <div v-for="header in table.getHeaderGroups()[0]?.headers" :key="header.id" class="process-cell" role="columnheader" :style="{ width: header.getSize() + 'px' }" :aria-sort="header.column.getIsSorted() === 'desc' ? 'descending' : header.column.getIsSorted() === 'asc' ? 'ascending' : 'none'">
                  <input v-if="header.column.id === 'select'" type="checkbox" aria-label="选择全部可见进程" :checked="!!rows.length && rows.every(row => selection[row.id])" @change="selectAll(($event.target as HTMLInputElement).checked)" />
                  <button v-else type="button" :title="header.column.id === 'cpu' ? '单个逻辑核心 100%，多线程进程可超过 100%' : String(header.column.columnDef.header)" @click="header.column.getToggleSortingHandler()?.($event)">{{ header.column.columnDef.header }}{{ header.column.getIsSorted() === 'desc' ? ' ↓' : header.column.getIsSorted() === 'asc' ? ' ↑' : '' }}</button>
                  <span v-if="header.column.getCanResize()" class="process-column-resizer" role="separator" aria-orientation="vertical" :aria-label="'调整' + header.column.columnDef.header + '列宽'" @mousedown="header.getResizeHandler()($event)" @touchstart="header.getResizeHandler()($event)" />
                </div>
              </div>
              <div class="process-virtual-body" :style="{ height: virtualizer.getTotalSize() + 'px', width: table.getTotalSize() + 'px' }">
                <div v-for="item in virtualRows" :key="String(item.key)" class="process-row" :class="{ selected: selection[rows[item.index].id] }" role="row" :aria-selected="!!selection[rows[item.index].id]" :aria-rowindex="item.index + 2" :data-pid="rows[item.index].original.pid" :style="{ transform: 'translateY(' + (item.start - 32) + 'px)' }"
                  @click="select(rows[item.index].original, $event)" @contextmenu="contextRow(rows[item.index].original)">
                  <div v-for="cell in rows[item.index].getAllCells()" :key="cell.id" class="process-cell" role="gridcell" :style="{ width: cell.column.getSize() + 'px' }">
                    <input v-if="cell.column.id === 'select'" type="checkbox" :aria-label="'选择进程 ' + rows[item.index].original.pid" :checked="!!selection[rows[item.index].id]" @click.stop="select(rows[item.index].original, $event, true)" />
                    <template v-else-if="cell.column.id === 'name'">
                      <span v-if="tree" class="process-indent" :style="{ width: rows[item.index].depth * 14 + 'px' }"></span>
                      <button v-if="tree && rows[item.index].getCanExpand()" type="button" class="process-expand" :aria-label="(rows[item.index].getIsExpanded() ? '收起进程 ' : '展开进程 ') + rows[item.index].original.pid" :aria-expanded="rows[item.index].getIsExpanded()" @click.stop="rows[item.index].toggleExpanded()"><IconChevronDown v-if="rows[item.index].getIsExpanded()" :size="12" /><IconChevronRight v-else :size="12" /></button>
                      <span v-else-if="tree" class="process-tree-spacer" aria-hidden="true"></span>
                      <ProcessIcon :name="rows[item.index].original.name" />
                      <span class="process-text" :title="rows[item.index].original.name">{{ rows[item.index].original.name }}</span>
                    </template>
                    <span v-else class="process-text" :title="display(rows[item.index].original, cell.column.id)">{{ display(rows[item.index].original, cell.column.id) }}</span>
                  </div>
                </div>
              </div>
              <div v-if="!rows.length" class="process-empty">{{ state.loading ? '正在读取进程…' : query ? '没有匹配的进程' : state.sampledAt ? '当前账户没有可见进程' : '等待进程数据…' }}</div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuPortal><ContextMenuContent class="command-menu-content">
            <ContextMenuItem v-for="action in actions" :key="action.title" class="command-menu-item" :disabled="actionDisabled" @select="prepare(action.signal, action.scope)">{{ action.title }}</ContextMenuItem>
          </ContextMenuContent></ContextMenuPortal>
        </ContextMenuRoot>
        <aside v-if="detail" class="process-detail" aria-label="进程详情">
          <header><strong class="process-detail-name"><ProcessIcon :name="detail.name" /><span class="process-text">{{ detail.name }}</span></strong><button type="button" aria-label="关闭进程详情" @click="detail = undefined"><IconX :size="14" /></button></header>
          <p v-if="!detailCurrent" class="process-gone">进程已退出或当前不可见</p>
          <dl><dt>PID / 父 PID</dt><dd>{{ detail.pid }} / {{ detail.ppid }}</dd><dt>用户 / UID</dt><dd>{{ detail.user }} / {{ detail.uid }}</dd>
            <dt>状态</dt><dd>{{ processStateLabels[detail.state] ?? detail.state }}</dd><dt>CPU（单核 100%）</dt><dd>{{ display(detail, 'cpu') }}</dd>
            <dt>常驻内存 RSS</dt><dd>{{ formatFileSize(detail.rss) }}</dd><dt>线程</dt><dd>{{ detail.threads }}</dd>
            <dt>启动时间</dt><dd>{{ new Date(detail.startedAt).toLocaleString() }}</dd><dt>直接子进程</dt><dd>{{ state.rows.filter(row => row.ppid === detail?.pid).map(row => row.pid).join(', ') || '无' }}</dd>
            <dt>完整命令行</dt><dd class="process-command">{{ detail.command }}</dd></dl>
        </aside>
      </div>
      <footer class="process-footer"><span>{{ state.rows.length }} 个进程 · 已选 {{ selectedCount }} 项</span><span>{{ state.busy ? '等待操作完成' : state.paused ? '已暂停刷新' : state.loading ? '正在刷新…' : '每 2 秒刷新' }}</span></footer>
    </template>
    <UiDialog :open="!!plan" :title="planTitle" width="min(640px, 90vw)" description="请核对本次操作的全部进程。确认后逐项发送信号，并分别反馈结果。" :show-close="!executing" @close="closePlan">
      <template v-if="plan">
        <p>{{ tab.label }} · {{ state.username }}@{{ state.address }}:{{ state.port }}</p>
        <p>{{ plan.targets.length }} 个进程{{ plan.scope === 'tree' ? '（包含本次快照中的后代，重叠目标已去重）' : '（仅处理选中的进程）' }}。</p>
        <p v-if="plan.signal === 'KILL'" class="process-danger">强制结束不会等待程序保存数据或清理资源。</p>
        <div class="process-confirm-list"><div v-for="target in plan.targets" :key="target.key"><strong>{{ target.pid }}</strong> {{ target.name }} <span>{{ target.user }}</span></div></div>
      </template>
      <template #actions><button type="button" class="workbench-dialog-button workbench-dialog-button--default" :disabled="executing" @click="closePlan">取消</button><button type="button" class="workbench-dialog-button workbench-dialog-button--danger" :disabled="executing || tab.state !== 'online'" @click="execute">{{ executing ? '正在执行…' : '确认' + planTitle }}</button></template>
    </UiDialog>
  </section>
</template>

<style scoped>
.process-tree-spacer { width: 12px; flex: 0 0 12px; }
.process-detail-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.process-panel{height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;background:#1e1e1e;color:#ccc;font-size:12px}
.process-toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#252526;flex-wrap:wrap;border-bottom:1px solid #333}.process-host{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.process-toolbar input[type=search]{flex:1;min-width:150px}.process-panel input,.process-panel button{font:inherit}.process-panel input{background:#1e1e1e;color:#ddd;border:1px solid #555;padding:4px}.process-panel button{background:#2d2d2d;border:1px solid #444;color:inherit;padding:4px 7px;cursor:pointer}.process-panel button:hover,.process-panel button[aria-pressed=true]{background:#37373d;color:#fff}.process-panel button:disabled{opacity:.45;cursor:default}.process-connection{padding:20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.process-workspace{display:flex;flex:1;min-height:0;min-width:0}.process-table-scroll{position:relative;flex:1;min-width:0;overflow:auto;outline:none}.process-table-head{display:flex;position:sticky;top:0;z-index:2;background:#252526;height:32px;border-bottom:1px solid #444;box-sizing:border-box}.process-cell{position:relative;box-sizing:border-box;flex-shrink:0;display:flex;align-items:center;gap:4px;padding:0 7px;overflow:hidden}.process-cell input[type=checkbox]{width:14px;height:14px;accent-color:#3794ff;flex-shrink:0}.process-cell>button{border:0;background:transparent;padding:0;white-space:nowrap}.process-column-resizer{position:absolute;right:0;top:0;height:100%;width:6px;cursor:col-resize;touch-action:none}.process-column-resizer:hover{background:#3794ff}.process-virtual-body{position:relative;min-width:100%}.process-row{display:flex;position:absolute;left:0;right:0;top:0;height:30px;box-sizing:border-box;border-bottom:1px solid #292929}.process-row:hover{background:#2a2d2e}.process-row.selected{background:#094771;color:#fff}.process-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}.process-indent,.process-expand{flex-shrink:0}.process-empty{padding:22px;text-align:center;color:#888}.process-detail{box-sizing:border-box;width:320px;max-width:46%;min-width:200px;border-left:1px solid #444;overflow:auto;padding:10px 12px;background:#252526}.process-detail header{display:flex;align-items:center;justify-content:space-between;gap:8px}.process-detail header strong{overflow:hidden;text-overflow:ellipsis}.process-detail header button{padding:2px;display:flex}.process-detail dl{margin:12px 0}.process-detail dt{color:#999;margin-top:10px}.process-detail dd{margin:3px 0;color:#ddd;overflow-wrap:anywhere}.process-command{white-space:pre-wrap;font-family:ui-monospace,monospace}.process-footer{display:flex;justify-content:space-between;padding:5px 10px;color:#999;border-top:1px solid #333;font-variant-numeric:tabular-nums}.process-error,.process-gone{padding:7px;color:#f48771}.process-results{padding:6px 10px;border-bottom:1px solid #444}.process-results summary{cursor:pointer}.process-result-list{max-height:95px;overflow:auto;margin:6px 0}.process-result-list .failed,.process-danger{color:#f48771}.process-confirm-list{max-height:35vh;overflow:auto;border:1px solid #444;padding:8px}.process-confirm-list>div{padding:4px}.process-confirm-list strong{display:inline-block;min-width:70px}.process-confirm-list span{color:#999;margin-left:8px}
</style>
