/**
 * OCR Worker 池：按 CPU 核数自动决定并行度（上限 3 路，防止内存爆掉），
 * 把 PDF 页派发到多个 Worker 线程并行渲染 + 识别。
 *
 * - openDoc 把文档 buffer 广播给所有 Worker（每个 Worker 各持一份拷贝），
 *   同一文档的页就能分散到任意空闲 Worker 上跑；
 * - ocrPage 派给空闲 Worker，全部忙则排队；
 * - 池是懒创建的全局单例，首次使用前可用 prewarm 并行预热各 Worker 的模型。
 */
import OcrWorker from './ocrWorker?worker&inline'
import { b64ToBytes, type OcrLine } from './paddleOcr'

export interface OcrPageResult {
  lines: OcrLine[]
  height: number
}

interface PendingCall {
  resolve: (res: unknown) => void
  reject: (err: Error) => void
}

interface QueuedTask {
  run: (call: (msg: Record<string, unknown>, transfer?: Transferable[]) => void) => void
}

/** 自动并行度：4 核 1 路、8 核 2 路、12 核以上 3 路封顶（每路要吃掉模型+页面位图内存） */
export function autoPoolSize(): number {
  const cores = navigator.hardwareConcurrency ?? 4
  return Math.max(1, Math.min(3, Math.floor(cores / 4)))
}

/** Worker 全部阵亡时的错误文案：file:// 等受限环境下给用户看得懂的提示 */
const BROKEN_MSG =
  'OCR 识别线程启动失败：当前环境拦截了后台线程（Worker）。请用最新版 Edge/Chrome 重新打开本页面再试。'

export class OcrPool {
  readonly size: number
  private workers: Worker[] = []
  private idle: Worker[] = []
  private queue: QueuedTask[] = []
  private seq = 0
  private pending = new Map<number, PendingCall>()
  /** seq → 执行它的 Worker：Worker 猝死时好把挂在它身上的调用全部 reject 掉 */
  private seqWorker = new Map<number, Worker>()
  /** 所有 Worker 都失败后置位，后续调用直接拒绝，不再静默卡死；getOcrPool 据此重建 */
  broken = false

  constructor(size = autoPoolSize()) {
    this.size = size
    // 主线程把 __BIN__ 的 base64 解码一次，每个 Worker 克隆一份经 transfer 送进去
    //（Worker 有自己的全局域，看不到主线程的 window.__BIN__；网页版无 __BIN__ 时
    //  由 baseUrl 兜底，Worker 内走 HTTP 拉取模型）
    const injected = typeof window !== 'undefined' ? window.__BIN__ : undefined
    const det = injected?.det ? b64ToBytes(injected.det) : null
    const rec = injected?.rec ? b64ToBytes(injected.rec) : null
    const wasm = injected?.wasm ? b64ToBytes(injected.wasm) : null
    const dict = injected?.dict ?? ''
    const baseUrl = new URL(import.meta.env.BASE_URL || './', location.href).href
    for (let i = 0; i < size; i++) {
      const w = new OcrWorker()
      w.onmessage = (e: MessageEvent) => this.onMessage(w, e)
      // Worker 脚本加载失败/运行崩溃走这里：必须 reject 相关调用，否则页面永远卡在等待
      w.onerror = (e: Event) => this.onWorkerError(w, e)
      if (det && rec && wasm) {
        const parts = [det.slice(0), rec.slice(0), wasm.slice(0)]
        this.post(
          w,
          {
            seq: this.nextSeq(),
            cmd: 'init',
            bin: { det: parts[0].buffer, rec: parts[1].buffer, wasm: parts[2], dict },
            baseUrl,
          },
          parts.map((p) => p.buffer)
        )
      } else {
        this.post(w, { seq: this.nextSeq(), cmd: 'init', baseUrl })
      }
      this.workers.push(w)
      this.idle.push(w)
    }
  }

  /** 预热所有 Worker 的 OCR 引擎（并行加载模型） */
  prewarm(): void {
    if (this.broken) return
    for (const w of this.workers) {
      const seq = this.nextSeq()
      this.post(w, { seq, cmd: 'init' })
    }
  }

  /** 打开文档：buffer 克隆广播给所有 Worker，返回页数 */
  async openDoc(docId: string, buf: ArrayBuffer): Promise<number> {
    if (this.broken) throw new Error(BROKEN_MSG)
    const results = await Promise.all(
      this.workers.map((w) => {
        const seq = this.nextSeq()
        // 每个 Worker 一份拷贝（transfer 会 detach，原 buf 留给主线程拆分用）
        const copy = buf.slice(0)
        const p = this.expect<{ pageCount?: number }>(seq)
        this.post(w, { seq, cmd: 'open', docId, buf: copy }, [copy])
        return p
      })
    )
    return results[0].pageCount!
  }

  /** 识别一页；hd=true 时裁顶部区域放大+二值化（高清重试） */
  ocrPage(docId: string, pageIndex: number, hd = false): Promise<OcrPageResult> {
    if (this.broken) return Promise.reject(new Error(BROKEN_MSG))
    const seq = this.nextSeq()
    const p = this.expect<OcrPageResult>(seq)
    this.dispatch((call) => call({ seq, cmd: 'ocr', docId, pageIndex, hd }))
    return p
  }

  /** 关闭文档，所有 Worker 释放对应 pdfjs 实例 */
  async closeDoc(docId: string): Promise<void> {
    if (this.broken) return // 线程已死，无可释放；finally 里不能再抛错掩盖原始错误
    await Promise.all(
      this.workers.map((w) => {
        const seq = this.nextSeq()
        const p = this.expect(seq)
        this.post(w, { seq, cmd: 'close', docId })
        return p
      })
    )
  }

  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers = []
    this.idle = []
    this.queue = []
  }

  private nextSeq(): number {
    return ++this.seq
  }

  private expect<T>(seq: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, {
        resolve: resolve as PendingCall['resolve'],
        reject,
      })
    })
  }

  /** 统一的发送入口：记录 seq 由哪个 Worker 执行 */
  private post(w: Worker, msg: Record<string, unknown>, transfer: Transferable[] = []): void {
    if (typeof msg.seq === 'number') this.seqWorker.set(msg.seq, w)
    w.postMessage(msg, transfer)
  }

  /** 有空闲 Worker 立即派发，否则排队 */
  private dispatch(task: QueuedTask['run']): void {
    const w = this.idle.pop()
    if (w) {
      this.sendOn(w, task)
    } else {
      this.queue.push({ run: task })
    }
  }

  private sendOn(
    w: Worker,
    task: (call: (msg: Record<string, unknown>, transfer?: Transferable[]) => void) => void
  ): void {
    task((msg, transfer) => this.post(w, msg, transfer))
  }

  /** 把队列里的任务尽量派给当前空闲的 Worker（Worker 减员后调用） */
  private pump(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const w = this.idle.pop()!
      const next = this.queue.shift()!
      this.sendOn(w, next.run)
    }
  }

  /** Worker 加载失败或运行崩溃：摘除它、reject 它身上的调用；全灭则进入 broken 状态 */
  private onWorkerError(w: Worker, e: Event): void {
    const detail = e instanceof ErrorEvent && e.message ? `：${e.message}` : ''
    console.error('[ocrPool] Worker 错误', detail, e)
    this.workers = this.workers.filter((x) => x !== w)
    this.idle = this.idle.filter((x) => x !== w)
    try {
      w.terminate()
    } catch {
      /* 已死，忽略 */
    }
    for (const [seq, owner] of [...this.seqWorker]) {
      if (owner !== w) continue
      this.seqWorker.delete(seq)
      const call = this.pending.get(seq)
      if (call) {
        this.pending.delete(seq)
        call.reject(new Error(`OCR 线程执行失败${detail}`))
      }
    }
    if (this.workers.length === 0 && !this.broken) {
      this.broken = true
      const err = new Error(BROKEN_MSG)
      for (const [, call] of this.pending) call.reject(err)
      this.pending.clear()
      this.seqWorker.clear()
      this.queue = []
      return
    }
    this.pump()
  }

  private onMessage(w: Worker, e: MessageEvent): void {
    const res = e.data as { seq: number; ok: boolean; error?: string } & Record<string, unknown>
    this.seqWorker.delete(res.seq)
    const call = this.pending.get(res.seq)
    if (call) {
      this.pending.delete(res.seq)
      if (res.ok) call.resolve(res)
      else call.reject(new Error(res.error ?? 'Worker 处理失败'))
    }
    // 只有 ocr 类任务走排队调度；这里把 Worker 标记空闲并尝试消化队列
    if (!this.idle.includes(w)) {
      const next = this.queue.shift()
      if (next) this.sendOn(w, next.run)
      else this.idle.push(w)
    }
  }
}

let pool: OcrPool | null = null

/** 全局懒创建单例；上次全灭（broken）时重建一批，给用户重试的机会 */
export function getOcrPool(): OcrPool {
  if (pool?.broken) pool = null
  pool ??= new OcrPool()
  return pool
}
