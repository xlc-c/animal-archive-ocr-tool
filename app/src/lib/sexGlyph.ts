/**
 * 性别格图像级分类：rec 模型的字典里没有 ♀/♂ 符号（实测 8 页猪档案：7 页整格丢弃、
 * 1 页误读成「早」），文字层无解，改为对「性别/Sex」值格裁片做像素形状判断：
 *   1) 必须有封闭圆孔——♀/♂ 都带圆圈；字母 M/F、汉字「早」没有 → null
 *   2) 左右镜像对称度：♀ 沿中轴对称（真实扫描件 0.895~0.985），♂ 的箭头破缺对称
 *      （渲染对照 0.52~0.86），阈值 0.87
 *   3) 方向由区域密度定：♀ = 圆下带十字 → 底部中央墨水 > 右上；♂ = 右上带箭头 → 右上 ≫ 底部
 * 阈值经 8 页真实猪档案 + 4 字体渲染对照组标定（见交接文档踩坑 29）。
 * 判不出返回 null（性别留空、走「待核对」人工补录），绝不瞎猜。
 * 纯函数、无 DOM 依赖，方便离线断言测试。
 */
export function classifySexGlyph(
  data: Uint8ClampedArray,
  w: number,
  h: number
): 'M' | 'F' | null {
  // 二值化（亮度 < 128 为墨水）
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    bin[i] = data[o] + data[o + 1] + data[o + 2] < 384 ? 1 : 0
  }
  // 墨水包围盒
  let x0 = w
  let x1 = -1
  let y0 = h
  let y1 = -1
  let cnt = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue
      cnt++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (cnt < 10) return null
  const gw = x1 - x0 + 1
  const gh = y1 - y0 + 1
  if (gw < 12 || gh < 12) return null
  const dens = cnt / (gw * gh)
  if (dens < 0.02 || dens > 0.6) return null
  // 裁出字形局部网格
  const g = new Uint8Array(gw * gh)
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) g[y * gw + x] = bin[(y0 + y) * w + (x0 + x)]
  }
  // 封闭孔洞：从边界洪泛白色区，未到达的白像素 = 孔
  const seen = new Uint8Array(gw * gh)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    const i = y * gw + x
    if (!g[i] && !seen[i]) {
      seen[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < gw; x++) {
    push(x, 0)
    push(x, gh - 1)
  }
  for (let y = 0; y < gh; y++) {
    push(0, y)
    push(gw - 1, y)
  }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % gw
    const y = (i / gw) | 0
    if (x > 0) push(x - 1, y)
    if (x < gw - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < gh - 1) push(x, y + 1)
  }
  let hole = 0
  for (let i = 0; i < gw * gh; i++) if (!g[i] && !seen[i]) hole++
  if (hole < 0.04 * gw * gh) return null // 字母 M/F 等无圆孔 → 不是 ♀/♂
  // 左右镜像一致率（♀ 对称；♂ 的箭头在右上，破缺对称）
  const half = gw >> 1
  let match = 0
  let tot = 0
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < half; x++) {
      if (g[y * gw + x] === g[y * gw + (gw - 1 - x)]) match++
      tot++
    }
  }
  const sym = tot ? match / tot : 0
  // 区域密度：底部中央（♀ 十字） vs 右上角（♂ 箭头）
  const zone = (xa: number, xb: number, ya: number, yb: number) => {
    const xi0 = Math.floor(xa * gw)
    const xi1 = Math.max(Math.ceil(xb * gw), xi0 + 1)
    const yi0 = Math.floor(ya * gh)
    const yi1 = Math.max(Math.ceil(yb * gh), yi0 + 1)
    let s = 0
    let n = 0
    for (let y = yi0; y < yi1; y++) {
      for (let x = xi0; x < xi1; x++) {
        s += g[y * gw + x]
        n++
      }
    }
    return s / n
  }
  const bc = zone(0.28, 0.72, 0.62, 1)
  const tr = zone(0.7, 1, 0, 0.3)
  if (sym >= 0.87) return bc > 0.15 && bc > tr ? 'F' : null
  return tr > 0.25 && tr > bc * 1.3 ? 'M' : null
}
