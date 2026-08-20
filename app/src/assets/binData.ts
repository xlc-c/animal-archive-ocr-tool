// 内嵌资源访问层：真正的 base64 数据由构建后脚本以 window.__BIN__ 注入最终 html，
// 避免 36MB 资源文件经过打包器导致内存溢出。
declare global {
  interface Window {
    __BIN__?: { det: string; rec: string; wasm: string; dict: string }
  }
}

const bin = (typeof window !== 'undefined' && window.__BIN__) || { det: '', rec: '', wasm: '', dict: '' }
export const DET_B64 = bin.det
export const REC_B64 = bin.rec
export const WASM_B64 = bin.wasm
export const DICT_TEXT = bin.dict

// ── Worker 线程注入通道 ──────────────────────────────────────────────
// window.__BIN__ 只在主线程存在；OCR Worker 的模型字节由 ocrPool 解码后经
// postMessage(transfer) 送进来，存这里，paddleOcr 初始化时优先取这份。
export interface BinBytes {
  det?: ArrayBuffer
  rec?: ArrayBuffer
  wasm?: Uint8Array
  dict?: string
}
let binBytes: BinBytes | null = null
export function setBinBytes(b: BinBytes): void {
  binBytes = b
}
export function getBinBytes(): BinBytes | null {
  return binBytes
}
