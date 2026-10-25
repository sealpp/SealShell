import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const source = resolve(process.argv[2])
const revision = 'e646868227c3e3a9e3f24277c8c7220be42c0be7'
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== revision) {
  throw new Error('Expected the VS Code 1.143.1 source checkout.')
}
function readTheme(path) {
  const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  return { ...(config.include ? readTheme(resolve(dirname(path), config.include)) : {}), ...config.colors }
}
// Dark defaults used by the theme's color registry when its JSON omits a color.
const defaults = {
  'disabledForeground': '#CCCCCC80',
  'list.activeSelectionBackground': '#04395E',
  'list.activeSelectionForeground': '#FFFFFF',
  'list.inactiveSelectionBackground': '#37373D',
  'list.hoverBackground': '#2A2D2E',
  'menu.foreground': '#CCCCCC',
  'menu.selectionForeground': '#FFFFFF',
  'menu.separatorBackground': '#CCCCCC33',
  'toolbar.hoverBackground': '#5A5D5E50',
  'toolbar.activeBackground': '#63666750',
  'scrollbarSlider.background': '#79797966',
  'scrollbarSlider.hoverBackground': '#646464B3',
  'scrollbarSlider.activeBackground': '#BFBFBF66',
  'widget.shadow': '#0000005C',
  'editorWidget.border': '#454545',
  'editorError.foreground': '#F14C4C',
  'editorWarning.foreground': '#CCA700',
  'testing.iconPassed': '#73C991',
  'tab.unfocusedActiveForeground': '#FFFFFF80',
  'tab.unfocusedInactiveForeground': '#9D9D9D80',
}
const colors = Object.fromEntries(Object.entries({
  ...defaults, ...readTheme(resolve(source, 'extensions/theme-defaults/themes/dark_modern.json')),
}).sort(([a], [b]) => a.localeCompare(b)))
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(resolve(root, 'src/theme'), { recursive: true })
writeFileSync(resolve(root, 'src/theme/dark-modern.json'), JSON.stringify(colors, null, 2) + '\n')
writeFileSync(resolve(root, 'src/styles/dark-modern.css'),
  `/* Generated from Microsoft VS Code 1.143.1 (${revision}). MIT; see theme/NOTICE. */\n:root {\n` +
  Object.entries(colors).map(([key, value]) => `  --vscode-${key.replaceAll('.', '-')}: ${value};`).join('\n') + '\n}\n')
