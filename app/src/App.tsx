import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { PDFDocument } from 'pdf-lib'
import {
  extractInfo,
  applyRoster,
  dedupeNames,
  extractArchiveRow,
  openPdfBuffer,
  renderPage,
  renderNameTemplate,
} from '@/lib/ocr'
import { getOcrPool, autoPoolSize } from '@/lib/ocrPool'
import { openPageCache } from '@/lib/pageCache'

type Status = 'waiting' | 'working' | 'done' | 'failed'
type NamingMode = 'id' | 'title_id' | 'title' | 'template'
type SplitMode = 'group' | 'page' | 'whole'

interface PdfItem {
  id: string
  file: File
  origName: string
  status: Status
  progress: number
  stage: string
  message?: string
  pageCount?: number
}

/** 拆分出的输出文件 */
interface OutputFile {
  id: string
  sourceName: string
  pageRange: string
  title?: string
  animalId?: string
  guessed?: boolean
  /** 编号被花名册纠错改过，需人工核对 */
  corrected?: boolean
  /** 编号自证充分但不在花名册里（名册页漏读），需人工核对 */
  offRoster?: boolean
  /** 编号来自低可信候选池（pool），需人工核对 */
  lowConf?: boolean
  /** 可疑项（推定/纠错/低可信/未识别），结果列表高亮置顶 */
  suspect?: boolean
  newName: string
  /** 用户在结果列表手动改过的名字（优先级高于 newName） */
  customName?: string
  bytes: Uint8Array
  debug?: string[]
  /** 由几个同编号段合并而来（中英文对照合并） */
  mergedCount?: number
  /** 合并前的各来源段 id（取消合并用） */
  mergedFrom?: string[]
  /** 中英文双版交叉验证差异（合并时检测），原样进 Excel 备注 */
  extraNote?: string
}

interface HistoryEntry {
  orig: string
  renamed: string
  time: number
  title?: string
  animalId?: string
  guessed?: boolean
  pages?: string
  debug?: string[]
}

const HISTORY_KEY = 'pdf-rename-history'


const ACCENT = '#0f766e'

function makeName(
  mode: NamingMode,
  title?: string,
  animalId?: string,
  fallback = '',
  template = '{编号}',
  source = ''
): string {
  if (mode === 'id') return animalId || title || fallback
  if (mode === 'title_id') return title ? (animalId ? `${title}_${animalId}` : title) : animalId || fallback
  if (mode === 'template') {
    // 自定义模板：占位符缺值时渲染可能变空，回退到「编号/标题/原名」链
    const v = renderNameTemplate(template, { id: animalId, title, source })
    return v || animalId || title || fallback
  }
  return title || fallback
}

/** 展示/下载用文件名：手动改名优先 */
const dispName = (o: OutputFile) => o.customName ?? o.newName

/**
 * 中英文双版交叉验证：同编号合并组里，按 CJK 占比把各段 debug 分成中/英两组，
 * 各自跑 extractArchiveRow，五字段（性别/出生日期/父母编号/最新体重）双边都有值却不一致 → 返回差异描述。
 * 单边缺失不算冲突（那是「未识别」，已有 missing 通道报）。
 */
function crossCheckZhEn(g: OutputFile[]): string {
  const zh: string[] = []
  const en: string[] = []
  for (const o of g) {
    const pages = o.debug ?? []
    const joined = pages.join('\n')
    const cjk = (joined.match(/[一-鿿]/g) ?? []).length
    const total = joined.replace(/\s/g, '').length || 1
    ;(cjk / total >= 0.08 ? zh : en).push(...pages)
  }
  if (!zh.length || !en.length) return ''
  const base = { animalId: g[0].animalId, sourceName: '', pageRange: '' }
  const rz = extractArchiveRow({ ...base, debug: zh })
  const re = extractArchiveRow({ ...base, debug: en })
  // 日期归一化成 YYMMDD 数字串再比，防 12-29-25 vs 2025-12-29 格式差误报
  const normDate = (s: string) => {
    const m = s.match(/(\d{1,4})-(\d{1,2})-(\d{1,2})/)
    if (!m) return s
    const [a, b, c] = [m[1], m[2], m[3]]
    const [y, mo, d] = a.length === 4 ? [+a % 100, +b, +c] : [+c % 100, +a, +b]
    return `${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}`
  }
  const diffs: string[] = []
  const cmp = (label: string, a: string, b: string, norm: (s: string) => string = (s) => s) => {
    if (a && b && norm(a) !== norm(b)) diffs.push(`${label}中${a}/英${b}`)
  }
  cmp('性别', rz.性别, re.性别)
  cmp('出生日期', rz.出生日期, re.出生日期, normDate)
  cmp('父亲编号', rz.父亲编号, re.父亲编号, (s) => s.replace(/\D/g, ''))
  cmp('母亲编号', rz.母亲编号, re.母亲编号, (s) => s.replace(/\D/g, ''))
  cmp('最新体重', rz['最新体重(kg)'], re['最新体重(kg)'], (s) => String(parseFloat(s)))
  return diffs.length ? `中英字段不一致：${diffs.join('；')}` : ''
}

/** 结果在线预览：直接从内存里的拆分结果渲染页面，无需下载 */
function PdfPreview({
  name,
  data,
  mergedCount,
  onSplit,
  onUnmerge,
  onClose,
}: {
  name: string
  data: Uint8Array
  /** >1 时本文件由多段合并而来，可一键取消合并 */
  mergedCount?: number
  /** 在某页前把本文件拆成两个（0-based 页索引，1..pageCount-1）；未提供则不显示拆分条 */
  onSplit?: (beforePage: number) => void
  onUnmerge?: () => void
  onClose: () => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('加载中…')
  // onSplit 走 ref：避免拆分回调变化触发整页重渲染
  const onSplitRef = useRef(onSplit)
  onSplitRef.current = onSplit
  useEffect(() => {
    let cancelled = false
    let openedDoc: { destroy(): Promise<void> } | null = null
    let io: IntersectionObserver | null = null
    // 懒加载渲染串行排队，避免多页同时渲染占爆内存
    let chain: Promise<void> = Promise.resolve()
    ;(async () => {
      try {
        // slice() 拷一份：pdfjs 会 detach 传入的 buffer
        const { doc, pageCount } = await openPdfBuffer(data.slice().buffer as ArrayBuffer)
        openedDoc = doc
        const loadPage = (ph: HTMLDivElement, idx: number) => {
          chain = chain.then(async () => {
            if (cancelled) return
            try {
              const canvas = (await renderPage(doc, idx, 1200)) as HTMLCanvasElement
              if (cancelled) return
              canvas.className = 'w-full shadow-sm'
              ph.replaceWith(canvas)
            } catch {
              ph.textContent = '本页渲染失败'
            }
          })
        }
        // 首屏只渲染第 1 页（秒开）；其余页放占位块，滚动到时再渲染
        io = new IntersectionObserver(
          (entries) => {
            for (const en of entries) {
              if (!en.isIntersecting) continue
              const el = en.target as HTMLDivElement
              io!.unobserve(el)
              loadPage(el, Number(el.dataset.p))
            }
          },
          { rootMargin: '600px' }
        )
        const first = (await renderPage(doc, 0, 1200)) as HTMLCanvasElement
        if (cancelled) return
        first.className = 'w-full shadow-sm'
        bodyRef.current?.appendChild(first)
        for (let i = 1; i < pageCount; i++) {
          // 页间拆分条：预览核对时发现混进来的页，可直接在此把文件切成两个
          if (onSplitRef.current) {
            const div = document.createElement('div')
            div.className = 'flex items-center justify-center py-0.5'
            const btn = document.createElement('button')
            btn.className =
              'border border-dashed border-[#b91c1c]/50 px-2 py-0.5 text-xs text-[#b91c1c] hover:bg-[#b91c1c]/5'
            btn.textContent = `✂ 在此拆分（第 ${i + 1} 页起为新文件）`
            btn.onclick = () => onSplitRef.current?.(i)
            div.appendChild(btn)
            bodyRef.current?.appendChild(div)
          }
          const ph = document.createElement('div')
          ph.dataset.p = String(i)
          ph.style.cssText =
            'height:1000px;display:flex;align-items:center;justify-content:center;color:#9a958a;font-size:12px'
          ph.textContent = `第 ${i + 1} 页 · 滚动至此自动加载`
          bodyRef.current?.appendChild(ph)
          io.observe(ph)
        }
        setStatus(pageCount > 1 ? `共 ${pageCount} 页` : '')
      } catch (e) {
        if (!cancelled) setStatus('预览失败：' + (e instanceof Error ? e.message : String(e)))
      }
    })()
    return () => {
      cancelled = true
      io?.disconnect()
      void openedDoc?.destroy()
    }
  }, [data])
  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        className="mx-auto my-6 flex max-h-[92vh] w-full max-w-3xl flex-col bg-[#f7f5ef] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[#e3e0d6] px-4 py-3">
          <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{name}.pdf</span>
          {status && <span className="shrink-0 text-xs text-[#6b675c]">{status}</span>}
          {mergedCount && mergedCount > 1 && onUnmerge && (
            <button
              onClick={onUnmerge}
              className="shrink-0 text-xs text-[#b91c1c] underline underline-offset-4 hover:opacity-70"
            >
              取消合并（拆回 {mergedCount} 段）
            </button>
          )}
          <button
            onClick={onClose}
            className="shrink-0 text-xs text-[#6b675c] underline underline-offset-4 hover:text-[#0f766e]"
          >
            关闭
          </button>
        </div>
        <div ref={bodyRef} className="flex-1 space-y-4 overflow-y-auto p-4" />
      </div>
    </div>
  )
}

interface PageInfo {
  title?: string
  animalId?: string
  idSource?: 'label' | 'filename' | 'pool' | 'fallback' | null
  idCandidates?: string[]
  /** 次级标签候选编号（如猴档案序号 027）——top-k 救援交叉验证用 */
  idAlts?: string[]
  /** 编号在页内 OCR 行中出现次数（≥2 = 编号格+水印双现自证），防花名册误纠 */
  idEvidence?: number
  guessed?: boolean
  /** 编号被花名册纠错改过 */
  corrected?: boolean
  /** 编号自证充分但不在花名册里（名册页漏读），需人工核对 */
  offRoster?: boolean
  rosterPage?: boolean // 花名册清单页（一页命中 ≥3 个花名册编号），强制独立成段
  /** 清单/表格页（页内多主体结构判定：编号簇/同构行重复，不依赖花名册先验），强制独立成段 */
  listPage?: boolean
}

export default function App() {
  const [items, setItems] = useState<PdfItem[]>([])
  const [outputs, setOutputs] = useState<OutputFile[]>([])
  const [running, setRunning] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [namingMode, setNamingMode] = useState<NamingMode>('id')
  // 自定义命名模板（localStorage 持久化）
  const [nameTemplate, setNameTemplate] = useState(
    () => localStorage.getItem('pdf-name-template') || '{编号}'
  )
  // 用户粘贴的编号清单（外部花名册）：小批次 <5 只时页面自举花名册失效，用它顶替
  const [rosterText, setRosterText] = useState('')
  const externalRoster = useMemo(() => {
    const ids = rosterText
      .split(/[\s,，、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    return ids.length ? [...new Set(ids)] : undefined
  }, [rosterText])
  const [retryHd, setRetryHd] = useState(true)
  const [splitMode, setSplitMode] = useState<SplitMode>('group')
  const [mergeSameId, setMergeSameId] = useState(true)
  const [merged, setMerged] = useState<OutputFile[] | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    } catch {
      return []
    }
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const stopRef = useRef(false)
  // 结果列表手动改名：正在编辑的输出项 id 与草稿
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  // 结果在线预览：正在预览的输出项
  const [preview, setPreview] = useState<OutputFile | null>(null)
  // 结果列表只看待核对项
  const [onlySuspect, setOnlySuspect] = useState(false)
  // 本批花名册规模（applyRoster 返回，>0 时显示在批次摘要里供人工确认名册选对）
  const [rosterSize, setRosterSize] = useState(0)
  // 取消合并的输出段 id 集合（这些段不再参与按编号合并）
  const [unmergedIds, setUnmergedIds] = useState<Set<string>>(new Set())

  // 中英文对照合并：相同动物编号的段（来自不同文件）拼成一个 PDF。
  // 派生自 outputs，不改变原始拆分结果；关闭开关即回到原列表。
  useEffect(() => {
    if (!mergeSameId || splitMode !== 'group') {
      setMerged(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const result: OutputFile[] = []
      const byId = new Map<string, OutputFile[]>()
      for (const o of outputs) {
        if (!o.animalId || unmergedIds.has(o.id)) {
          result.push(o)
          continue
        }
        const g = byId.get(o.animalId)
        if (g) g.push(o)
        else {
          byId.set(o.animalId, [o])
          result.push(o) // 首项占位，保持原顺序
        }
      }
      for (const [, g] of byId) {
        if (g.length < 2) continue
        const doc = await PDFDocument.create()
        for (const o of g) {
          const src = await PDFDocument.load(o.bytes, { ignoreEncryption: true })
          const pages = await doc.copyPages(src, src.getPageIndices())
          pages.forEach((pg) => doc.addPage(pg))
        }
        const bytes = await doc.save()
        const idx = result.indexOf(g[0])
        // 中英文双版交叉验证：合并前几版字段互查，不一致的合并结果标待核对
        const crossNote = crossCheckZhEn(g)
        result[idx] = {
          ...g[0],
          newName: g[0].animalId ?? g[0].newName, // 合并后统一用编号命名
          sourceName: g.map((o) => o.sourceName).join(' + '),
          pageRange: g.map((o) => o.pageRange).join(' + '),
          debug: g.flatMap((o) => o.debug ?? []),
          guessed: g.some((o) => o.guessed),
          corrected: g.some((o) => o.corrected),
          offRoster: g.some((o) => o.offRoster),
          lowConf: g.some((o) => o.lowConf),
          suspect: g.some((o) => o.suspect) || !!crossNote,
          extraNote: crossNote || undefined,
          bytes,
          mergedCount: g.length,
          mergedFrom: g.map((x) => x.id),
        }
      }
      dedupeNames(result)
      if (!cancelled) setMerged(result)
    })()
    return () => {
      cancelled = true
    }
  }, [outputs, mergeSameId, splitMode, unmergedIds])

  const displayOutputs = merged ?? outputs

  // 可疑项（推定/纠错/低可信/未识别）高亮置顶，其余保持原顺序（sort 稳定）
  const sortedOutputs = useMemo(
    () => [...displayOutputs].sort((a, b) => Number(b.suspect ?? false) - Number(a.suspect ?? false)),
    [displayOutputs]
  )

  // 批次摘要统计
  const batchSummary = useMemo(() => {
    const total = displayOutputs.length
    const animals = displayOutputs.filter((o) => o.animalId && !/^No\./i.test(o.animalId)).length
    const unidentified = displayOutputs.filter((o) => !o.animalId).length
    const docs = total - animals - unidentified // No. 单据（合格证/发票等）
    const suspects = displayOutputs.filter((o) => o.suspect).length
    return { total, animals, unidentified, docs, suspects }
  }, [displayOutputs])

  // 结果列表可见项：可切换「只看待核对」
  const visibleOutputs = onlySuspect ? sortedOutputs.filter((o) => o.suspect) : sortedOutputs

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 200)))
  }, [history])

  const addFiles = useCallback((files: FileList | File[]) => {
    const pdfs = Array.from(files).filter(
      (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    )
    if (pdfs.length === 0) return
    setItems((prev) => [
      ...prev,
      ...pdfs.map((f) => ({
        id: crypto.randomUUID(),
        file: f,
        origName: f.name.replace(/\.pdf$/i, ''),
        status: 'waiting' as Status,
        progress: 0,
        stage: '',
      })),
    ])
  }, [])

  const update = (id: string, patch: Partial<PdfItem>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))

  /** 分段：按编号变化切开；无编号但标题变成另一类文档（如合格证）也切开；英文附页/无标题页并入前段 */
  function segmentPages(pages: PageInfo[]): { start: number; end: number; id?: string }[] {
    if (splitMode === 'page') return pages.map((p, i) => ({ start: i, end: i, id: p.animalId }))
    const DOC_WORD = /档案|记录|合格证|报告|发票|证明|通知|登记|协议|合同|清单|收据|凭证|申购|订购|申请/
    const norm = (t?: string) => (t ?? '').replace(/[^一-鿿A-Za-z0-9]/g, '')
    /** 最长公共子串长度（OCR 抖动下判断两个标题是否同一类文档） */
    const lcsLen = (a: string, b: string) => {
      let best = 0
      const dp = new Array<number>(b.length + 1).fill(0)
      for (let i = 1; i <= a.length; i++) {
        for (let j = b.length; j >= 1; j--) {
          dp[j] = a[i - 1] === b[j - 1] ? dp[j - 1] + 1 : 0
          if (dp[j] > best) best = dp[j]
        }
      }
      return best
    }
    const sameTitle = (a?: string, b?: string) => {
      const x = norm(a)
      const y = norm(b)
      if (!x || !y) return false
      if (x === y || x.includes(y) || y.includes(x) || lcsLen(x, y) >= 5) return true
      // 同一大类文书（如各种「合格证」：质量合格证/合格证编号页/合格证专用章页）视为同类
      const ta = x.match(/合格证|发票|收据|报告|证明/)?.[0]
      const tb = y.match(/合格证|发票|收据|报告|证明/)?.[0]
      return !!ta && ta === tb
    }
    const segs: { start: number; end: number; id?: string }[] = []
    let curStart = 0
    let curId: string | undefined
    let curTitle: string | undefined
    let curHadArchive = false // 本段已出现过「档案」封面页
    pages.forEach((p, i) => {
      let brk = false
      if (p.rosterPage || p.listPage) {
        // 花名册/费用清单/多主体表格页：不归属任何单一动物，强制独立成段
        brk = curId !== undefined || curTitle !== undefined || i > curStart
      } else if (p.animalId) {
        brk = p.animalId !== curId
      } else if (p.title && DOC_WORD.test(p.title) && (curId || curTitle)) {
        // 无编号页：标题是另一类文档（含文档类型词且与本段标题不同）→ 另起一段
        brk = !sameTitle(p.title, curTitle)
        // 又一张档案封面但编号糊掉了：不能并入前一头动物，单独成段标未识别
        if (!brk && /档案/.test(p.title) && curHadArchive) brk = true
      }
      if (brk && i > curStart) {
        segs.push({ start: curStart, end: i - 1, id: curId })
        curStart = i
        curId = undefined
        curTitle = undefined
        curHadArchive = false
      }
      if (p.animalId) curId = p.animalId
      if (p.title) {
        curTitle = p.title
        if (/档案/.test(p.title)) curHadArchive = true
      }
    })
    segs.push({ start: curStart, end: pages.length - 1, id: curId })
    return segs
  }

  const processOne = async (it: PdfItem): Promise<OutputFile[]> => {
    // 原 buffer 留给 pdf-lib 拆分；OCR 走 Worker 池（openDoc 内部会克隆分发给各线程）
    const buf = await it.file.arrayBuffer()
    const pool = getOcrPool()
    const docId = it.id
    const results: OutputFile[] = []
    // 断点续跑：同一文件（按 文件名+大小+修改时间 识别）已完成页直接命中缓存
    const cache = await openPageCache()
    const fileKey = `${it.file.name}:${it.file.size}:${it.file.lastModified}`
    const cachedPages = new Set<number>()
    try {
      const pageCount = await pool.openDoc(docId, buf)
      // 逐页识别：pool.size 条"跑道"并行派发，结果按页序落回数组
      const pages: PageInfo[] = []
      const debugPages: string[] = []
      let done = 0
      let next = 0
      const runLane = async () => {
        while (next < pageCount && !stopRef.current) {
          const i = next++
          // 缓存命中：整页 OCR 结果（含重试后的最终 info）直接复用
          const hit = cache ? await cache.get(fileKey, i) : null
          if (hit) {
            cachedPages.add(i)
            debugPages[i] = hit.debug
            pages[i] = { ...hit.info }
            done++
            update(it.id, {
              stage: `第 ${done}/${pageCount} 页（缓存）`,
              progress: (done / pageCount) * 0.95 + 0.05,
            })
            continue
          }
          try {
            const { lines, height } = await pool.ocrPage(docId, i)
            // 不截断：debug 文本同时是 extractArchiveRow 的输入，截断会丢掉靠后的称重行
            debugPages[i] = `【第 ${i + 1} 页】\n` + lines.map((l) => l.text).join('\n')
            const info = extractInfo(lines, height)
            pages[i] = {
              title: info.title ?? undefined,
              animalId: info.animalId ?? undefined,
              idSource: info.idSource,
              idEvidence: info.idEvidence,
              idAlts: info.idAlts,
              idCandidates: info.idCandidates,
              listPage: info.listPage,
            }
            // 逐页落盘：此刻中断，下次重开只补没跑完的页
            cache?.put(fileKey, i, { debug: debugPages[i], info: pages[i] })
          } catch {
            // 失败页不入缓存：可能是 Worker 瞬时错误，下次运行值得真重试
            debugPages[i] = `【第 ${i + 1} 页】（识别失败）`
            pages[i] = {}
          }
          done++
          update(it.id, {
            stage: `第 ${done}/${pageCount} 页`,
            progress: (done / pageCount) * 0.95 + 0.05,
          })
        }
      }
      await Promise.all(Array.from({ length: pool.size }, runLane))
      // 高清重试：档案页编号缺失或只是低可信补救的，裁顶部区域放大+二值化再识别一次
      const retryIdx: number[] = []
      if (retryHd) {
        for (let i = 0; i < pages.length; i++) {
          if (cachedPages.has(i)) continue // 缓存页已是含重试的最终结果，不再重试
          const p = pages[i]
          if (!p || !p.title || !/档案|记录/.test(p.title)) continue
          if (!p.animalId || p.idSource === 'pool' || p.idSource === 'fallback') retryIdx.push(i)
        }
      }
      let ri = 0
      const runRetry = async () => {
        while (ri < retryIdx.length && !stopRef.current) {
          const i = retryIdx[ri++]
          const p = pages[i]
          update(it.id, { stage: `第 ${i + 1}/${pages.length} 页（高清重试）`, progress: 0.95 })
          try {
            const { lines, height } = await pool.ocrPage(docId, i, true)
            debugPages[i] +=
              '\n—— 顶部高清重试 ——\n' + lines.slice(0, 30).map((l) => l.text).join('\n')
            const info = extractInfo(lines, height)
            if (info.animalId && (info.idSource === 'label' || !p.animalId)) {
              p.animalId = info.animalId
              p.idSource = info.idSource
              p.idEvidence = info.idEvidence
              p.idAlts = info.idAlts
            }
            p.idCandidates = [...(p.idCandidates ?? []), ...info.idCandidates]
            p.idAlts = [...new Set([...(p.idAlts ?? []), ...info.idAlts])]
            // 仍无编号：三级重试——编号格裁剪放大 2.5× 再认（小字/章压字的顽固页）
            if (!p.animalId) {
              try {
                const cell = await pool.ocrIdCell(docId, i)
                if (cell.lines.length > 0) {
                  const ci = extractInfo(cell.lines, cell.height)
                  if (ci.animalId) {
                    p.animalId = ci.animalId
                    p.idSource = ci.idSource
                    p.idEvidence = ci.idEvidence
                    p.idAlts = ci.idAlts
                    debugPages[i] +=
                      '\n—— 编号格放大重试 ——\n' + cell.lines.map((l) => l.text).join('\n')
                  }
                }
              } catch {
                /* 三级重试失败维持原结果 */
              }
            }
          } catch {
            /* 重试失败维持原结果，交给花名册推定 */
          }
          // 重试后页状态变了（编号/候选/debug 追加），更新缓存为最终态
          cache?.put(fileKey, i, { debug: debugPages[i], info: pages[i] })
        }
      }
      await Promise.all(Array.from({ length: pool.size }, runRetry))
      cache?.touch(fileKey, pageCount)
      // 文档级修正：合集带检测表（编号清单）时，纠错/推定各页编号；返回值=花名册规模
      if (splitMode !== 'page') {
        const n = applyRoster(pages, externalRoster)
        if (n > 0) setRosterSize((prev) => Math.max(prev, n))
      }
      // 拆分
      const srcDoc = await PDFDocument.load(buf, { ignoreEncryption: true })
      const segs =
        splitMode === 'whole'
          ? [{ start: 0, end: pageCount - 1, id: pages[0]?.animalId }]
          : segmentPages(pages)
      for (const seg of segs) {
        const segPages = pages.slice(seg.start, seg.end + 1)
        const first = segPages.find((p) => p.animalId || p.title) ?? {}
        const aid = seg.id ?? first.animalId
        const guessed = segPages.some((p) => p.animalId === aid && p.guessed)
        // 可疑项判定：顺序推定 / 花名册纠错 / 名册外自证编号 / 编号来自低可信候选池 / 未识别出编号
        const corrected = segPages.some((p) => p.animalId === aid && p.corrected)
        const offRoster = segPages.some((p) => p.animalId === aid && p.offRoster)
        const lowConf = !!aid && segPages.some((p) => p.animalId === aid && p.idSource === 'pool')
        const suspect = guessed || corrected || offRoster || lowConf || !aid
        // 整本只拆出一段且什么也没识别到时，保留原文件名
        const fallback = segs.length === 1 ? it.origName : `${it.origName}_p${seg.start + 1}`
        // 档案页没识别出编号：不用笼统标题命名（避免看起来像识别成功），用原名+页码
        const name =
          !aid && first.title && /档案|记录/.test(first.title)
            ? fallback
            : makeName(namingMode, first.title, aid, fallback, nameTemplate, it.origName)
        const outDoc = await PDFDocument.create()
        const copied = await outDoc.copyPages(
          srcDoc,
          Array.from({ length: seg.end - seg.start + 1 }, (_, k) => seg.start + k)
        )
        copied.forEach((p) => outDoc.addPage(p))
        const bytes = await outDoc.save()
        const out = {
          id: crypto.randomUUID(),
          sourceName: it.origName,
          pageRange: `${seg.start + 1}-${seg.end + 1}`,
          title: first.title,
          animalId: aid,
          guessed,
          corrected,
          offRoster,
          lowConf,
          suspect,
          newName: name,
          bytes,
          debug: debugPages.slice(seg.start, seg.end + 1),
        }
        // 关键字段读不出（性别/出生日期/父母编号/体重，如猪 ♀ 符号被 OCR 丢弃）也标待核对
        if (aid && !out.suspect && !/^No\./i.test(aid)) {
          const row = extractArchiveRow(out)
          if (!row.性别 || !row.出生日期 || !row.父亲编号 || !row.母亲编号 || !row['最新体重(kg)']) {
            out.suspect = true
          }
        }
        results.push(out)
      }
      return results
    } finally {
      await pool.closeDoc(docId)
    }
  }

  const startAll = async () => {
    setRunning(true)
    stopRef.current = false
    getOcrPool().prewarm() // 各 Worker 并行加载模型，第一页识别更顺
    for (const it of items) {
      if (stopRef.current) break
      if (it.status === 'done') continue
      update(it.id, { status: 'working', stage: '打开文件', progress: 0.02, message: undefined })
      try {
        const outs = await processOne(it)
        // 重名去重（与已有输出一起）
        setOutputs((prev) => {
          const all = [...prev, ...outs]
          dedupeNames(all)
          return all
        })
        update(it.id, { status: 'done', progress: 1, stage: '', message: `已拆出 ${outs.length} 个文件` })
        setHistory((prev) =>
          [
            ...outs.map((o) => ({
              orig: `${it.origName}.pdf`,
              renamed: `${o.newName}.pdf`,
              time: Date.now(),
              title: o.title,
              animalId: o.animalId,
              pages: o.pageRange,
              debug: o.debug?.slice(0, 8),
            })),
            ...prev,
          ].slice(0, 200)
        )
      } catch (e) {
        update(it.id, {
          status: 'failed',
          stage: '',
          message: e instanceof Error ? e.message : '处理失败',
        })
      }
    }
    setRunning(false)
  }

  /** 保存文件：优先走「另存为」对话框（File System Access API）。
   *  这样写出的文件不带 Windows 网络来源标记（MOTW），资源管理器可正常预览/打开；
   *  不支持的环境回退普通下载。用户取消（AbortError）则静默不保存。 */
  const saveBlob = async (blob: Blob, filename: string): Promise<void> => {
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (o: {
          suggestedName: string
        }) => Promise<{
          createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>
        }>
      }
    ).showSaveFilePicker
    if (picker) {
      try {
        const handle = await picker.call(window, { suggestedName: filename })
        const w = await handle.createWritable()
        await w.write(blob)
        await w.close()
        return
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        // 其余错误（如沙盒环境不支持）落回普通下载
      }
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const downloadOutput = (o: OutputFile) => {
    const blob = new Blob([o.bytes as BlobPart], { type: 'application/pdf' })
    void saveBlob(blob, dispName(o) + '.pdf')
  }

  /** 结果列表手动改名：去掉非法字符；清空则恢复自动命名 */
  const commitRename = (id: string) => {
    const clean = editDraft
      .replace(/\.pdf$/i, '')
      .replace(/[\\/:*?"<>|]/g, '')
      .trim()
    setOutputs((prev) =>
      prev.map((o) => (o.id === id ? { ...o, customName: clean || undefined } : o))
    )
    setEditingId(null)
  }

  const downloadZip = async () => {
    if (sortedOutputs.length === 0) return
    const zip = new JSZip()
    const names = sortedOutputs.map((o) => ({ newName: dispName(o) }))
    dedupeNames(names)
    sortedOutputs.forEach((o, i) => zip.file(names[i].newName + '.pdf', o.bytes))
    // 排障用：全部段的 OCR 原文随包携带（字段对不上时直接查这个文件）
    const debugAll = sortedOutputs
      .map((o, i) => `===== ${names[i].newName} =====\n` + (o.debug ?? []).join('\n'))
      .join('\n\n')
    zip.file('_OCR原文汇总.txt', debugAll)
    const blob = await zip.generateAsync({ type: 'blob' })
    await saveBlob(blob, '识别拆分结果.zip')
  }

  /** 从段内 OCR 文本提取档案字段（实现见 lib/ocr.ts 的 extractArchiveRow） */
  const downloadExcel = () => {
    // No. 前缀的是合格证/发票等单据，不进动物档案表
    const rows = sortedOutputs
      .filter((o) => o.animalId && !/^No\./i.test(o.animalId))
      .map(extractArchiveRow)
    if (rows.length === 0) return
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 14 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 40 }, { wch: 12 }, { wch: 18 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '动物档案')
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    void saveBlob(
      new Blob([out], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      '动物档案汇总.xlsx'
    )
  }

  /** 预览中的手动拆分：把一个输出文件从指定页切成两个（pdf-lib 物理拆页）。
   *  前半保留原名与编号；后半无编号、标待核对置顶，自动命名后可行内改名。
   *  作用于 outputs 原段，ZIP/Excel/合并视图全部自动跟随。 */
  const splitOutput = async (o: OutputFile, beforeIdx: number) => {
    if (running) return
    const src = await PDFDocument.load(o.bytes, { ignoreEncryption: true })
    const total = src.getPageCount()
    if (beforeIdx < 1 || beforeIdx > total - 1) return
    const mk = async (from: number, to: number) => {
      const d = await PDFDocument.create()
      const ps = await d.copyPages(src, Array.from({ length: to - from + 1 }, (_, k) => from + k))
      ps.forEach((p) => d.addPage(p))
      return d.save()
    }
    // pageRange 形如 "2-4"（单段必定是连续区间；合并项已先要求取消合并）
    const m = /^(\d+)-(\d+)$/.exec(o.pageRange)
    const startP = m ? +m[1] : null
    const rng = (a: number, b: number) => (startP ? `${startP + a}-${startP + b}` : `${a + 1}-${b + 1}`)
    const base = dispName(o)
    const front: OutputFile = {
      ...o,
      id: crypto.randomUUID(),
      bytes: await mk(0, beforeIdx - 1),
      pageRange: rng(0, beforeIdx - 1),
      debug: o.debug?.slice(0, beforeIdx),
      mergedCount: undefined,
      mergedFrom: undefined,
      extraNote: undefined,
    }
    const back: OutputFile = {
      ...o,
      id: crypto.randomUUID(),
      bytes: await mk(beforeIdx, total - 1),
      pageRange: rng(beforeIdx, total - 1),
      debug: o.debug?.slice(beforeIdx),
      title: undefined,
      animalId: undefined,
      guessed: false,
      corrected: false,
      offRoster: false,
      lowConf: false,
      suspect: true,
      customName: undefined,
      mergedCount: undefined,
      mergedFrom: undefined,
      extraNote: undefined,
      newName: `${base}_第${beforeIdx + 1}页起`,
    }
    setOutputs((prev) => {
      const i = prev.findIndex((x) => x.id === o.id)
      if (i < 0) return prev
      const next = [...prev]
      next.splice(i, 1, front, back)
      dedupeNames(next)
      return next
    })
    setPreview(null)
  }

  const pendingCount = items.filter((i) => i.status !== 'done').length

  return (
    <div className="min-h-screen bg-[#f4f3ef] text-[#16150f] antialiased">
      <div className="mx-auto max-w-3xl px-6 py-14">
        <header className="mb-10">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.25em] text-[#0f766e]">
            本地运行 · 文件不上传
          </p>
          <h1 className="text-4xl font-bold tracking-tight">动物档案 PDF 识别拆分</h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-[#6b675c]">
            拖入扫描版 PDF（支持整本合集），工具在你的浏览器里逐页 OCR，
            按动物编号拆分并命名。全程不经过任何服务器，无需安装任何软件。
          </p>
        </header>

        {/* 拖放区 */}
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            addFiles(e.dataTransfer.files)
          }}
          className={`cursor-pointer border-2 border-dashed px-6 py-12 text-center transition-colors ${
            dragOver ? 'border-[#0f766e] bg-[#0f766e]/5' : 'border-[#c9c5b8] hover:border-[#0f766e]/60'
          }`}
        >
          <p className="text-base font-medium">把 PDF 文件拖到这里，或点击选择</p>
          <p className="mt-1 text-xs text-[#6b675c]">支持多选 · 支持整本多页合集</p>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>

        {/* 拆分方式 */}
        <div className="mt-6 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="text-[#6b675c]">拆分方式</span>
            {(
              [
                ['group', '按编号分段', '同编号连续页合并'],
                ['page', '每页一个文件', ''],
                ['whole', '不拆分', '整本重命名'],
              ] as [SplitMode, string, string][]
            ).map(([mode, label, hint]) => (
              <label key={mode} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="split"
                  checked={splitMode === mode}
                  onChange={() => setSplitMode(mode)}
                  className="accent-[#0f766e]"
                />
                <span>{label}</span>
                {hint && <span className="text-xs text-[#9a958a]">{hint}</span>}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="text-[#6b675c]">命名方式</span>
            {(
              [
                ['id', '只用编号', 'B265003'],
                ['title_id', '标题_编号', '实验猪个体档案_B265003'],
                ['title', '只用标题', '实验猪个体档案'],
                ['template', '自定义模板', ''],
              ] as [NamingMode, string, string][]
            ).map(([mode, label, example]) => (
              <label key={mode} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="naming"
                  checked={namingMode === mode}
                  onChange={() => setNamingMode(mode)}
                  className="accent-[#0f766e]"
                />
                <span>{label}</span>
                {example && <span className="font-mono text-xs text-[#9a958a]">{example}</span>}
              </label>
            ))}
            {namingMode === 'template' && (
              <span className="flex items-center gap-1.5">
                <input
                  value={nameTemplate}
                  onChange={(e) => {
                    setNameTemplate(e.target.value)
                    localStorage.setItem('pdf-name-template', e.target.value)
                  }}
                  placeholder="{编号}_{标题}"
                  className="w-44 border border-[#c9c5b8] bg-white/60 px-2 py-1 font-mono text-xs outline-none focus:border-[#0f766e]"
                />
                <span className="text-xs text-[#9a958a]">可用 {'{编号}'} {'{标题}'} {'{来源}'}</span>
              </span>
            )}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={mergeSameId}
              onChange={(e) => setMergeSameId(e.target.checked)}
              disabled={splitMode !== 'group'}
              className="accent-[#0f766e]"
            />
            <span>合并相同编号</span>
            <span className="text-xs text-[#9a958a]">中英文档案是同批动物时，合并成每只动物一个 PDF</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={retryHd}
              onChange={(e) => setRetryHd(e.target.checked)}
              className="accent-[#0f766e]"
            />
            <span>模糊页高清重试</span>
            <span className="text-xs text-[#9a958a]">认不出编号的页放大再试一次，更准但更慢；赶时间可关掉</span>
          </label>
          <details className="text-sm">
            <summary className="cursor-pointer select-none text-[#6b675c]">
              粘贴编号清单（可选）
              <span className="ml-1 text-xs text-[#9a958a]">
                小批次（&lt;5 只）花名册无法自动生成时，粘贴清单后按它纠错/推定编号
              </span>
            </summary>
            <textarea
              value={rosterText}
              onChange={(e) => setRosterText(e.target.value)}
              rows={3}
              placeholder={'每行一个编号，或用空格/逗号分隔，如：\n7050001\n7050002\n7050003'}
              className="mt-2 w-full border border-[#c9c5b8] bg-white/60 px-2 py-1.5 font-mono text-xs outline-none focus:border-[#0f766e]"
            />
            {externalRoster && (
              <p className="mt-1 text-xs text-[#0f766e]">已载入 {externalRoster.length} 个编号，将用于本批纠错与顺序推定</p>
            )}
          </details>
        </div>

        {/* 操作栏 */}
        {items.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              onClick={startAll}
              disabled={running || pendingCount === 0}
              className="bg-[#16150f] px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? '处理中…' : `开始处理（${pendingCount} 个待处理）`}
            </button>
            <button
              onClick={downloadZip}
              disabled={running || displayOutputs.length === 0}
              className="border border-[#16150f] px-5 py-2.5 text-sm font-medium transition-colors hover:bg-[#16150f] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              打包下载（{displayOutputs.length} 个）
            </button>
            <button
              onClick={downloadExcel}
              disabled={running || displayOutputs.length === 0}
              className="border border-[#0f766e] px-5 py-2.5 text-sm font-medium text-[#0f766e] transition-colors hover:bg-[#0f766e] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              下载 Excel 档案表
            </button>
            {running && (
              <button
                onClick={() => (stopRef.current = true)}
                className="px-4 py-2.5 text-sm text-[#6b675c] underline underline-offset-4"
              >
                停止
              </button>
            )}
            <button
              onClick={() => {
                setItems([])
                setOutputs([])
              }}
              disabled={running}
              className="ml-auto px-4 py-2.5 text-sm text-[#6b675c] underline underline-offset-4 disabled:opacity-40"
            >
              清空列表
            </button>
          </div>
        )}

        {items.length > 0 && (
          <p className="mt-3 text-xs leading-relaxed text-[#6b675c]">
            首次识别需加载 PaddleOCR 模型（约 15 MB，随本页一并缓存，之后离线可用）。
            识别速度取决于设备性能，每页约 2～6 秒；现已按 CPU 核数自动多线程并行（{autoPoolSize()} 路），内存占用会相应升高。
          </p>
        )}

        {/* 输入文件列表 */}
        <ul className="mt-8 divide-y divide-[#e3e0d6]">
          {items.map((it) => (
            <li key={it.id} className="py-4">
              <div className="flex items-baseline gap-3">
                <span
                  className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      it.status === 'done'
                        ? ACCENT
                        : it.status === 'failed'
                          ? '#b91c1c'
                          : it.status === 'working'
                            ? '#d97706'
                            : '#c9c5b8',
                  }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-[#6b675c]">{it.origName}.pdf</p>
                  {it.status === 'working' && (
                    <div className="mt-2">
                      <div className="h-1 w-full bg-[#e3e0d6]">
                        <div
                          className="h-1 bg-[#0f766e] transition-all"
                          style={{ width: `${Math.round(it.progress * 100)}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-[#6b675c]">
                        {it.stage} · {Math.round(it.progress * 100)}%
                      </p>
                    </div>
                  )}
                  {it.message && (
                    <p className={`mt-1 text-xs ${it.status === 'failed' ? 'text-[#b91c1c]' : 'text-[#6b675c]'}`}>
                      {it.message}
                    </p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>

        {/* 输出文件列表 */}
        {sortedOutputs.length > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-medium">
              拆分结果（{sortedOutputs.length} 个）
              {merged && merged.length !== outputs.length && (
                <span className="font-normal text-[#9a958a]">
                  {' '}· 已由 {outputs.length} 段按编号合并
                </span>
              )}
            </h2>
            {/* 批次摘要 */}
            <p className="mt-1 text-xs leading-relaxed text-[#6b675c]">
              本批共 {batchSummary.total} 个文件：动物档案 {batchSummary.animals} 只
              {rosterSize > 0 && ` · 花名册 ${rosterSize} 个编号`}
              {batchSummary.docs > 0 && `、单据 ${batchSummary.docs} 个`}
              {batchSummary.unidentified > 0 && `、未识别 ${batchSummary.unidentified} 个`}
              {batchSummary.suspects > 0 ? (
                <span className="text-[#d97706]">；{batchSummary.suspects} 个待核对，已高亮置顶</span>
              ) : (
                '；全部可信，无需核对'
              )}
              {batchSummary.suspects > 0 && (
                <label className="ml-3 inline-flex cursor-pointer items-center gap-1">
                  <input
                    type="checkbox"
                    checked={onlySuspect}
                    onChange={(e) => setOnlySuspect(e.target.checked)}
                    className="accent-[#0f766e]"
                  />
                  只看待核对
                </label>
              )}
            </p>
            <ul className="mt-3 divide-y divide-[#e3e0d6]">
              {visibleOutputs.map((o) => (
                <li
                  key={o.id}
                  className={`flex items-baseline gap-3 py-3 ${
                    o.suspect ? 'border-l-2 border-[#d97706] bg-[#d97706]/5 pl-3' : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    {editingId === o.id ? (
                      <p className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(o.id)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          className="min-w-0 flex-1 border border-[#0f766e] bg-white px-2 py-1 font-mono text-sm outline-none"
                        />
                        <span className="shrink-0 font-mono text-xs text-[#9a958a]">.pdf</span>
                        <button
                          onClick={() => commitRename(o.id)}
                          className="shrink-0 text-xs text-[#0f766e] underline underline-offset-4 hover:opacity-70"
                        >
                          确定
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="shrink-0 text-xs text-[#6b675c] underline underline-offset-4 hover:opacity-70"
                        >
                          取消
                        </button>
                      </p>
                    ) : (
                      <p className="flex items-baseline font-mono text-sm font-medium">
                        <span className="truncate">{dispName(o)}.pdf</span>
                        <button
                          onClick={() => {
                            setEditingId(o.id)
                            setEditDraft(dispName(o))
                          }}
                          className="ml-2 shrink-0 text-xs font-normal text-[#6b675c] underline underline-offset-4 hover:text-[#0f766e]"
                        >
                          改名
                        </button>
                        {o.customName && (
                          <button
                            onClick={() =>
                              setOutputs((prev) =>
                                prev.map((x) => (x.id === o.id ? { ...x, customName: undefined } : x))
                              )
                            }
                            title={`恢复自动命名：${o.newName}.pdf`}
                            className="ml-2 shrink-0 text-xs font-normal text-[#9a958a] underline underline-offset-4 hover:text-[#0f766e]"
                          >
                            恢复
                          </button>
                        )}
                      </p>
                    )}
                    <p className="mt-0.5 font-mono text-xs text-[#6b675c]">
                      {o.suspect && (
                        <span className="mr-1 bg-[#d97706] px-1.5 py-0.5 text-white">待核对</span>
                      )}
                      来自 {o.sourceName}.pdf · 第 {o.pageRange} 页
                      {o.animalId ? ` · 编号 ${o.animalId}` : ''}
                      {o.guessed && (
                        <span className="ml-1 bg-[#d97706]/10 px-1.5 py-0.5 text-[#d97706]">
                          按检测表顺序推定
                        </span>
                      )}
                      {o.corrected && (
                        <span className="ml-1 bg-[#d97706]/10 px-1.5 py-0.5 text-[#d97706]">
                          编号经花名册纠错
                        </span>
                      )}
                      {o.offRoster && (
                        <span className="ml-1 bg-[#d97706]/10 px-1.5 py-0.5 text-[#d97706]">
                          编号不在花名册
                        </span>
                      )}
                      {o.lowConf && (
                        <span className="ml-1 bg-[#d97706]/10 px-1.5 py-0.5 text-[#d97706]">
                          编号低可信
                        </span>
                      )}
                      {o.mergedCount && o.mergedCount > 1 && (
                        <span className="ml-1 bg-[#0f766e]/10 px-1.5 py-0.5 text-[#0f766e]">
                          {o.mergedCount} 个来源合并
                        </span>
                      )}
                      {o.extraNote && (
                        <span className="ml-1 bg-[#b91c1c]/10 px-1.5 py-0.5 text-[#b91c1c]">
                          {o.extraNote}
                        </span>
                      )}
                      {o.title ? ` · ${o.title}` : ''}
                      {!o.animalId && o.title && /档案|记录/.test(o.title) && (
                        <span className="ml-1 bg-[#d97706]/10 px-1.5 py-0.5 text-[#d97706]">
                          编号未识别，请人工命名
                        </span>
                      )}
                      {!o.animalId && !o.title && (
                        <span className="ml-1 bg-[#b91c1c]/10 px-1.5 py-0.5 text-[#b91c1c]">
                          未识别，保留原名
                        </span>
                      )}
                    </p>
                    {o.debug && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-[#6b675c] underline underline-offset-4">
                          查看 OCR 原文
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto bg-[#eceade] p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                          {o.debug.join('\n')}
                        </pre>
                      </details>
                    )}
                  </div>
                  <button
                    onClick={() => setPreview(o)}
                    className="shrink-0 text-xs text-[#6b675c] underline underline-offset-4 hover:text-[#0f766e]"
                  >
                    预览
                  </button>
                  <button
                    onClick={() => downloadOutput(o)}
                    className="shrink-0 text-xs text-[#0f766e] underline underline-offset-4 hover:opacity-70"
                  >
                    下载
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 识别记录 */}
        {history.length > 0 && (
          <section className="mt-12">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium">
                识别记录 <span className="font-normal text-[#9a958a]">（仅保存在此浏览器，共 {history.length} 条）</span>
              </h2>
              <button
                onClick={() => setHistory([])}
                className="text-xs text-[#6b675c] underline underline-offset-4 hover:opacity-70"
              >
                清空记录
              </button>
            </div>
            <ul className="mt-3 divide-y divide-[#e3e0d6]">
              {history.slice(0, 50).map((h, i) => (
                <li key={i} className="py-2 font-mono text-xs">
                  <details>
                    <summary className="flex cursor-pointer items-baseline gap-3">
                      <span className="shrink-0 text-[#9a958a]">
                        {new Date(h.time).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span className="truncate text-[#6b675c]">{h.orig}</span>
                      <span className="shrink-0 text-[#9a958a]">→</span>
                      <span className="truncate font-medium">{h.renamed}</span>
                    </summary>
                    <div className="mt-2 ml-2 border-l-2 border-[#e3e0d6] pl-3">
                      <p className="text-[#6b675c]">
                        标题：{h.title ?? '—'}{'　'}编号：{h.animalId ?? '—'}
                        {h.guessed ? '（按检测表顺序推定）' : ''}
                        {h.pages ? `\u3000页码：${h.pages}` : ''}
                      </p>
                      {h.debug && h.debug.length > 0 && (
                        <pre className="mt-1 max-h-48 overflow-auto bg-[#eceade] p-2 leading-relaxed whitespace-pre-wrap">
                          {h.debug.join('\n')}
                        </pre>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-16 border-t border-[#e3e0d6] pt-6 text-xs leading-relaxed text-[#6b675c]">
          <p className="mb-1 text-[#9a958a]">构建版本 2026-08-25 v1.1.3 · 完全离线运行，文件不上传。</p>
          <p>
            提示：下载到的是拆分重命名后的副本，原始文件不会被改动。
            猪识别「耳标号/耳号/纹身号」，猴子识别「猴号/动物编号」，犬识别「耳号/芯片号」。
            合集里附有检测表（编号清单）时，会对齐清单纠错：糊掉的编号按顺序推定并标注「推定」，请抽查核对；
            混在合集里的其他文档（如合格证）按标题单独拆出。
          </p>
        </footer>
      </div>

      {/* 结果在线预览（合并项先取消合并再拆页；单段可直接页间拆分） */}
      {preview && (
        <PdfPreview
          name={dispName(preview)}
          data={preview.bytes}
          mergedCount={preview.mergedCount}
          onSplit={
            preview.mergedCount && preview.mergedCount > 1
              ? undefined
              : (i) => void splitOutput(preview, i)
          }
          onUnmerge={
            preview.mergedCount && preview.mergedCount > 1
              ? () => {
                  setUnmergedIds((prev) => new Set([...prev, ...(preview.mergedFrom ?? [])]))
                  setPreview(null)
                }
              : undefined
          }
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}
