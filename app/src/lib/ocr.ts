// 使用 legacy 构建：自带新语法 polyfill，兼容旧版浏览器
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
// worker 内联为 blob：file:// 双击运行时无法加载外部 worker 文件
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline'
import {
  recognizeCanvasPaddle,
  initEngine,
  makeCanvas,
  type AnyCanvas,
  type OcrLine,
} from './paddleOcr'

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()

export type { OcrLine }

/** 预热 PaddleOCR 引擎（模型已随站点分发，浏览器缓存后离线可用） */
export async function getWorker(
  onProgress?: (status: string, progress: number) => void
): Promise<unknown> {
  return initEngine(onProgress)
}

export interface OpenedPdf {
  doc: pdfjs.PDFDocumentProxy
  buf: ArrayBuffer
  pageCount: number
}

/** 打开 PDF（多页处理时只开一次） */
export async function openPdf(file: File): Promise<OpenedPdf> {
  const buf = await file.arrayBuffer()
  return openPdfBuffer(buf)
}

/** 从 buffer 打开 PDF（Worker 里只有 buffer，没有 File） */
export async function openPdfBuffer(buf: ArrayBuffer): Promise<OpenedPdf> {
  // pdfjs 会转移（detach）传入的 buffer，给它一份拷贝，原件留给拆分用
  const doc = await pdfjs.getDocument({ data: buf.slice(0) }).promise
  return { doc, buf, pageCount: doc.numPages }
}

/** 渲染指定页（0 起）。长边默认限制 3000px，兼顾小字清晰度与内存；预览可传更小值 */
export async function renderPage(
  doc: pdfjs.PDFDocumentProxy,
  pageIndex: number,
  limit = 3000
): Promise<AnyCanvas> {
  const page = await doc.getPage(pageIndex + 1)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(3.5, limit / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const canvas = makeCanvas(viewport.width, viewport.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // pdfjs 类型签名只认主线程 canvas；OffscreenCanvas 的 2d context 运行时可用，做断言
  await page.render({
    canvasContext: ctx as CanvasRenderingContext2D,
    viewport,
    canvas: canvas as HTMLCanvasElement,
  }).promise
  return canvas
}

/** 把 PDF 首页渲染成 canvas */
export async function renderFirstPage(file: File): Promise<AnyCanvas> {
  const { doc } = await openPdf(file)
  try {
    return await renderPage(doc, 0)
  } finally {
    await doc.destroy()
  }
}

/** Otsu 二值化：盖章、复印发灰的扫描件增强对比度后再识别 */
function binarize(canvas: AnyCanvas): void {
  const ctx = canvas.getContext('2d')!
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  const n = canvas.width * canvas.height
  const gray = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    gray[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000
  }
  const hist = new Array<number>(256).fill(0)
  for (const v of gray) hist[v]++
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let maxVar = 0
  let threshold = 128
  for (let i = 0; i < 256; i++) {
    wB += hist[i]
    if (wB === 0) continue
    const wF = n - wB
    if (wF === 0) break
    sumB += i * hist[i]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) * (mB - mF)
    if (v > maxVar) {
      maxVar = v
      threshold = i
    }
  }
  for (let i = 0; i < n; i++) {
    const v = gray[i] > threshold ? 255 : 0
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * 局部高清重试：以更高分辨率渲染页面，裁出顶部 30%（编号/耳标号所在区域），
 * 二值化后返回。用于整页 OCR 没能认出编号的档案页。
 */
export async function renderTopRegion(
  doc: pdfjs.PDFDocumentProxy,
  pageIndex: number
): Promise<AnyCanvas> {
  const page = await doc.getPage(pageIndex + 1)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(4.5, 4200 / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const full = makeCanvas(viewport.width, viewport.height)
  const ctx = full.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, full.width, full.height)
  await page.render({
    canvasContext: ctx as CanvasRenderingContext2D,
    viewport,
    canvas: full as HTMLCanvasElement,
  }).promise
  const cropH = Math.round(full.height * 0.3)
  const crop = makeCanvas(full.width, cropH)
  const cctx = crop.getContext('2d')!
  cctx.drawImage(full, 0, 0, full.width, cropH, 0, 0, full.width, cropH)
  binarize(crop)
  return crop
}

/**
 * PDF 原生文字层直通：非扫描页（电子单据/原生 PDF）直接取文字层，免渲染免 OCR。
 * 返回 null 表示文字层内容太少（判定为扫描件），调用方回退图像 OCR 管线。
 * bbox 转成与渲染 canvas 一致的自上而下坐标，下游 extractInfo/extractArchiveRow 无感。
 */
export async function textLayerLines(
  page: pdfjs.PDFPageProxy
): Promise<{ lines: OcrLine[]; height: number } | null> {
  const tc = await page.getTextContent()
  interface TextItem {
    str: string
    transform: number[]
    width: number
    height: number
  }
  const items = (tc.items as TextItem[]).filter((it) => it.str.trim())
  const totalChars = items.reduce((s, it) => s + it.str.trim().length, 0)
  if (totalChars < 30) return null // 扫描件或只有页眉页脚水印文字
  const vp = page.getViewport({ scale: 1 })
  // 按基线排序，同一视觉行的片段合并成一行（文字层 item 常是一个个碎片）
  const rows = items
    .map((it) => {
      const x = it.transform[4]
      const yBottom = it.transform[5]
      const h = it.height || Math.abs(it.transform[3]) || 10
      return {
        str: it.str,
        x0: x,
        y0: vp.height - yBottom - h,
        x1: x + it.width,
        y1: vp.height - yBottom,
        h,
      }
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const lines: OcrLine[] = []
  for (const r of rows) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.bbox.y0 - r.y0) < r.h * 0.5 && r.x0 - last.bbox.x1 < r.h * 2) {
      last.text += ' ' + r.str // 空格保持 token 边界，防止粘连误读
      last.bbox.x1 = Math.max(last.bbox.x1, r.x1)
      last.bbox.y0 = Math.min(last.bbox.y0, r.y0)
      last.bbox.y1 = Math.max(last.bbox.y1, r.y1)
    } else {
      lines.push({
        text: r.str,
        confidence: 1,
        bbox: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 },
      })
    }
  }
  return { lines, height: vp.height }
}

/**
 * 编号格放大重识别：顶部高清渲染后定位编号标签行，把「标签右侧带」和「标签下方带」
 * 裁出放大 2.5 倍再认一次。用于整页+高清重试都认不出编号的顽固页（小字/盖章压字）。
 */
const ID_CELL_LABEL = /耳号|耳标|纹身|TATT[O0]{2}|Ear\s?Tag|猴\s*号|动物\s*编号|芯片\s*号|犬\s*号|原猴/i
export async function ocrIdCell(
  doc: pdfjs.PDFDocumentProxy,
  pageIndex: number
): Promise<{ lines: OcrLine[]; height: number }> {
  const top = await renderTopRegion(doc, pageIndex)
  const lines = await recognizeCanvas(top)
  const lab = lines.find((l) => ID_CELL_LABEL.test(l.text))
  if (!lab) return { lines: [], height: top.height }
  const h = lab.bbox.y1 - lab.bbox.y0
  const cy = (lab.bbox.y0 + lab.bbox.y1) / 2
  // 右带（标签-值同行版式：猪/猴/接收档案）+ 下带（英文表格列头版式：值在列头下方）
  const regions = [
    {
      x0: Math.min(top.width - 8, lab.bbox.x1 + 5),
      y0: Math.max(0, cy - h * 1.3),
      x1: top.width,
      y1: Math.min(top.height, cy + h * 1.3),
    },
    { x0: 0, y0: lab.bbox.y1, x1: top.width, y1: Math.min(top.height, lab.bbox.y1 + h * 3.5) },
  ]
  const out: OcrLine[] = []
  for (const rg of regions) {
    const rw = Math.round(rg.x1 - rg.x0)
    const rh = Math.round(rg.y1 - rg.y0)
    if (rw < 20 || rh < 10) continue
    const zoom = 2.5
    const cell = makeCanvas(Math.round(rw * zoom), Math.round(rh * zoom))
    const cctx = cell.getContext('2d')!
    cctx.fillStyle = '#ffffff'
    cctx.fillRect(0, 0, cell.width, cell.height)
    cctx.drawImage(top, rg.x0, rg.y0, rw, rh, 0, 0, cell.width, cell.height)
    out.push(...(await recognizeCanvas(cell)))
  }
  return { lines: out, height: top.height }
}

/** 对 canvas 做 OCR，返回带坐标的行（PaddleOCR PP-OCRv4 mobile 引擎） */
export async function recognizeCanvas(
  canvas: AnyCanvas,
  onProgress?: (status: string, progress: number) => void
): Promise<OcrLine[]> {
  return recognizeCanvasPaddle(canvas, onProgress)
}

const KEYWORDS = /档案|记录|合格证|报告|发票|证明|通知|登记|协议|合同|清单|收据|凭证|申购|订购|申请|发货/
const CJK = /[一-鿿]/

/** 字段行（含冒号）或纯英文行（双语标题的英文翻译行） */
function isFieldOrEnglish(l: OcrLine): boolean {
  return /[:：]/.test(l.text) || !CJK.test(l.text)
}

/**
 * 从 OCR 行里挑"最像标题"的一行：
 * 字号大、位置靠上加权；含「档案/合格证」等文档类型词加权；
 * 纯英文行、带冒号的字段行降权。
 */
export function extractTitle(lines: OcrLine[], pageHeight: number): string | null {
  if (lines.length === 0) return null
  const topY = Math.min(...lines.map((l) => l.bbox.y0))
  const estW = Math.max(...lines.map((l) => l.bbox.x1)) // 页面宽度估计（左偏加权用）
  let best: OcrLine | null = null
  let bestScore = 0
  for (const l of lines) {
    if (l.text.length < 2) continue
    if (/专用章|公章|印章/.test(l.text)) continue // 印章文字每页都有，不是标题
    const t = l.text.trim()
    // 页码标记（Page 1 / 第 3 页）不是标题
    if (/^(?:Page\s+\d+\b|第\s*\d+\s*页)/i.test(t)) continue
    // 数据行（剥掉数字标点后几乎不剩文字，如「7050001 12-02-25 M 07 …」）不是标题
    if (t.replace(/[\d\s.,:;()#/&'"_-]/g, '').length < 2) continue
    // 含 # 的是列头行（LTR # DOG# SEX …），不是标题
    if (t.includes('#')) continue
    if (!KEYWORDS.test(t)) {
      // 无关键词的短碎片（红章环文残片，如「生物技」）不能当标题候选
      if (t.length < 4) continue
      // 英文正文句子碎片（小写开头，或含小写字母且句号结尾——全大写标题末尾的噪声点不误杀）
      if (!CJK.test(t) && (/^[a-z]/.test(t) || (/[a-z]/.test(t) && /\.$/.test(t)))) continue
    }
    const fontSize = l.bbox.y1 - l.bbox.y0
    const midY = (l.bbox.y0 + l.bbox.y1) / 2 / pageHeight // 0~1
    if (midY > 0.6) continue // 只看页面上半部
    let score = fontSize * (0.5 + (1 - midY))
    if (l.bbox.y0 <= topY + 20) score *= 1.5 // 页面最顶行加权（表格式文档的标题在首行）
    // 左偏加权：顶行里居左的是文档标题，居中的是单位名、居右的是页码
    score *= 1 + 0.3 * (1 - (l.bbox.x0 + l.bbox.x1) / 2 / estW)
    if (KEYWORDS.test(l.text)) score *= 2.5 // 文档类型关键词
    if (!CJK.test(l.text)) score *= 0.45 // 纯英文行
    if (/[:：]/.test(l.text)) score *= 0.35 // 字段标签行
    if (/(?:19|20)\d{2}[-年/.]/.test(l.text) && !KEYWORDS.test(l.text)) score *= 0.6 // 日期行（限定 19xx/20xx 年份，防订单号末尾句点误伤）
    if (l.text.length > 40) score *= 0.6
    if (score > bestScore) {
      bestScore = score
      best = l
    }
  }
  if (!best) return null
  const bestSize = best.bbox.y1 - best.bbox.y0
  const parts = [best.text]
  // 向下合并：紧随其后、字号相近的中文行（双行标题的第二行）
  const below = lines
    .filter((l) => l !== best && l.bbox.y0 > best.bbox.y0)
    .sort((a, b) => a.bbox.y0 - b.bbox.y0)
  let prevBottom = best.bbox.y1
  for (const l of below) {
    const size = l.bbox.y1 - l.bbox.y0
    const gap = l.bbox.y0 - prevBottom
    if (size >= bestSize * 0.7 && gap >= 0 && gap < bestSize * 1.5 && !isFieldOrEnglish(l)) {
      parts.push(l.text)
      prevBottom = l.bbox.y1
    } else {
      break
    }
  }
  // 向上合并：紧邻其上、字号相近的中文行（如标题上方的单位名称）
  const above = lines
    .filter((l) => l !== best && l.bbox.y1 < best.bbox.y0)
    .sort((a, b) => b.bbox.y1 - a.bbox.y1)
  let prevTop = best.bbox.y0
  for (const l of above) {
    const size = l.bbox.y1 - l.bbox.y0
    const gap = prevTop - l.bbox.y1
    if (size >= bestSize * 0.7 && gap >= 0 && gap < bestSize * 1.5 && !isFieldOrEnglish(l)) {
      parts.unshift(l.text)
      prevTop = l.bbox.y0
    } else {
      break
    }
  }
  const title = cleanTitle(parts.join(''))
  // 防假标题：整页都是噪点时（如模糊发货单只识别出 "lo"/"0"），
  // 过短的无关键词串不能当标题，否则文件会被命名成乱码而不是保留原名
  if (!KEYWORDS.test(title) && title.length < 4) return null
  return title
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|]/g, '') // 去掉文件名非法字符
    .replace(/[。．.，,;；:：!！?？~～\-—_]+$/g, '') // 去掉结尾标点
    .trim()
    .slice(0, 60)
}

// ── 物种与编号字段提取 ──────────────────────────────────────────────

const SPECIES_PIG = /猪|巴马|Pig|Swine/i
const SPECIES_MONKEY = /猴|Monkey|Cyno|Macaque/i
const SPECIES_DOG = /犬|比格|Beagle|Dog/i

/** 个体编号标签（按物种优先级），合格证编号只作最后兜底 */
const ID_LABELS = {
  pig: [/耳标?\s*号/, /纹身\s*号?/, /动物\s*编号/],
  monkey: [/原猴\s*号?/, /猴\s*号/, /Monkey'?s?\s*(No|ID)\.?/i, /动物\s*编号/, /耳标?\s*号/, /纹身\s*号?/],
  dog: [/TATT[O0]{2}/i, /Ear\s?Tag/i, /Chip\s?(No|ID|Number)\.?/i, /耳标?\s*号/, /芯片\s*号(?:码)?/, /犬\s*号/, /动物\s*编号/],
  generic: [/动物\s*编号/, /原猴\s*号?/, /猴\s*号/, /Monkey'?s?\s*(No|ID)\.?/i, /TATT[O0]{2}/i, /Ear\s?Tag/i, /耳标?\s*号/, /纹身\s*号?/, /芯片\s*号(?:码)?/],
}
/** 兜底标签：通用「编号」排除「合格证/母亲/父亲/动物/许可证编号」；裸 No./№（省合格证右上角证书号）
 *  排在通用「编号」前——某省合格证同时有「实验单位使用许可证编号」和裸 No.，证书号以 No. 为准 */
const FALLBACK_LABELS = [/合格证\s*编号/, /Certificate\s*No\.?/i, /检疫\s*(?:合格\s*)?证?\s*编号/, /报告\s*编号/, /Report\s*No\.?/i, /流水\s*号/, /发票\s*号(?:码)?/, /Invoice\s*No\.?/i, /(?:^|[\s(（])(?:No|№)\s*[:.:：]?\s*(?=[A-Z0-9]{5,})/i, /^\s*(?:No|№)\s*[.:：]?\s*$/i, /(?<!合格证)(?<!母亲)(?<!父亲)(?<!动物)(?<!许可证)编号/]

/** 去掉标签后面的英文对照（如 /AnimalNumber、/EarTag） */
function stripEnglishLabel(s: string): string {
  let prev = ''
  let cur = s.replace(/^[/\s:：]*/, '')
  while (cur !== prev) {
    prev = cur
    cur = cur.replace(
      /^(Animal|Number|Ear|Tag|Tattoo|Certificate|Quality|No\.?|ID|Code|of|编号|号码)[\s/:：]*/i,
      ''
    )
  }
  return cur
}

/**
 * 清洗编号 token：剥掉粘连的日期/性别尾巴，排除日期片段和乱码。
 * 扫描表格行常被 OCR 粘成一串，如 耳号|7050004|M|12-12-25|父|8958906
 * → "7050004M12-12-258958906"，需要在第一个日期片段处截断，再剥性别标记。
 */
function cleanToken(raw: string): string | null {
  let v = raw
  // 1) 整体就是日期，或含 20xx 年日期段的（如 HER2000-01-001）直接排除
  if (/^\d{1,2}-\d{1,2}-\d{2,4}$/.test(v)) return null
  if (/^\d{4}-\d{1,2}/.test(v)) return null
  if (/20\d{2}[-年/.]\d{1,2}/.test(v)) return null
  // 2) 在嵌入的日期片段处截断（如 7050004M12-12-258958 → 7050004M）
  const dm = v.match(/\d{1,2}-\d{1,2}-\d{2,4}/)
  // 日期片段最多允许前导 1~2 位编号字母/数字（如 1M12-02-25 → 1M → 太短被拒）
  if (dm && dm.index !== undefined && dm.index >= 2) v = v.slice(0, dm.index)
  // 3) 剥尾部粘连的性别标记（数字后的 M/F）
  v = v.replace(/(\d)[MF]$/i, '$1')
  // 4) 剥尾部常见英文标签词（如 B265002SEX → B265002）
  let prev = ''
  while (prev !== v) {
    prev = v
    v = v.replace(/(SEX|GENDER|AGE|DATE|YEAR|MONTH|MALE|FEMALE|TAG)$/i, '')
  }
  // 4.5) 页码/区间片段（如 230-258）不是编号
  if (/^\d+-\d+$/.test(v)) return null
  // 5) 校验：真实编号都含数字；纯字母多半是 OCR 乱码（如 RHEA）
  if (!/\d/.test(v)) return null
  if (v.length < 3) return null
  // 纯数字编号至少 3 位，避免抓到年龄、序号
  if (/^\d+$/.test(v) && v.length < 3) return null
  // 6) 含字母但数字占比不足一半的，是英文碎片（如 1DAM），不是编号
  if (/[A-Za-z]/.test(v) && (v.match(/\d/g) ?? []).length / v.length < 0.5) return null
  return v
}

/** 从某一行里、指定标签之后提取编号值 */
function valueAfterLabel(lineText: string, label: RegExp): string | null {
  const m = lineText.match(label)
  if (!m || m.index === undefined) return null
  let rest = lineText.slice(m.index + m[0].length)
  // 若剩余部分有冒号，值一般在冒号后
  const colonIdx = rest.search(/[:：]/)
  if (colonIdx >= 0 && colonIdx < 20) rest = rest.slice(colonIdx + 1)
  rest = stripEnglishLabel(rest)
  const token = rest.match(/[A-Z0-9][-A-Z0-9]{2,29}/)
  if (!token) return null
  return cleanToken(token[0])
}

export interface ExtractedInfo {
  title: string | null
  species: 'pig' | 'monkey' | 'dog' | null
  animalId: string | null
  /** 编号来源：label=标签行（最可信），filename=原文件名，pool/fallback=补救（低可信） */
  idSource: 'label' | 'filename' | 'pool' | 'fallback' | null
  /** 编号在本页 OCR 行中出现的次数（TATTOO 格 + 页角水印双现 = 2），≥2 视为自证 */
  idEvidence: number
  /** 次级标签候选编号（如猴档案同时有「原猴号 A19xxxxx」和「序号 027」：
      主编号取原猴号时，序号进这里，供 applyRoster top-k 救援交叉验证） */
  idAlts: string[]
  /** 本页所有像编号的 token（用于文档级花名册对齐） */
  idCandidates: string[]
  /** 清单/表格页（页内多主体：同形态编号成簇或同构行重复）：不提取动物编号，分段时强制独立成段 */
  listPage?: boolean
}

/** 从纯文本里提取编号 token（用于右侧相邻单元格） */
function tokenFromText(text: string, allowCjk = false): string | null {
  if (!allowCjk && CJK.test(text)) return null // 值本身是中文（如品种名）则不是编号
  const re = /[A-Z0-9][-A-Z0-9]{2,29}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // 左侧必须是行首或分隔符，避免从英文单词/中文标签中间截断
    if (m.index > 0 && /[A-Za-z0-9一-鿿]/.test(text[m.index - 1])) continue
    const val = cleanToken(m[0])
    if (val) return val
  }
  return null
}

/** 标签行同一水平带上、位于其右侧的行（表格式布局：标签一格、值一格） */
function rightCellValue(lines: OcrLine[], labelLine: OcrLine): string | null {
  const cy = (labelLine.bbox.y0 + labelLine.bbox.y1) / 2
  const h = labelLine.bbox.y1 - labelLine.bbox.y0
  const candidates = lines
    .filter(
      (l) =>
        l !== labelLine &&
        Math.abs((l.bbox.y0 + l.bbox.y1) / 2 - cy) < h * 0.8 &&
        l.bbox.x0 > labelLine.bbox.x0 + 10
    )
    .sort((a, b) => a.bbox.x0 - b.bbox.x0)
  for (const c of candidates) {
    const v = tokenFromText(c.text, true) // 值格可能和下一格标签粘在一起
    if (v) return v
  }
  return null
}

/** 列头标签正下方单元格的编号值（英文档案表：TATTOO 是列头，编号在其下方格子里） */
function belowCellValue(lines: OcrLine[], labelLine: OcrLine): string | null {
  const h = labelLine.bbox.y1 - labelLine.bbox.y0
  const candidates = lines
    .filter((l) => {
      if (l === labelLine) return false
      const gap = l.bbox.y0 - labelLine.bbox.y1
      if (gap < -h * 0.3 || gap > h * 3) return false // 下方 1~3 行高内
      const lcx = (l.bbox.x0 + l.bbox.x1) / 2
      // 中心落在列头水平范围内，或左对齐偏差很小
      return (lcx >= labelLine.bbox.x0 - h && lcx <= labelLine.bbox.x1 + h) ||
        Math.abs(l.bbox.x0 - labelLine.bbox.x0) < h
    })
    .sort((a, b) => a.bbox.y0 - b.bbox.y0)
  for (const c of candidates) {
    const v = tokenFromText(c.text)
    if (v) return v
  }
  return null
}

/** 标签下方数行内的首个编号 token（不限水平位置：检测报告「报告编号：」的值居中写在下一行） */
function belowLineValue(lines: OcrLine[], labelLine: OcrLine): string | null {
  const below = lines
    .filter((l) => l !== labelLine && l.bbox.y0 > labelLine.bbox.y1 - 5)
    .sort((a, b) => a.bbox.y0 - b.bbox.y0)
  for (const l of below.slice(0, 3)) {
    const v = tokenFromText(l.text)
    if (v) return v
  }
  return null
}

/** 原文件名本身长得像动物编号时（如 B265003、Y069001），直接作为编号 */
function idFromFilename(name: string): string | null {
  const base = name.replace(/\.pdf$/i, '').trim()
  if (/^[A-Za-z]?\d{4,}[A-Za-z0-9-]*$/.test(base)) return base.toUpperCase()
  if (/^[A-Za-z][-A-Za-z0-9]{3,14}\d[-A-Za-z0-9]*$/.test(base) && /\d/.test(base)) return base.toUpperCase()
  return null
}

/** 综合提取：标题 + 物种 + 个体编号 */
export function extractInfo(
  lines: OcrLine[],
  pageHeight: number,
  filenameHint?: string
): ExtractedInfo {
  const title = extractTitle(lines, pageHeight)
  const topText = lines
    .filter((l) => (l.bbox.y0 + l.bbox.y1) / 2 / pageHeight < 0.5)
    .map((l) => l.text)
    .join('')
  const species: ExtractedInfo['species'] = SPECIES_MONKEY.test(topText)
    ? 'monkey'
    : SPECIES_PIG.test(topText)
      ? 'pig'
      : SPECIES_DOG.test(topText)
        ? 'dog'
        : null
  const labels =
    species === 'pig'
      ? ID_LABELS.pig
      : species === 'monkey'
        ? ID_LABELS.monkey
        : species === 'dog'
          ? ID_LABELS.dog
          : ID_LABELS.generic
  let animalId: string | null = null
  let idSource: ExtractedInfo['idSource'] = null
  // ── 页内结构信号（不依赖标题文字，见交接文档「踩坑 53」）──
  // 人眼分辨「个体档案 vs 清单页」靠的是版面结构而非文字：单主体表单 vs 多主体密表。
  // 对应两个可计算信号：① 页内同形态编号簇大小（多主体检测）；② 同构行重复数（表格签名）。
  // 先收集本页全部编号形态 token：结构判定与文档级花名册共建共用这份数据
  const idCandidates: string[] = []
  for (const l of lines) {
    const v = tokenFromText(l.text, true)
    if (v && !idCandidates.includes(v)) idCandidates.push(v)
  }
  // CTC top-2 候选（编号行的次优解码路径）一并入册：
  // top-1 误读但 top-2 命中花名册时，applyRoster 的组合纠错能救回来
  for (const l of lines) {
    for (const a of l.alts ?? []) {
      const v = tokenFromText(a, true)
      if (v && !idCandidates.includes(v)) idCandidates.push(v)
    }
  }
  // ① 最大同形态（字母前缀#位数）distinct 编号簇
  let idClusterMax = 0
  {
    const clusters = new Map<string, Set<string>>()
    for (const c of idCandidates) {
      const k = idShapeKey(c)
      if (!k) continue
      const s = clusters.get(k) ?? new Set<string>()
      s.add(c.toUpperCase())
      clusters.set(k, s)
      if (s.size > idClusterMax) idClusterMax = s.size
    }
  }
  // ② 同构行重复数（行骨架：数字段→#、字母段→A、中文段→中；剔无数字或过短的骨架防噪声）
  let tableSkeleton = 0
  {
    const skels = new Map<string, number>()
    for (const l of lines) {
      const s = lineSkeleton(l.text)
      if (s.length < 4 || !s.includes('#')) continue
      const n = (skels.get(s) ?? 0) + 1
      skels.set(s, n)
      if (n > tableSkeleton) tableSkeleton = n
    }
  }
  // 1) 按物种优先级的标签：同一行取值，或取右侧相邻单元格
  outer: for (const label of labels) {
    for (const l of lines) {
      const v = valueAfterLabel(l.text, label)
      if (v) {
        animalId = v
        idSource = 'label'
        break outer
      }
      if (label.test(l.text)) {
        const rv = rightCellValue(lines, l) ?? belowCellValue(lines, l)
        if (rv) {
          animalId = rv
          idSource = 'label'
          break outer
        }
      }
    }
  }
  // 标签取值的页内自证强度（编号格+水印双现 = 2）
  const countEvidence = (id: string | null) => {
    const bare = id?.replace(/^No\./i, '')
    return bare ? lines.reduce((n, l) => n + (l.text.includes(bare) ? 1 : 0), 0) : 0
  }
  let idEvidence = countEvidence(animalId)
  // 多主体页（清单/汇总表）：编号簇 ≥5 直接判定；簇 3~4 个时要求同构行 ≥5 佐证
  // （OCR 把大部分编号读烂时簇会缩水，骨架重复是第二信号）。
  // 「单主体签名」豁免：标签编号页内双现自证的页不是清单页——档案页里也可能有
  // 同构表格（疫苗记录行）和父母编号小簇，不能误杀。
  const selfProved = idSource === 'label' && idEvidence >= 2
  const listPage = !selfProved && (idClusterMax >= 5 || (idClusterMax >= 3 && tableSkeleton >= 5))
  // 列头陷阱：标签行其实是表格列头（如「耳号No.ofear」，belowCellValue 取到首行数据）。
  // 簇 ≥4 且值无自证 → 作废（小批次清单页编号簇不满 5 时的补网）
  const columnHeaderTrap = !listPage && idSource === 'label' && idClusterMax >= 4 && idEvidence <= 1
  // 多主体/表格页不信任任何动物编号通道（label/filename/pool）；No. 单据兜底保留
  const noAnimalPage = listPage || columnHeaderTrap
  if (noAnimalPage) {
    animalId = null
    idSource = null
  }
  // 2) 原文件名就是编号时直接采用（比 OCR 补救更可靠，如 1300001、B265003）
  if (!animalId && !noAnimalPage && filenameHint) {
    animalId = idFromFilename(filenameHint)
    if (animalId) idSource = 'filename'
  }
  // 3) 标签模糊时的补救：上半页里的编号候选池
  //    - 混合行（编号格与标签格粘连）只收行首的编号
  //    - 字母+数字组合（如 B265003）优先；犬耳号这类纯数字编号限 5~8 位，排除电话号段
  //    - 左侧有中文标签行的优先（值格特征）；页面顶部优先
  //    - 含 20xx 日期段长的（如合格证号 A202601010002）降权
  // 单据类页面（记录表/发货单/清单等，非档案）没有动物编号，pool 补救只会抓到表单编号
  // 标题可能带 OCR 空格（「检 测 报 告」），剥掉再测文档类别
  const titleFlat = (title ?? '').replace(/\s+/g, '')
  const isFormDoc = !!title && /记录|单据|发货|接收|清单|凭证|发票|申购|订购|申请|装箱/.test(titleFlat) && !/档案/.test(titleFlat)
  // 报告/证明/合格证/检疫类单据：编号走兜底标签（加 No. 前缀才能扛住花名册丢弃），跳过候选池
  const isCertDoc = !!title && /报告|证明|合格证|检疫/.test(titleFlat) && !/档案/.test(titleFlat)
  if (!animalId && !noAnimalPage && !isFormDoc && !isCertDoc) {
    const pool: { v: string; score: number }[] = []
    for (const l of lines) {
      const midY = (l.bbox.y0 + l.bbox.y1) / 2 / pageHeight
      if (midY > 0.5) continue
      let v: string | null = null
      if (!CJK.test(l.text)) {
        v = tokenFromText(l.text)
      } else {
        // 混合行：只收行首编号（冒号后的值视为某个标签的从属值，跳过）
        const m = l.text.match(/^[A-Z0-9][-A-Z0-9]{2,29}/)
        if (m) v = tokenFromText(m[0])
      }
      if (!v || v.length > 14) continue
      const hasLetter = /[A-Z]/i.test(v)
      if (!hasLetter && (v.length < 5 || v.length > 8)) continue
      // 含字母但数字占比不足一半的是英文碎片（如 1DAM），不是编号
      if (hasLetter) {
        const digitCount = (v.match(/\d/g) ?? []).length
        if (digitCount === 0 || digitCount / v.length < 0.5) continue
      }
      const cy = (l.bbox.y0 + l.bbox.y1) / 2
      const h = l.bbox.y1 - l.bbox.y0
      const hasLeftLabel = lines.some(
        (o) =>
          o !== l &&
          CJK.test(o.text) &&
          o.bbox.x1 <= l.bbox.x0 &&
          Math.abs((o.bbox.y0 + o.bbox.y1) / 2 - cy) < h * 1.2
      )
      let score = 0
      if (hasLetter) score += 2
      if (hasLeftLabel) score += 2
      if (midY < 0.2) score += 1
      if (/20\d{2}(0[1-9]|1[0-2])/.test(v)) score -= 2
      pool.push({ v, score })
    }
    pool.sort((a, b) => b.score - a.score)
    if (pool.length > 0) {
      animalId = pool[0].v
      idSource = 'pool'
    }
  }
  // 4) 最后兜底：合格证编号等其他编号（只同一行取）
  //    档案页不用它兜底——整本合集的合格证编号相同，会把不同动物错并成一段
  const isArchive = !!title && /档案|记录/.test(titleFlat)
  if (!animalId && !isArchive && !isFormDoc) {
    outer2: for (const label of FALLBACK_LABELS) {
      for (const l of lines) {
        const v = valueAfterLabel(l.text, label)
        if (v) {
          animalId = `No.${v}` // 单据类编号统一加 No. 前缀（如 No.A202601010001）
          idSource = 'fallback'
          break outer2
        }
        // 标签与值分处不同 OCR 行时：右格 → 正下方格 → 下方数行
        if (label.test(l.text)) {
          const rv = rightCellValue(lines, l) ?? belowCellValue(lines, l) ?? belowLineValue(lines, l)
          if (rv) {
            animalId = `No.${rv}`
            idSource = 'fallback'
            break outer2
          }
        }
      }
    }
  }
  // 5) 检疫证/合格证页顶裸编号（2026-08-21 新增）：证书号印在页顶、无任何标签，
  //    且通常出现两次（条码数字 + 印刷体，如 4600419780 / 1101260850）。
  //    限定 isCertDoc 页面（档案页整本同号会错并动物）；排除手机号；要求页顶 8% 内至少出现一次
  if (!animalId && isCertDoc) {
    const counts = new Map<string, { n: number; top: boolean }>()
    for (const l of lines) {
      const t = l.text.trim()
      const m = /^(?:N[oO]?|№)\s*[:.:：]?\s*(\d{8,20})$/.exec(t) ?? /^(\d{8,20})$/.exec(t)
      if (!m) continue
      const v = m[1]
      if (/^1[3-9]\d{9}$/.test(v)) continue // 手机号（货主/承运人联系电话常出现两次）
      const midY = (l.bbox.y0 + l.bbox.y1) / 2 / pageHeight
      const e = counts.get(v) ?? { n: 0, top: false }
      e.n += 1
      if (midY < 0.08) e.top = true
      counts.set(v, e)
    }
    for (const [v, e] of counts) {
      if (e.n >= 2 && e.top) {
        animalId = `No.${v}`
        idSource = 'fallback'
        break
      }
    }
  }
  // idCandidates 已前移收集（结构信号判定要用）；此处只重算最终编号的页内自证强度
  // （fallback 等后续通道可能改写了 animalId）
  idEvidence = countEvidence(animalId)
  // 次级标签候选：同一页可能有多个编号标签（猴档案：原猴号 A19xxxxx + 序号 027）。
  // 主编号已取其一，其余入 idAlts 供花名册 top-k 救援交叉验证（如序号命中名册时纠正回原序号命名）
  const idAlts: string[] = []
  if (!listPage) {
    const altLabels = [...labels, /序\s*号/]
    for (const label of altLabels) {
      for (const l of lines) {
        let v = valueAfterLabel(l.text, label)
        if (!v && label.test(l.text)) {
          v = rightCellValue(lines, l) ?? belowCellValue(lines, l)
        }
        if (v && v !== animalId && !idAlts.includes(v)) idAlts.push(v)
      }
    }
  }
  return { title, species, animalId, idSource, idEvidence, idAlts, idCandidates, listPage }
}

// ── 文档级「花名册」对齐 ─────────────────────────────────────────────
// 合集里常带一张检测表，按顺序列出所有动物编号（如 B265001~B265005），
// 而后面的档案页顺序与之一致。利用它：
//   1) 模糊纠错：B265004N → B265004（尾巴粘连）
//   2) 丢弃低可信的垃圾编号（pool/fallback 来源且对不上花名册）
//   3) 锚点位置全部一致时，按顺序填补完全糊掉的页（标记 guessed）

export interface RosterPage {
  title?: string
  animalId?: string
  idSource?: string | null
  idCandidates?: string[]
  /** 次级标签候选编号（如猴档案的序号 027，主编号是原猴号时）——top-k 救援交叉验证用 */
  idAlts?: string[]
  /** 编号在页内 OCR 行中出现次数（≥2 = 编号格+水印双现自证），防花名册误纠 */
  idEvidence?: number
  guessed?: boolean
  /** 编号被花名册纠错改过（编辑距离匹配），需人工核对 */
  corrected?: boolean
  /** 编号自证充分但不在花名册里（名册页 OCR 漏读），需人工核对 */
  offRoster?: boolean
  /** 花名册清单页：一页里出现 ≥3 个花名册编号，说明是清单/汇总页，不归属任何单个动物 */
  rosterPage?: boolean
}

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[n]
}

/** 编号形态键：字母前缀#数字位数（同形态成簇判定，extractInfo 清单页检测与花名册共用） */
function idShapeKey(id: string): string | null {
  const m = id.match(/^([A-Z]*)(\d+)$/i)
  return m ? `${m[1].toUpperCase()}#${m[2].length}` : null
}

/** 行结构骨架：数字段→#、字母段→A、中文段→中。同构行重复计数是表格式版面的结构签名 */
function lineSkeleton(t: string): string {
  return t
    .replace(/\s+/g, '')
    .replace(/\d+/g, '#')
    .replace(/[A-Za-z]+/g, 'A')
    .replace(/[一-鿿]+/g, '中')
}

/** 从所有页里找「同前缀+同位数」的最大编号簇（≥5 个才认作花名册）。
 *  字母前缀簇绝对优先：纯数字大簇多为表格测量值（OD 值/体重等）——实测一批猪档案里
 *  抗体检测表的 ~50 个 OD 值簇挤掉了 26 个 B 编号动物名册（见踩坑 53）。
 *  纯数字簇（犬批次 7050001 型）只在没有字母簇 ≥5 时启用。 */
function buildRoster(pages: RosterPage[]): string[] {
  let bestLetter: string[] = []
  let bestDigit: string[] = []
  for (const p of pages) {
    const groups = new Map<string, string[]>()
    for (const c of p.idCandidates ?? []) {
      const k = idShapeKey(c)
      if (!k) continue
      const g = groups.get(k) ?? []
      if (!g.includes(c.toUpperCase())) g.push(c.toUpperCase())
      groups.set(k, g)
    }
    for (const g of groups.values()) {
      if (/[A-Z]/.test(g[0])) {
        if (g.length > bestLetter.length) bestLetter = g
      } else if (g.length > bestDigit.length) {
        bestDigit = g
      }
    }
  }
  if (bestLetter.length >= 5) return bestLetter
  return bestDigit.length >= 5 ? bestDigit : []
}

/** 与花名册对不上的编号：先剥尾巴，再试编辑距离 ≤maxDist 的唯一匹配 */
function fuzzyMatch(id: string, roster: string[], maxDist = 2): string | null {
  const up = id.toUpperCase()
  let v = up
  while (v.length > 3 && !roster.includes(v) && /[A-Z]$/.test(v)) v = v.slice(0, -1)
  if (roster.includes(v)) return v
  const near = roster.filter(
    (r) => Math.abs(r.length - up.length) <= maxDist && editDistance(r, up) <= maxDist
  )
  return near.length === 1 ? near[0] : null
}

/**
 * 文档级修正。直接修改 pages：
 * - animalId 被纠错 / 丢弃 / 顺序推定（guessed=true）
 * - externalRoster：用户在页面上粘贴的编号清单。小批次（<5 只）花名册无法从
 *   页面自举（buildRoster 需 ≥5 个同簇编号），外部清单直接顶替花名册参与纠错/推定
 * - 返回最终花名册规模（含扩充成员），0 = 未建成；供 UI 摘要展示供人工确认
 */
export function applyRoster(pages: RosterPage[], externalRoster?: string[]): number {
  const roster = externalRoster?.length
    ? [...new Set(externalRoster.map((s) => s.toUpperCase()))]
    : buildRoster(pages)
  if (roster.length === 0) return 0
  // 名册扩充（2026-08-21）：名册页本身可能 OCR 漏读某个编号（实测发货清单漏读
  // 8343597/8343830，导致这两只的档案页被"纠错"成相邻编号 8343512/8343083 而合并丢狗）。
  // 标签提取且页内自证 ≥2 次（编号格+水印双现）的编号视为真实动物，直接并入名册：
  // 不再参与纠错/丢弃，也不会被顺序推定覆盖。
  // 限定与名册同形态（同字母前缀+同位数）：猴档案的「原猴号 A19xxxxx」也是标签双现，
  // 但本批工作编号是序号 001-078，形态不同不能入册，否则 top-k 救援（→027）会被跳过
  const keyOf = idShapeKey
  const rosterKey = roster.length > 0 ? keyOf(roster[0]) : null
  const rosterSet = new Set(roster.map((r) => r.toUpperCase()))
  for (const p of pages) {
    if (p.idSource === 'label' && p.animalId && (p.idEvidence ?? 0) >= 2) {
      const k = keyOf(p.animalId)
      if (k && k === rosterKey) rosterSet.add(p.animalId.toUpperCase())
    }
    // 次级标签候选也可能是名册漏读的真实批次序号（实测猴名册页恰好漏读 052/078，
    // 而这两页主编号取了原猴号 A19xxxxx）：标签渠道提取且与名册同形态 → 入册，
    // 让 top-k 救援能把这些页纠正回序号命名
    for (const a of p.idAlts ?? []) {
      const k = keyOf(a)
      if (k && k === rosterKey) rosterSet.add(a.toUpperCase())
    }
  }
  const inRoster = (id?: string) => !!id && rosterSet.has(id.toUpperCase())
  // 0) 花名册清单页检测：候选编号里命中花名册 ≥3 个的页（寄宿费清单/订购单/总清单等），
  //    不属于任何单一动物，标记后由分段逻辑强制独立成段
  for (const p of pages) {
    const hits = new Set(
      (p.idCandidates ?? []).map((c) => c.toUpperCase()).filter((c) => rosterSet.has(c))
    )
    if (hits.size >= 3) {
      p.rosterPage = true
      p.animalId = undefined
      p.guessed = false
    }
  }
  // 1) 纠错与丢弃
  const bare = (id: string) => id.replace(/^No\./i, '') // 单据编号前缀（No.A2026…）不参与花名册比对
  for (const p of pages) {
    if (!p.animalId || inRoster(p.animalId) || inRoster(bare(p.animalId))) continue
    // 纯数字连续编号簇里编辑距离 ≤2 的相邻编号极可能是两只不同动物（8343597→8343512 实测误纠），
    // 只有 1 处差异（单字符错读/多读/漏读）才允许纠错
    const numericDense = /^\d+$/.test(bare(p.animalId))
    const fixed = fuzzyMatch(bare(p.animalId), roster, numericDense ? 1 : 2)
    if (fixed) {
      p.animalId = fixed // 能对上花名册 → 用标准动物编号
      p.corrected = true // 标记纠错，结果列表高亮提示人工核对
      continue
    }
    // CTC top-k × 花名册组合纠错：top-1 误读超编辑距离阈值（或双向都近、判不出唯一）时，
    // 候选池（含 top-2 alt）里若有且仅有一个精确命中花名册的编号 → 采用，标 corrected。
    // 命中 ≥2 个时：若次级标签候选（idAlts，如猴档案序号）与命中的交集唯一，则用交集项
    // （实测 p50 候选池 [027,022] 双命中，但序号标签值就是 027 → 交叉验证救回序号命名）；
    // 否则保持不动（清单页或真串号）。
    if (!/^No\./i.test(p.animalId)) {
      const hits = [
        ...new Set(
          (p.idCandidates ?? []).map((c) => c.toUpperCase()).filter((c) => rosterSet.has(c))
        ),
      ]
      let pick: string | null = hits.length === 1 ? hits[0] : null
      if (!pick && hits.length > 1) {
        const cross = hits.filter((h) => (p.idAlts ?? []).some((a) => a.toUpperCase() === h))
        if (cross.length === 1) pick = cross[0]
      }
      if (pick) {
        p.animalId = pick
        p.corrected = true
        continue
      }
    }
    if (/^No\./i.test(p.animalId)) {
      continue // 合格证/发票等单据编号：本来就不在花名册里，保留
    } else if (p.idSource === 'pool' || p.idSource === 'fallback') {
      p.animalId = undefined // 低可信来源对不上花名册，按未识别处理
    } else if (p.idSource === 'label' && (p.idEvidence ?? 0) >= 1) {
      p.offRoster = true // 标签提取但对不上名册：保留编号，标待核对（绝不并入别只动物）
    }
  }
  // 2) 档案页序列 + 锚点（自身编号在花名册里的档案页）
  const archPages: number[] = []
  pages.forEach((p, i) => {
    if (p.title && /档案/.test(p.title)) archPages.push(i)
  })
  const anchors: { ai: number; ri: number }[] = []
  archPages.forEach((pi, ai) => {
    const id = pages[pi].animalId
    // 只用原始名册成员做锚点：扩充成员的 ri 不在原始顺序里，会破坏偏移一致性
    const ri = id ? roster.indexOf(id.toUpperCase()) : -1
    if (ri >= 0) anchors.push({ ai, ri })
  })
  if (anchors.length < 3) return rosterSet.size
  const offset = anchors[0].ai - anchors[0].ri
  if (!anchors.every((a) => a.ai - a.ri === offset)) return rosterSet.size // 顺序对不齐就不猜
  // 3) 按统一偏移顺序填补
  archPages.forEach((pi, ai) => {
    const p = pages[pi]
    if (inRoster(p.animalId)) return
    if (p.animalId && p.idSource === 'label') return // 标签渠道已拿到编号（offRoster）：只标待核对，绝不用推定覆盖
    const ri = ai - offset
    if (ri >= 0 && ri < roster.length) {
      p.animalId = roster[ri]
      p.guessed = true
    }
  })
  return rosterSet.size
}

/** 生成不重复的最终文件名 */
export function dedupeNames(items: { newName: string }[]): void {
  const seen = new Map<string, number>()
  for (const it of items) {
    const base = it.newName
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    if (n > 0) it.newName = `${base}_${n + 1}`
  }
}

/**
 * 自定义命名模板渲染：支持 {编号} {标题} {来源} 占位符。
 * 缺值的占位符渲染为空并收拢由此产生的分隔符；文件名非法字符剔除。渲染为空时返回 '' 由调用方兜底。
 */
export function renderNameTemplate(
  tpl: string,
  fields: { id?: string; title?: string; source?: string }
): string {
  return tpl
    .replace(/\{编号\}/g, fields.id ?? '')
    .replace(/\{标题\}/g, fields.title ?? '')
    .replace(/\{来源\}/g, fields.source ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^[_\s-]+|[_\s-]+$/g, '')
    .trim()
}

// ── Excel 档案汇总表字段提取 ─────────────────────────────────────────

/** extractArchiveRow 的输入（段内 OCR 文本 + 命名信息） */
export interface ArchiveRowInput {
  debug?: string[]
  animalId?: string
  sourceName: string
  pageRange: string
  guessed?: boolean
  corrected?: boolean
  /** 编号自证充分但不在花名册里（名册页漏读），需人工核对 */
  offRoster?: boolean
  mergedCount?: number
  /** 额外备注（如中英文双版交叉验证差异），原样并入「备注」列 */
  extraNote?: string
}

/**
 * 从段内 OCR 文本提取档案字段（中英档案页通用，认不出就留空）。
 *
 * 2026-08 批次实测教训：
 * - 出生日期/父母编号必须锚定「耳号行」，否则全文第一个日期常是发货日期（Ship Date），
 *   曾致 5/8 行出生日期错成 8-17-26
 * - 耳号行没有固定结构：编号、性别、出生日期、父、母可能被 OCR 拆成多行、任意顺序，
 *   页角还有光杆编号水印行——所以对每个 id 出现处都开 8 行窗口试解析，按完整度打分取最优
 * - SIRE+DAM 常粘成一整串跟在日期后（如 12-29-2578330001933169），按均分拆；
 *   列头字母被误读成前导数字时（S→5，如 578330001933169）剥 1~2 位再均分
 */
export function extractArchiveRow(o: ArchiveRowInput) {
  const text = (o.debug ?? []).join('\n')
  // 日期：2 位年；年位后允许直接粘数字（SIRE 粘连），但前面不能是数字/短横（防从长串中间截）
  const DATE_RE = /(?<![\d-])(\d{1,2}-\d{1,2}-\d{2})/

  interface Fields {
    birth: string
    sire: string
    dam: string
    score: number
    scope: string
  }

  /** 在文本 t 里解析 出生日期/父亲/母亲；找不到日期返回 null */
  const parseFields = (t: string, anchored: boolean): Fields | null => {
    const b = t.match(DATE_RE)
    if (!b || b.index === undefined) return null
    const birth = b[1]
    let rest = t.slice(b.index + b[0].length, b.index + b[0].length + 160)
    let sire = ''
    let dam = ''
    let quality = 0
    // 日期后第一个纯数字串（若是编号本身——如 8-17-267050002 粘到耳号——跳过取下一串）
    let m = rest.match(/^\D*(\d+)/)
    if (m && m[1] === o.animalId) {
      rest = rest.slice(m[0].length)
      m = rest.match(/^\D*(\d+)/)
    }
    if (m) {
      const run = m[1]
      if (run.length >= 6 && run.length <= 8) {
        // 干净的 SIRE 单串；DAM 是其后的下一个 6~8 位串
        sire = run
        quality = 2
        const d2 = rest.slice(m[0].length).match(/^\D*(\d{6,8})(?!\d)/)
        if (d2 && d2[1] !== o.animalId) {
          dam = d2[1]
          quality += 2
        }
      } else if (run.length >= 12 && run.length <= 17) {
        // SIRE+DAM 粘连整串：均分（7+7 等）；长度为奇数多半是前导误读位（S→5），剥掉再均分
        for (let drop = 0; drop <= 2; drop++) {
          const r = run.slice(drop)
          if (r.length < 12 || r.length > 16) continue
          const s1 = Math.floor(r.length / 2)
          if (s1 < 6 || r.length - s1 > 8) continue
          sire = r.slice(0, s1)
          dam = r.slice(s1)
          quality = 2 - drop // 剥位越少越可信
          break
        }
      }
    }
    return {
      birth,
      sire,
      dam,
      score: 1 + (sire ? 2 : 0) + (dam ? 2 : 0) + quality + (anchored ? 1 : 0),
      scope: t,
    }
  }

  // 候选：每个 id 出现处的 8 行窗口（截断发货日期列）+ 每页全文兜底，打分取最优
  const candidates: Fields[] = []
  for (const page of o.debug ?? []) {
    const lines = page.split('\n')
    lines.forEach((l, i) => {
      if (!o.animalId || !l.includes(o.animalId)) return
      const scope = lines
        .slice(i, i + 8)
        .join(' ')
        .split(/发货|Ship\s*Date/i)[0]
      const f = parseFields(scope, true)
      if (f) candidates.push(f)
    })
    const g = parseFields(page, false)
    if (g) candidates.push(g)
  }
  candidates.sort((a, b) => b.score - a.score) // sort 稳定：同分保留先出现（中文页在前）
  const fields = candidates[0] ?? { birth: '', sire: '', dam: '', score: 0, scope: '' }
  // 性别：耳号行窗口优先；再独立 M/F 行、粘在日期前（M12-30-25… 含编号+M 粘连）、「性别」标签
  // 性别粘连兜底：编号+M+日期（7050003M12-12-25）——M 前是数字而非字母才取
  const sexGlued = [...text.matchAll(/([MF])(?=\d{1,2}-\d{1,2}-\d{2})/g)].find(
    (m) => m.index === 0 || !/[A-Za-z]/.test(text[m.index - 1])
  )?.[1]
  const sex =
    fields.scope?.match(/\b([MF])\b/)?.[1] ??
    text.match(/^\s*([MF])\s*$/m)?.[1] ??
    sexGlued ??
    text.match(/性别[^MF]{0,10}([MF])/)?.[1] ??
    ''
  // 体重：「体重/Weight」标签后（同行粘连或下一行）的数字，取文本序最后一次称重。
  // 值后禁止紧跟数字/小数点/短横——防止把相邻日期行（12-31-24）抓成 12
  let weight = ''
  let weightPos = -1 // 文本序位置：同行版式与分行版式共用「最后一次称重」语义
  for (const m of text.matchAll(
    /(?:体重|weight)\s*[,，:：]?\s*(?:kg|公斤|公厅)?\s*\[?(\d+(?:\.\d+)?)(?![\d.-])/gi
  )) {
    weight = m[1]
    weightPos = m.index ?? -1
  }
  // 标签驱动版式（食蟹猴/巴马猪档案：标签与值是相邻的独立 OCR 行，同一视觉行的值格紧跟标签格）
  const allLines = text.split('\n')
  const FULL_DATE = /^\s*\[?(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{2,4})\s*$/
  const FULL_TOKEN = /^\s*\[?((?=[A-Z0-9]*\d)[A-Z0-9]{5,12})\s*$/i
  const FULL_SEX = /^\s*([MF♂♀公母早])\s*$/i // 「早」是 ♀ 的常见误读
  // 体重分行版式（2026-09-04 实测巴马猪/食蟹猴档案：标签与值各占独立 OCR 行，值在标签下 3 行内。
  // 巴马猪：「体重/Bodyweight:（kg）」下一行「8.9」；食蟹猴：「体重」/「DateofBirth」/「Weight(kg)」/「2.30」）
  // 只收整行独立数字（可带小数、允许前导 [；日期行 2026-9-3 / 12-30-25 含短横天然排除）；
  // 跳过纯英文碎片行与其他字段标签行（猴版式多个标签行连着），遇实质内容行即停。
  // 与同行版式共用「文本序最后一次称重」语义：仅当分行候选位置更靠后才覆盖。
  const WEIGHT_LABEL = /体重|weight/i
  const FULL_WEIGHT_NUM = /^\s*\[?(\d+(?:\.\d+)?)\s*$/
  const WEIGHT_SKIP = /日期|Date|Birth|编号|ID|性别|Sex|Gender|体重|weight/i
  const lineStart: number[] = []
  {
    let acc = 0
    for (const l of allLines) {
      lineStart.push(acc)
      acc += l.length + 1
    }
  }
  allLines.forEach((l, i) => {
    if (!WEIGHT_LABEL.test(l)) return
    for (let k = i + 1; k < Math.min(i + 4, allLines.length); k++) {
      const m = allLines[k].match(FULL_WEIGHT_NUM)
      if (m) {
        if (lineStart[k] > weightPos) {
          weight = m[1]
          weightPos = lineStart[k]
        }
        break
      }
      const t = allLines[k].trim()
      // 纯英文碎片行（双语标签下半行，如 DateofBirth）与其他字段标签行跳过；实质内容行才停
      if (t && !/^[A-Za-z\s]{1,20}$/.test(t) && !WEIGHT_SKIP.test(t)) break
    }
  })
  const nextMatch = (i: number, re: RegExp): string => {
    for (let k = i + 1; k < Math.min(i + 4, allLines.length); k++) {
      const m = allLines[k].match(re)
      if (m) return m[1]
      const t = allLines[k].trim()
      // 纯英文碎片行（双语标签的下半行，如 thefather/Dateofbirth）跳过；真正的内容行才停，防跨行串值
      if (t && !/^[A-Za-z\s]{1,20}$/.test(t)) break
    }
    return ''
  }
  /** 紧邻行内嵌 token：值与标签英文余韵粘在同一 OCR 行时（如 2230660thefather）兜底。
   *  不带 /i——只认大写+数字，小写英文碎片（thefather）自然截断token边界 */
  const TOKEN_IN_LINE = /((?=[A-Z0-9]*\d)[A-Z0-9]{5,12})/
  const embeddedNext = (i: number): string => allLines[i + 1]?.match(TOKEN_IN_LINE)?.[1] ?? ''
  let birthL = ''
  let sireL = ''
  let damL = ''
  let sexL = ''
  const BIRTH_LABEL = /Birth\s*Date|出生\s*日期|Date\s*of\s*Birth/i
  const SIRE_LABEL = /Father\s*No|父\s*号|父亲\s*编号|ID\s*of\s*the\s*father/i
  const DAM_LABEL = /Mother\s*No|母\s*号|母亲\s*编号|ID\s*of\s*the\s*Mother/i
  const SEX_LABEL = /Sex\s*性别|性别\s*(?:\/\s*(?:Sex|Gender))?|(?<![A-Za-z])Sex(?![A-Za-z])|(?<![A-Za-z])Gender(?![A-Za-z])/i // 单行双语或单独「性别」/「Sex」/「Gender」标签行均认；带词边界防误伤含 Sex 的英文单词
  allLines.forEach((l, i) => {
    const after = (re: RegExp) => {
      const m = l.match(re)
      return m && m.index !== undefined ? l.slice(m.index + m[0].length) : ''
    }
    if (!birthL && BIRTH_LABEL.test(l)) {
      birthL =
        after(BIRTH_LABEL).match(/(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{2,4})/)?.[1] ??
        nextMatch(i, FULL_DATE)
    }
    if (!sireL && SIRE_LABEL.test(l)) {
      sireL =
        after(SIRE_LABEL).match(TOKEN_IN_LINE)?.[1] ?? nextMatch(i, FULL_TOKEN) ?? ''
      if (!sireL) sireL = embeddedNext(i)
    }
    if (!damL && DAM_LABEL.test(l)) {
      damL =
        after(DAM_LABEL).match(TOKEN_IN_LINE)?.[1] ?? nextMatch(i, FULL_TOKEN) ?? ''
      if (!damL) damL = embeddedNext(i)
    }
    if (!sexL && SEX_LABEL.test(l)) {
      const raw = after(SEX_LABEL).match(/([MF♂♀公母早])/i)?.[1] ?? nextMatch(i, FULL_SEX)
      sexL = raw ? (/^(?:M|♂|公)$/i.test(raw) ? 'M' : 'F') : ''
    }
  })
  const sexFinal = sex || sexL
  const birthFinal = fields.birth || birthL
  const sireFinal = fields.sire || sireL
  const damFinal = fields.dam || damL
  const missing: string[] = []
  if (!sexFinal) missing.push('性别未识别')
  if (!birthFinal) missing.push('出生日期未识别')
  if (!sireL && !sireFinal) missing.push('父亲编号未识别')
  if (!damFinal) missing.push('母亲编号未识别')
  if (!weight) missing.push('体重未识别')
  return {
    动物编号: o.animalId ?? '',
    性别: sexFinal,
    出生日期: birthFinal,
    父亲编号: sireFinal,
    母亲编号: damFinal,
    '最新体重(kg)': weight,
    来源文件: o.sourceName,
    页码: o.pageRange,
    备注: [
      o.guessed ? '编号为顺序推定' : '',
      o.corrected ? '编号经花名册纠错' : '',
      o.offRoster ? '编号不在花名册（名册页可能漏读）' : '',
      o.mergedCount ? `合并${o.mergedCount}个来源` : '',
      o.extraNote ?? '',
      ...missing,
    ]
      .filter(Boolean)
      .join('；'),
  }
}
