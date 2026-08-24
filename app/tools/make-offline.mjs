/**
 * 构建后内联脚本：把 dist 的入口 JS/CSS + assets-bin 的模型/wasm/字典
 * 合成单个 html（分块流式写入，内存占用低）。
 * 产物既可部署为网站，也可下载后双击离线运行（file://）。
 * 用法：node tools/make-offline.mjs <distDir> <binDir> <outHtml>
 */
import fs from 'node:fs'
import path from 'node:path'

const [distDir, binDir, outHtml] = process.argv.slice(2)
if (!distDir || !binDir || !outHtml) {
  console.error('usage: node tools/make-offline.mjs <distDir> <binDir> <outHtml>')
  process.exit(1)
}

const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')

// ---- 找入口 JS 引用 ----
const jsRe = /<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/
const jsMatch = html.match(jsRe)
if (!jsMatch) throw new Error('未找到入口 JS 引用：' + html.slice(0, 500))
const jsContent = fs.readFileSync(path.join(distDir, jsMatch[1]), 'utf8')
if (jsContent.includes('</script>'))
  throw new Error('JS 内含 </script> 字面量，需转义')

// ---- 找 CSS 引用并内联（CSS 体积小，直接字符串替换）----
let out2 = html
const cssRe = /<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/
const cssMatch = out2.match(cssRe)
if (cssMatch) {
  const css = fs.readFileSync(path.join(distDir, cssMatch[1]), 'utf8')
  out2 = out2.replace(cssRe, () => `<style>${css}</style>`)
}

// 清理外部引用（favicon 等 file:// 下加载不到也无妨，直接去掉避免控制台报错）
out2 = out2.replace(/<link rel="icon"[^>]*>/g, '')

// ---- 以入口 JS 标签为界，拆分前后两段 ----
const idx = out2.indexOf(jsMatch[0])
if (idx < 0) throw new Error('入口 JS 标签定位失败')
const pre = out2.slice(0, idx)
const post = out2.slice(idx + jsMatch[0].length)

// ---- 流式输出 ----
const out = fs.createWriteStream(outHtml)
const w = (s) => new Promise((res, rej) => out.write(s, (e) => (e ? rej(e) : res())))

/** 分块读取文件并 base64 编码写入（3 字节对齐保证编码连续） */
async function writeB64(file) {
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  const CHUNK = 3 * 1024 * 1024 // 3MB 对齐
  let pos = 0
  try {
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, pos)
      await w(buf.toString('base64'))
      pos += len
    }
  } finally {
    fs.closeSync(fd)
  }
}

await w(pre)
// __BIN__ 必须在应用脚本之前（经典脚本解析期即执行，module 脚本延迟执行，顺序有保证）
await w('<script>window.__BIN__={det:"')
await writeB64(path.join(binDir, 'det.onnx'))
await w('",rec:"')
await writeB64(path.join(binDir, 'rec.onnx'))
// cls 方向分类模型（180° 倒置页检测）：文件存在才注入，老构建目录没有它也能出包
if (fs.existsSync(path.join(binDir, 'cls.onnx'))) {
  await w('",cls:"')
  await writeB64(path.join(binDir, 'cls.onnx'))
}
await w('",wasm:"')
await writeB64(path.join(binDir, 'ort.wasm'))
await w('",dict:')
await w(JSON.stringify(fs.readFileSync(path.join(binDir, 'dict.txt'), 'utf8')))
await w('};</script>')
await w(`<script type="module">${jsContent}</script>`)

// ---- 完整性自检：构建期算好各内嵌资源的 FNV-1a 校验值，运行期复核 ----
// 40MB 单文件在下载/另存过程中字节损坏会表现为各种莫名报错（踩坑：预览无反应实为包损坏），
// 启动时花 <1s 校验，损坏则明确提示重新下载。
const fnv = (s) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16) + ':' + s.length
}
const b64Of = (f) => fs.readFileSync(f).toString('base64')
const expected = {
  js: fnv(jsContent),
  det: fnv(b64Of(path.join(binDir, 'det.onnx'))),
  rec: fnv(b64Of(path.join(binDir, 'rec.onnx'))),
  wasm: fnv(b64Of(path.join(binDir, 'ort.wasm'))),
  dict: fnv(fs.readFileSync(path.join(binDir, 'dict.txt'), 'utf8')),
}
const hasCls = fs.existsSync(path.join(binDir, 'cls.onnx'))
if (hasCls) expected.cls = fnv(b64Of(path.join(binDir, 'cls.onnx')))
await w(`<script>;setTimeout(function(){try{function fv(s){var h=0x811c9dc5;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)}return (h>>>0).toString(16)+":"+s.length}var exp=${JSON.stringify(expected)};var B=window.__BIN__||{};var bad=[];var mod=document.querySelector('script[type="module"]');if(!mod||fv(mod.textContent)!==exp.js)bad.push("\u4e3b\u7a0b\u5e8f");var items=[["\u68c0\u6d4b\u6a21\u578b","det"],["\u8bc6\u522b\u6a21\u578b","rec"],["\u63a8\u7406\u5e93","wasm"],["\u5b57\u5178","dict"]];if(exp.cls)items.push(["\u65b9\u5411\u6a21\u578b","cls"]);for(var q=0;q<items.length;q++){var k=items[q][1];if(typeof B[k]!=="string"||fv(B[k])!==exp[k])bad.push(items[q][0])}if(bad.length)(window.__showErr||alert)("\u6587\u4ef6\u5df2\u635f\u574f\uff1a"+bad.join("\u3001")+"\u6821\u9a8c\u5931\u8d25\u3002\u8bf7\u91cd\u65b0\u4e0b\u8f7d\u672c\u5de5\u5177\uff0c\u5426\u5219\u4f1a\u51fa\u73b0\u83ab\u540d\u62a5\u9519\u3002")}catch(_){}},500);</script>`)
await w(post)
await new Promise((res) => out.end(res))

const mb = (fs.statSync(outHtml).size / 1e6).toFixed(1)
console.log(`OK ${outHtml} (${mb} MB)`)
