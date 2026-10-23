declare module 'monaco-editor/languages/features/json/tokenization.js' {
  import type { languages } from 'monaco-editor/editor/editor.api'
  export function createTokenizationSupport(supportComments: boolean): languages.TokensProvider
}
