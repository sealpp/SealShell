interface LanguageDefinition {
  id: string
  extensions?: readonly string[]
  filenames?: readonly string[]
  firstLine?: string
}

/** Use the bundled language metadata; no project scan or remote language service. */
export function detectEditorLanguage(definitions: readonly LanguageDefinition[], path: string, content: string): string {
  const normalized = /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? path.replace(/\\/g, '/') : path
  const name = normalized.split('/').pop()!.toLowerCase()
  const named = definitions.find(language => language.filenames?.some(filename => filename.toLowerCase() === name))
  if (named) return named.id
  let result = 'plaintext', longest = 0
  for (const language of definitions) {
    for (const extension of language.extensions ?? []) {
      if (extension.length > longest && name.endsWith(extension.toLowerCase())) { result = language.id; longest = extension.length }
    }
  }
  if (longest) return result
  const firstLine = content.slice(0, content.indexOf('\n') < 0 ? undefined : content.indexOf('\n'))
  return definitions.find(language => language.firstLine && new RegExp(language.firstLine).test(firstLine))?.id ?? 'plaintext'
}
