import { defineComponent, h } from 'vue'
import '@vscode/codicons/dist/codicon.css'

function codicon(name: string) {
  return defineComponent({
    name: `Codicon-${name}`,
    props: { size: { type: Number, default: 16 } },
    setup: props => () => h('span', {
      class: ['codicon', `codicon-${name}`],
      'aria-hidden': 'true',
      style: { fontSize: `${props.size}px`, width: `${props.size}px`, height: `${props.size}px`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    }),
  })
}

export const IconAlertTriangle = codicon('warning')
export const IconAppWindow = codicon('window')
export const IconArrowBackUp = codicon('arrow-left')
export const IconArrowForwardUp = codicon('arrow-right')
export const IconArrowUp = codicon('arrow-up')
export const IconArrowsUpDown = codicon('arrow-swap')
export const IconChartLine = codicon('dashboard')
export const IconCheck = codicon('check')
export const IconChevronDown = codicon('chevron-down')
export const IconChevronRight = codicon('chevron-right')
export const IconChevronUp = codicon('chevron-up')
export const IconCircleMinus = codicon('circle-slash')
export const IconClock = codicon('history')
export const IconDeviceDesktopPlus = codicon('new-file')
export const IconDeviceFloppy = codicon('save')
export const IconEye = codicon('eye')
export const IconFile = codicon('file')
export const IconFileText = codicon('file-text')
export const IconFocus2 = codicon('target')
export const IconFolder = codicon('folder')
export const IconFolderOpen = codicon('folder-opened')
export const IconLinkOff = codicon('debug-disconnect')
export const IconList = codicon('list-tree')
export const IconLoader2 = codicon('loading')
export const IconMaximize = codicon('chrome-maximize')
export const IconMaximizeOff = codicon('chrome-restore')
export const IconPencil = codicon('edit')
export const IconPlayerPlay = codicon('play')
export const IconPlug = codicon('plug')
export const IconPlus = codicon('add')
export const IconRefresh = codicon('refresh')
export const IconRobot = codicon('robot')
export const IconRotate = codicon('discard')
export const IconSearch = codicon('search')
export const IconSettings = codicon('gear')
export const IconTerminal2 = codicon('terminal')
export const IconTrash = codicon('trash')
export const IconX = codicon('close')
