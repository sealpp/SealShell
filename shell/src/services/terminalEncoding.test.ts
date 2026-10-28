import { describe, expect, it } from 'vitest'
import { ENCODINGS } from './encodings'
import { encodeTerminalInput } from './terminalEncoding'

describe('terminal input encoding', () => {
  it('sends UTF-8 by default and GBK bytes when selected', () => {
    expect([...encodeTerminalInput('中文', undefined)]).toEqual([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87])
    for (const encoding of ['gbk', 'gb2312', 'gb18030']) {
      expect([...encodeTerminalInput('中文', encoding)]).toEqual([0xd6, 0xd0, 0xce, 0xc4])
    }
  })

  it.each(ENCODINGS)('preserves terminal controls with $id', ({ id }) => {
    const input = '\x1b[200~echo hello\x1b[201~\r\x7f\x03\x1b[A'
    expect([...encodeTerminalInput(input, id)]).toEqual([...new TextEncoder().encode(input)])
  })

  it.each([
    ['gbk', '中文'], ['gb2312', '中文'], ['gb18030', '中文𠀀🙂'], ['big5', '繁體中文'],
    ['shift_jis', '日本語'], ['euc-jp', '日本語'], ['euc-kr', '한국어'],
    ['windows-1251', 'Привет'], ['iso-8859-8-i', 'שלום'], ['iso-8859-1', 'café'],
  ])('matches output decoding for %s', (encoding, text) => {
    expect(new TextDecoder(encoding).decode(encodeTerminalInput(text, encoding))).toBe(text)
  })

  it('uses the browser Windows-1252 mapping for ISO-8859-1', () => {
    expect([...encodeTerminalInput('€', 'iso-8859-1')]).toEqual([0x80])
  })
})
