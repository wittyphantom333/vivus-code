/**
 * bun:ffi shim — stub for native FFI calls.
 * The upstream proxy uses this for prctl() on Linux containers.
 * Not needed for Vivus local usage.
 */

export function dlopen() {
  throw new Error('bun:ffi not available in Vivus build')
}

export function CString() {
  return ''
}

export const ptr = null
export const toBuffer = () => Buffer.alloc(0)
export const toArrayBuffer = () => new ArrayBuffer(0)
