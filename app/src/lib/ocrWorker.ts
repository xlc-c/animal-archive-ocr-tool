/**
 * OCR Worker 线程：在独立线程里跑 pdfjs 渲染 + PaddleOCR 推理。
 * 由 ocrPool 调度；主线程只发 PDF buffer 和页码，收 OCR 行结果。
 *
 * 消息协议（seq 匹配回包）：
 *   → { seq, cmd: 'init' }                                   预热引擎（加载模型）
 *   → { seq, cmd: 'open', docId, buf }                       打开文档（buf 为 transfer）
 *   → { seq, cmd: 'ocr', docId, pageIndex, hd? }             识别一页；hd=true 走顶部高清重试
 *   → { seq, cmd: 'ocrIdCell', docId, pageIndex }            编号格放大重识别（顽固页三级重试）
 *   → { seq, cmd: 'close', docId }                           释放文档
 *   ← { seq, ok: true, pageCount? , lines?, height? } / { seq, ok: false, error }
 */
import {
  openPdfBuffer,
  renderPage,
  renderTopRegion,
  recognizeCanvas,
  textLayerLines,
  ocrIdCell,
  type OpenedPdf,
  type OcrLine,
} from './ocr'
import { initEngine, setBaseUrl } from './paddleOcr'
import { setBinBytes, type BinBytes } from '../assets/binData'

interface WorkerRequest {
  seq: number
  cmd: 'init' | 'open' | 'ocr' | 'close' | 'ocrIdCell'
  docId?: string
  buf?: ArrayBuffer
  pageIndex?: number
  hd?: boolean
  /** init 携带：主线程解码好的模型/wasm 字节（transfer）与绝对 base URL */
  bin?: BinBytes
  baseUrl?: string
}

interface WorkerResponse {
  seq: number
  ok: boolean
  pageCount?: number
  lines?: OcrLine[]
  height?: number
  error?: string
}

// DOM lib 的 self.postMessage 签名是 Window 版（带 targetOrigin），这里换成 Worker 版
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (msg: WorkerResponse) => void
}

const docs = new Map<string, OpenedPdf>()

async function handle(req: WorkerRequest): Promise<Partial<WorkerResponse>> {
  switch (req.cmd) {
    case 'init':
      // 模型字节必须先于 initEngine 注入；同步执行，后续 ocr 消息会汇入同一个 enginePromise
      if (req.bin) setBinBytes(req.bin)
      if (req.baseUrl) setBaseUrl(req.baseUrl)
      await initEngine()
      return {}
    case 'open': {
      const opened = await openPdfBuffer(req.buf!)
      docs.set(req.docId!, opened)
      return { pageCount: opened.pageCount }
    }
    case 'ocr': {
      const opened = docs.get(req.docId!)
      if (!opened) throw new Error('文档未打开')
      // 原生文字层直通：非扫描页免渲染免 OCR；文字太少判定为扫描件，走图像管线
      if (!req.hd) {
        const page = await opened.doc.getPage(req.pageIndex! + 1)
        const tl = await textLayerLines(page)
        if (tl) return { lines: tl.lines, height: tl.height }
      }
      const canvas = req.hd
        ? await renderTopRegion(opened.doc, req.pageIndex!)
        : await renderPage(opened.doc, req.pageIndex!)
      const lines = await recognizeCanvas(canvas)
      return { lines, height: canvas.height }
    }
    case 'ocrIdCell': {
      const opened = docs.get(req.docId!)
      if (!opened) throw new Error('文档未打开')
      return await ocrIdCell(opened.doc, req.pageIndex!)
    }
    case 'close': {
      const opened = docs.get(req.docId!)
      docs.delete(req.docId!)
      if (opened) await opened.doc.destroy()
      return {}
    }
  }
}

ctx.onmessage = (e) => {
  const req = e.data
  handle(req).then(
    (res) => ctx.postMessage({ seq: req.seq, ok: true, ...res }),
    (err) =>
      ctx.postMessage({
        seq: req.seq,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
  )
}
