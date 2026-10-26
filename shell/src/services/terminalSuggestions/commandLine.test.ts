import { describe, expect, it } from 'vitest'
import { isShellPrompt } from './commandLine'

describe('visible shell prompts', () => {
  it.each([
    '$ ', '# ', '% ', 'dev@host:~/project$ ', '[root@host ~]# ',
    '(venv) dev@host:~$ ', '❯ ', '➜ ',
    '╰─❯ ', '└──$ ', '  ┗━━ %   ', '╰─ ', '╰─', '└── ',
    '➜  项目 git:(main) ', ' dev  ~/project  ',
  ])('recognizes the input boundary of %j', prompt => {
    expect(isShellPrompt(prompt)).toBe(true)
  })

  it.each([
    '', 'Password: ', '[sudo] password for dev: ', 'Password: $ ',
    '> ', 'quote> ', '╰─> ', '100% ', 'download 100% ',
    '- diff $ ', '+ change $ ', '│ ', '╭── ', '└── file.txt ',
    '╰─Password: ', 'dev@host:~$ git ', '╰─❯ git ',
  ])('leaves non-prompt or already entered text %j unrecognized', prompt => {
    expect(isShellPrompt(prompt)).toBe(false)
  })
})
