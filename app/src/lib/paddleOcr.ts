/**
 * PaddleOCR（PP-OCRv4 mobile）浏览器端推理管线。
 * 模型：ch_PP-OCRv4_det_infer.onnx（DB 文本检测）+ ch_PP-OCRv4_rec_infer.onnx（CTC 识别），
 * 运行时：onnxruntime-web（优先 WebGPU，回退 WASM）。
 * 模型文件放在 public/models/，随站点静态分发，浏览器 HTTP 缓存 + Cache API 双缓存。
 */
import * as ort from 'onnxruntime-web/wasm'
// emscripten 工厂模块源码：file:// 下动态 import 被浏览器拦截，
// 以 blob URL 形式提供给 ort（blob 模块脚本不受 file:// 限制）
import factoryMjs from '../assets/ort-factory.mjs?raw'
import { DET_B64, REC_B64, WASM_B64, DICT_TEXT, getBinBytes } from '../assets/binData'
import { classifySexGlyph } from './sexGlyph'

export interface OcrLine {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

/** Worker 里没有 document，用 OffscreenCanvas；主线程用普通 canvas */
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas
export function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  return new OffscreenCanvas(w, h)
}

// wasm 二进制内嵌在 bundle 里：file:// 双击运行时无法发任何请求，
// 通过 env.wasm.wasmBinary 直给字节，运行时不产生任何 .wasm 网络/文件加载。
// 强制单线程：file:// 无 SharedArrayBuffer，且单线程已够快。
ort.env.wasm.numThreads = 1
// 工厂模块里 new URL(wasm文件名, import.meta.url) 在 blob base 下会抛 Invalid URL；
// 把 import.meta.url 替换为固定占位 URL——wasm 字节由 wasmBinary 直给，该 URL 不会被请求
const factoryPatched = factoryMjs.replaceAll('import.meta.url', '"https://ort.local/ort-factory.mjs"')
const factoryUrl = URL.createObjectURL(new Blob([factoryPatched], { type: 'text/javascript' }))
;(ort.env.wasm as { wasmPaths?: unknown }).wasmPaths = { mjs: factoryUrl, wasm: factoryUrl }

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const len = bin.length
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Worker 里 location.href 是 blob: 地址，网页版的相对资源路径会解析失败；
// 由 ocrPool 把主线程的绝对 base URL 传进来兜底（离线版用内嵌字节，不走这里）
let baseOverride: string | null = null
export function setBaseUrl(u: string): void {
  baseOverride = u
}
function assetUrl(p: string): string {
  return baseOverride ? new URL(p, baseOverride).href : `${BASE}${p}`
}

let wasmBytes: Uint8Array | null = null
function ensureWasmBinary() {
  const injected = getBinBytes()?.wasm
  if (injected) {
    // Worker 版：字节由主线程注入
    wasmBytes ??= injected
    ;(ort.env.wasm as { wasmBinary?: Uint8Array }).wasmBinary = wasmBytes
  } else if (WASM_B64) {
    // 离线单文件版：内嵌 wasm 字节
    wasmBytes ??= b64ToBytes(WASM_B64)
    ;(ort.env.wasm as { wasmBinary?: Uint8Array }).wasmBinary = wasmBytes
  } else {
    // 网页版：从 public/ort 加载 wasm 运行时
    ort.env.wasm.wasmPaths = new URL(assetUrl('ort/'), location.href).href
  }
}

// ── DB 检测参数（与 RapidOCR 默认对齐）──────────────────────────────
const DET_LIMIT = 960 // 最长边（mobile det 训练尺度，再大反而掉检）
const DET_THRESH = 0.3 // 概率图二值化阈值
const DET_BOX_THRESH = 0.5 // 框内平均概率下限
const DET_UNCLIP = 1.6 // 框外扩比例
const DET_MIN_AREA = 40 // 过滤噪点连通域
const REC_IMG_H = 48
const REC_MAX_W = 2400

interface Engine {
  det: ort.InferenceSession
  rec: ort.InferenceSession
  keys: string[]
}

let enginePromise: Promise<Engine> | null = null

async function createSession(buf: ArrayBuffer): Promise<ort.InferenceSession> {
  const opts = (ep: string[]): ort.InferenceSession.SessionOptions => ({
    executionProviders: ep,
    graphOptimizationLevel: 'all',
  })
  // 实测 WebGPU 后端（jsep）数值精度不足，DB 概率图掉框严重；固定用 WASM，稳定且够快
  return ort.InferenceSession.create(buf, opts(['wasm']))
}

const BASE = import.meta.env.BASE_URL || './'

/** 经 Cache API 取模型（断网可用），失败退回普通 fetch（HTTP 缓存） */
async function fetchCached(url: string): Promise<ArrayBuffer> {
  try {
    const cache = await caches.open('paddleocr-models-v1')
    const hit = await cache.match(url)
    if (hit) return await hit.arrayBuffer()
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`下载模型失败: ${resp.status}`)
    await cache.put(url, resp.clone())
    return await resp.arrayBuffer()
  } catch {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`下载模型失败: ${resp.status}`)
    return await resp.arrayBuffer()
  }
}

/** 初始化（只跑一次）：加载 det/rec 模型与字典 */
export function initEngine(
  onProgress?: (status: string, progress: number) => void
): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      ensureWasmBinary()
      // 模型字节优先级：Worker 注入 > 离线版内嵌 base64 > 网页版 public/ 拉取
      const injected = getBinBytes()
      onProgress?.('加载检测模型', 0.2)
      const detBuf = injected?.det
        ? injected.det
        : DET_B64
          ? (b64ToBytes(DET_B64).buffer as ArrayBuffer)
          : await fetchCached(assetUrl('models/det.onnx'))
      const det = await createSession(detBuf)
      onProgress?.('加载识别模型', 0.6)
      const recBuf = injected?.rec
        ? injected.rec
        : REC_B64
          ? (b64ToBytes(REC_B64).buffer as ArrayBuffer)
          : await fetchCached(assetUrl('models/rec.onnx'))
      const rec = await createSession(recBuf)
      const dictText =
        injected?.dict || DICT_TEXT || (await (await fetch(assetUrl('models/dict.txt'))).text())
      const keys = dictText.split(/\r?\n/).filter((s, i, a) => i < a.length - 1 || s.length > 0)
      return { det, rec, keys }
    })()
    enginePromise.catch(() => {
      enginePromise = null // 失败后允许重试
    })
  }
  return enginePromise
}

// ── 图像预处理 ──────────────────────────────────────────────────────

function canvasToCHW(
  canvas: AnyCanvas,
  normalize: (v: number) => number
): { data: Float32Array; w: number; h: number } {
  const ctx = canvas.getContext('2d')!
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const n = canvas.width * canvas.height
  const data = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    data[i] = normalize(img[i * 4])
    data[n + i] = normalize(img[i * 4 + 1])
    data[2 * n + i] = normalize(img[i * 4 + 2])
  }
  return { data, w: canvas.width, h: canvas.height }
}

/** det 预处理：最长边限 960，边长取 32 倍数，ImageNet 归一化 */
function detPreprocess(src: AnyCanvas) {
  const scale = Math.min(1, DET_LIMIT / Math.max(src.width, src.height))
  let w = Math.round((src.width * scale) / 32) * 32
  let h = Math.round((src.height * scale) / 32) * 32
  w = Math.max(32, w)
  h = Math.max(32, h)
  const canvas = makeCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(src, 0, 0, w, h)
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  const img = ctx.getImageData(0, 0, w, h).data
  const n = w * h
  const data = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    data[i] = (img[i * 4] / 255 - mean[0]) / std[0]
    data[n + i] = (img[i * 4 + 1] / 255 - mean[1]) / std[1]
    data[2 * n + i] = (img[i * 4 + 2] / 255 - mean[2]) / std[2]
  }
  return { data, w, h }
}

// ── DB 后处理：连通域提框（自实现，免 opencv）─────────────────────────

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
  score: number
}

function extractBoxes(prob: Float32Array, w: number, h: number): Box[] {
  // 二值图
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bin[i] = prob[i] > DET_THRESH ? 1 : 0
  const label = new Int32Array(w * h).fill(-1)
  const boxes: Box[] = []
  const stack = new Int32Array(w * h)
  let cur = 0
  for (let s = 0; s < w * h; s++) {
    if (!bin[s] || label[s] >= 0) continue
    // flood fill
    let sp = 0
    stack[sp++] = s
    label[s] = cur
    let x0 = w, y0 = h, x1 = 0, y1 = 0, cnt = 0, sum = 0
    while (sp > 0) {
      const p = stack[--sp]
      const px = p % w
      const py = (p / w) | 0
      cnt++
      sum += prob[p]
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      // 4 邻接
      if (px > 0 && bin[p - 1] && label[p - 1] < 0) { label[p - 1] = cur; stack[sp++] = p - 1 }
      if (px < w - 1 && bin[p + 1] && label[p + 1] < 0) { label[p + 1] = cur; stack[sp++] = p + 1 }
      if (py > 0 && bin[p - w] && label[p - w] < 0) { label[p - w] = cur; stack[sp++] = p - w }
      if (py < h - 1 && bin[p + w] && label[p + w] < 0) { label[p + w] = cur; stack[sp++] = p + w }
    }
    if (cnt < DET_MIN_AREA) { cur++; continue }
    const score = sum / cnt
    if (score < DET_BOX_THRESH) { cur++; continue }
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    // unclip：按 DB 公式 distance = area * ratio / perimeter，轴对齐近似外扩
    const dist = (cnt * DET_UNCLIP) / (2 * (bw + bh))
    boxes.push({
      x0: Math.max(0, x0 - dist),
      y0: Math.max(0, y0 - dist),
      x1: Math.min(w - 1, x1 + dist),
      y1: Math.min(h - 1, y1 + dist),
      score,
    })
    cur++
  }
  // 从上到下、从左到右排序
  boxes.sort((a, b) => (Math.abs(a.y0 - b.y0) < 10 ? a.x0 - b.x0 : a.y0 - b.y0))
  return boxes
}

// ── CTC 解码 ────────────────────────────────────────────────────────

function ctcDecode(probs: Float32Array, t: number, dims: number, keys: string[]) {
  const idxs: number[] = []
  let prev = -1
  let confSum = 0
  let confCnt = 0
  for (let i = 0; i < t; i++) {
    let best = 0
    let bestP = 0
    const off = i * dims
    for (let j = 0; j < dims; j++) {
      const p = probs[off + j]
      if (p > bestP) { bestP = p; best = j }
    }
    if (best !== 0 && best !== prev) {
      idxs.push(best)
      confSum += bestP
      confCnt++
    } else if (best !== 0) {
      confSum += bestP
      confCnt++
    }
    prev = best
  }
  let text = ''
  for (const idx of idxs) {
    // dict.txt 首行是 'blank' 占位，idx 直接对应 keys[idx]（idx0=blank 已在上面滤掉）
    if (idx >= 1 && idx < keys.length && keys[idx] !== 'blank') text += keys[idx]
    // 末尾空格 token 上层会去掉所有空白，这里忽略
  }
  return { text, confidence: confCnt > 0 ? confSum / confCnt : 0 }
}

/**
 * 乱码行判定：表格线/底纹被误检后 rec 会输出重复生僻字（如「涵涵厅涵」「éééé」）。
 * 规则：低置信；或单一字符重复率过半；或符号占比过高。
 */
function isGarbageLine(text: string, conf: number): boolean {
  // 低置信一刀切会误杀英文档案里的纯数字编号行（特殊字体置信度天然偏低），
  // 编号样式（字母数字组合且含数字）的行放行，交给上层提取逻辑把关
  if (conf < 0.55) return !(/^[A-Z0-9][-A-Z0-9]{3,}$/i.test(text) && /\d/.test(text))
  if (text.length >= 3 && !/\d/.test(text)) {
    // 编号类（如 2291242）天然有重复数字，含数字的行跳过重复率判定
    const counts = new Map<string, number>()
    for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    const maxRep = Math.max(...counts.values())
    if (maxRep / text.length > 0.5) return true
  }
  if (text.length >= 6) {
    const word = (text.match(/[0-9A-Za-z一-鿿]/g) ?? []).length
    if (word / text.length < 0.7) return true
  }
  return false
}

// ── 主流程 ──────────────────────────────────────────────────────────

/**
 * 对 canvas 做 OCR（检测 + 识别），返回带坐标的行。
 * 接口与旧 tesseract 版 recognizeCanvas 完全一致。
 */
// 冒烟测试钩子（无头浏览器验证用）；Worker 线程里没有 window
if (typeof window !== 'undefined') {
  ;(window as unknown as { __paddleRecognize?: unknown }).__paddleRecognize = null
}

export async function recognizeCanvasPaddle(
  src: AnyCanvas,
  onProgress?: (status: string, progress: number) => void
): Promise<OcrLine[]> {
  const engine = await initEngine(onProgress)
  // 1) 检测
  const { data, w, h } = detPreprocess(src)
  const detOut = await engine.det.run({
    x: new ort.Tensor('float32', data, [1, 3, h, w]),
  })
  const prob = detOut[Object.keys(detOut)[0]].data as Float32Array
  const boxes = extractBoxes(prob, w, h)
  // 坐标映射回原图
  const sx = src.width / w
  const sy = src.height / h
  const lines: OcrLine[] = []
  // 所有通过尺寸过滤的 det 框（含 rec 读空的）——性别符号格补救要用
  const allRects: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
  // 2) 逐行识别
  for (const b of boxes) {
    // 外扩 8% 白边：rec 训练样本带 padding，贴边裁剪会掉准确率
    const padX = (b.x1 - b.x0) * 0.04
    const padY = (b.y1 - b.y0) * 0.12
    const rx0 = Math.max(0, Math.round((b.x0 - padX) * sx))
    const ry0 = Math.max(0, Math.round((b.y0 - padY) * sy))
    const rx1 = Math.min(src.width, Math.round((b.x1 + padX) * sx))
    const ry1 = Math.min(src.height, Math.round((b.y1 + padY) * sy))
    const rw = Math.max(1, rx1 - rx0)
    const rh = Math.max(1, ry1 - ry0)
    if (rw < 6 || rh < 6) continue
    // 表格线残渣：原图尺度的细条直接跳过（文字行在 300dpi 渲染下 ≥20px 高，表格线框只有几像素）
    if (rh < 20 && rw / rh > 4) continue // 横线
    if (rw < 20 && rh / rw > 4) continue // 竖线
    allRects.push({ x0: rx0, y0: ry0, x1: rx1, y1: ry1 })
    const crop = makeCanvas(Math.min(REC_MAX_W, Math.max(8, Math.round((REC_IMG_H * rw) / rh))), REC_IMG_H)
    const outW = crop.width
    const cctx = crop.getContext('2d')!
    cctx.fillStyle = '#ffffff'
    cctx.fillRect(0, 0, outW, REC_IMG_H)
    cctx.drawImage(src, rx0, ry0, rw, rh, 0, 0, outW, REC_IMG_H)
    const { data: recData } = canvasToCHW(crop, (v) => (v / 255 - 0.5) / 0.5)
    const recOut = await engine.rec.run({
      x: new ort.Tensor('float32', recData, [1, 3, REC_IMG_H, outW]),
    })
    const t0 = recOut[Object.keys(recOut)[0]]
    const [_, t, dims] = t0.dims as unknown as [number, number, number]
    const { text, confidence } = ctcDecode(t0.data as Float32Array, t, dims, engine.keys)
    const clean = text.replace(/\s+/g, '')
    if (!clean) continue
    if (isGarbageLine(clean, confidence)) continue
    lines.push({
      text: clean,
      confidence: confidence * 100, // 对齐 tesseract 的 0~100 置信度
      bbox: { x0: rx0, y0: ry0, x1: rx0 + rw, y1: ry0 + rh },
    })
  }
  // ♀/♂ 性别格补救：rec 字典没有这两个符号（实测 8 页猪档案：7 页整格读空、1 页误读「早」），
  // 对「性别/Sex」标签的右格裁片做像素级分类；判不出就留空，走「待核对」人工补录
  const sexLabelIdx = lines.findIndex((l) =>
    /性别\s*\/?\s*[Ss]ex|[Ss]ex\s*性\s*别|^\s*性\s*别\s*[:：]?\s*$/.test(l.text)
  )
  if (sexLabelIdx >= 0) {
    const lab = lines[sexLabelIdx]
    const cy = (lab.bbox.y0 + lab.bbox.y1) / 2
    const hh = lab.bbox.y1 - lab.bbox.y0
    const cell = allRects
      .filter((r) => r.x0 > lab.bbox.x1 + 10 && Math.abs((r.y0 + r.y1) / 2 - cy) < hh * 0.8)
      .sort((a, b) => a.x0 - b.x0)[0]
    if (cell) {
      // 值格已有干净字母结果（M/F/公/母）则信任文本层；为空或误读（如「早」）才做图像分类
      const existIdx = lines.findIndex(
        (l) =>
          l !== lab &&
          l.bbox.x0 < cell.x1 &&
          l.bbox.x1 > cell.x0 &&
          l.bbox.y0 < cell.y1 &&
          l.bbox.y1 > cell.y0
      )
      const have = existIdx >= 0 ? lines[existIdx].text : ''
      if (!/^[MF公母]$/i.test(have)) {
        const cw = cell.x1 - cell.x0
        const ch = cell.y1 - cell.y0
        const cellCanvas = makeCanvas(cw, ch)
        const cctx2 = cellCanvas.getContext('2d')!
        cctx2.drawImage(src, cell.x0, cell.y0, cw, ch, 0, 0, cw, ch)
        const sym = classifySexGlyph(cctx2.getImageData(0, 0, cw, ch).data, cw, ch)
        if (sym) {
          if (existIdx >= 0) {
            lines[existIdx] = { ...lines[existIdx], text: sym, confidence: 90 }
          } else {
            lines.splice(sexLabelIdx + 1, 0, { text: sym, confidence: 90, bbox: { ...cell } })
          }
        }
      }
    }
  }
  return lines
}

// 冒烟测试钩子：window.__paddleRecognize(canvas) => Promise<OcrLine[]>（Worker 线程里无 window）
if (typeof window !== 'undefined') {
  ;(window as unknown as { __paddleRecognize?: unknown }).__paddleRecognize = recognizeCanvasPaddle
}
