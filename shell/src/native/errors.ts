export class NativeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NativeError'
  }
}
