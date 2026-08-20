/**
 * 断点续跑缓存：每页 OCR 结果（debug 文本 + 提取信息）存 IndexedDB。
 * 场景：整本合集跑到一半被打断（关页/崩溃/手动停止），下次拖入同一文件时
 * 已完成页直接命中缓存，只对剩余页做 OCR；全部命中时无需 OCR 直接拆分。
 *
 * 设计约束：
 * - 缓存永不阻塞主流程：所有操作失败（隐私模式/配额满）都静默降级为无缓存
 * - 只存「页级最终结果」（含高清/编号格重试后的 info）；花名册纠错/推定是
 *   文档级后处理，依赖整本页集合与外部清单，每次运行重算，不入缓存
 * - LRU：最多保留最近 6 个文件的缓存，防止 IndexedDB 无限膨胀
 */

/** 每页缓存的内容（PageInfo 里去掉了 guessed/corrected/rosterPage 等运行期字段） */
export interface PageCacheEntry {
  debug: string
  info: {
    title?: string
    animalId?: string
    idSource?: 'label' | 'filename' | 'pool' | 'fallback' | null
    idCandidates?: string[]
  }
}

const DB_NAME = 'ocr-page-cache'
const STORE = 'pages'
const META = 'meta'
const MAX_FILES = 6

interface CacheHandle {
  get(fileKey: string, pageIndex: number): Promise<PageCacheEntry | null>
  put(fileKey: string, pageIndex: number, entry: PageCacheEntry): void
  /** 记录文件元信息（LRU 用），并异步修剪超限旧文件 */
  touch(fileKey: string, pageCount: number): void
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE)
      req.result.createObjectStore(META)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function reqDone(req: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/** 打开缓存；环境不支持/被拒绝时返回 null（调用方按无缓存处理） */
export async function openPageCache(): Promise<CacheHandle | null> {
  try {
    const db = await openDb()
    return {
      get(fileKey, pageIndex) {
        return new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE, 'readonly')
            const req = tx.objectStore(STORE).get(`${fileKey}#${pageIndex}`)
            req.onsuccess = () => resolve((req.result as PageCacheEntry | undefined) ?? null)
            req.onerror = () => resolve(null)
          } catch {
            resolve(null)
          }
        })
      },
      put(fileKey, pageIndex, entry) {
        try {
          const tx = db.transaction(STORE, 'readwrite')
          tx.objectStore(STORE).put(entry, `${fileKey}#${pageIndex}`)
        } catch {
          /* 写失败当无缓存 */
        }
      },
      touch(fileKey, pageCount) {
        ;(async () => {
          try {
            const tx = db.transaction(META, 'readwrite')
            await reqDone(tx.objectStore(META).put({ pageCount, updatedAt: Date.now() }, fileKey))
          } catch {
            return
          }
          // 修剪：meta 超过 MAX_FILES 时，连页带 meta 删除最旧的文件
          try {
            const keys = (await new Promise<IDBValidKey[]>((res, rej) => {
              const r = db.transaction(META, 'readonly').objectStore(META).getAllKeys()
              r.onsuccess = () => res(r.result)
              r.onerror = () => rej(r.error)
            })) as string[]
            if (keys.length <= MAX_FILES) return
            const vals = await Promise.all(
              keys.map(
                (k) =>
                  new Promise<{ k: string; t: number }>((res, rej) => {
                    const r = db.transaction(META, 'readonly').objectStore(META).get(k)
                    r.onsuccess = () =>
                      res({ k, t: (r.result as { updatedAt?: number } | undefined)?.updatedAt ?? 0 })
                    r.onerror = () => rej(r.error)
                  })
              )
            )
            vals.sort((a, b) => a.t - b.t)
            const drop = vals.slice(0, vals.length - MAX_FILES).map((v) => v.k)
            const wtx = db.transaction([STORE, META], 'readwrite')
            for (const k of drop) {
              wtx.objectStore(META).delete(k)
              // 页记录 key 以 `${fileKey}#` 为前缀，用区间一次性删（每文件最多几百条）
              wtx.objectStore(STORE).delete(IDBKeyRange.bound(`${k}#`, `${k}#￿`))
            }
          } catch {
            /* 修剪失败无碍 */
          }
        })()
      },
    }
  } catch {
    return null
  }
}
