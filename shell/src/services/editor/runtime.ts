// Load the locale before editor contributions register their labels.
import 'monaco-editor/nls/lang/zh-cn'
import '@vscode/codicons/dist/codicon.css'
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/editor/browser/coreCommands'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/comment/browser/comment'
import 'monaco-editor/editor/contrib/indentation/browser/indentation'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess'
import 'monaco-editor/basic-languages/monaco.contribution'
import { createTokenizationSupport } from 'monaco-editor/languages/features/json/tokenization.js'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

// Only the generic text worker is used. Language-service entry points are not imported.
globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() }

monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc', '.jsonl'], aliases: ['JSON'] })
monaco.languages.setTokensProvider('json', createTokenizationSupport(true))
monaco.languages.setLanguageConfiguration('json', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }],
})
// Dotfiles are not included in Monaco's shell metadata.
monaco.languages.register({ id: 'shell', filenames: ['.bashrc', '.bash_profile', '.profile', '.zshrc', '.zshenv'], extensions: ['.zsh'], firstLine: '^#!.*\\b(?:ba|z|da|k)?sh\\b' })

export { monaco }
