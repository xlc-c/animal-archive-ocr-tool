/**
 * CTC 贪心解码（PP-OCR rec 输出 → 文本）。
 * 独立成模块：纯函数无依赖，离线断言 harness 可直接测（paddleOcr 整体被 stub 替代）。
 *
 * top-2 候选（alts）：编号单字符误读（0/O、6/5 等）时，正确字符常是该时间步的次优解。
 * 记录每个已发射字符位上的 top2，按概率比取最高 2 个分歧位各生成一个单字符替换串，
 * 供花名册组合纠错选优（见 ocr.ts applyRoster）。
 */

export interface CtcResult {
  text: string
  confidence: number
  /** top-2 单字符替换候选（最多 2 个，不含 text 本身） */
  alts: string[]
}

/** top2/top1 概率比门槛：低于此值的次优解没有纠偏价值 */
const ALT_RATIO = 0.25

export function ctcDecode(probs: Float32Array, t: number, dims: number, keys: string[]): CtcResult {
  const idxs: number[] = []
  // 分歧位：已发射字符的输出位置 + 该时间步 top2 字符
  const divs: { pos: number; altIdx: number; ratio: number }[] = []
  let prev = -1
  let confSum = 0
  let confCnt = 0
  for (let i = 0; i < t; i++) {
    let best = 0
    let bestP = 0
    let second = -1
    let secondP = 0
    const off = i * dims
    for (let j = 0; j < dims; j++) {
      const p = probs[off + j]
      if (p > bestP) {
        second = best
        secondP = bestP
        bestP = p
        best = j
      } else if (p > secondP) {
        second = j
        secondP = p
      }
    }
    if (best !== 0 && best !== prev) {
      if (second > 0 && second !== best && bestP > 0 && secondP / bestP >= ALT_RATIO) {
        divs.push({ pos: idxs.length, altIdx: second, ratio: secondP / bestP })
      }
      idxs.push(best)
      confSum += bestP
      confCnt++
    } else if (best !== 0) {
      confSum += bestP
      confCnt++
    }
    prev = best
  }
  // dict.txt 首行是 'blank' 占位，idx 直接对应 keys[idx]（idx0=blank 已滤掉）；
  // 末尾空格 token 上层会去掉所有空白，这里忽略
  const charAt = (idx: number) =>
    idx >= 1 && idx < keys.length && keys[idx] !== 'blank' ? keys[idx] : ''
  let text = ''
  for (const idx of idxs) text += charAt(idx)
  // 单字符替换候选：取概率比最高的 2 个分歧位
  const alts: string[] = []
  divs.sort((a, b) => b.ratio - a.ratio)
  for (const d of divs.slice(0, 2)) {
    const ch = charAt(d.altIdx)
    if (!ch || d.pos >= text.length) continue
    const alt = text.slice(0, d.pos) + ch + text.slice(d.pos + 1)
    if (alt !== text && !alts.includes(alt)) alts.push(alt)
  }
  return { text, confidence: confCnt > 0 ? confSum / confCnt : 0, alts }
}
