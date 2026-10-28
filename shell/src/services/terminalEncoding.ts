import { encode } from '@vscode/iconv-lite-umd'
import { encodingDecoder } from './encodings'

const utf8 = new TextEncoder()

export function encodeTerminalInput(text: string, encoding: string | undefined): Uint8Array {
  const canonical = encodingDecoder(encoding)
  if (canonical === 'utf-8') return utf8.encode(text)
  // The logical and visual Hebrew labels use the same byte encoding.
  // Normalize Buffer slices so Worker transfers cannot include spare capacity.
  return new Uint8Array(encode(text, canonical === 'iso-8859-8-i' ? 'iso-8859-8' : canonical))
}
