import fs from "node:fs"
import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

// wasm 文件 base64 内联插件（?b64 查询）：Vite 自带的 wasm 插件会接管 .wasm 导入，
// ?inline 对 .wasm 不生效（构建报 "Unexpected character '\0'"），故自建查询后缀。
// 用于把 pdfjs-dist 的 openjpeg.wasm（JPXDecode/JPEG2000 解码器）base64 内嵌进包。
function wasmB64(): Plugin {
  return {
    name: 'wasm-b64',
    enforce: 'pre',
    load(id) {
      if (!id.endsWith('.wasm?b64')) return null
      const file = id.slice(0, -'?b64'.length)
      const b64 = fs.readFileSync(file).toString('base64')
      return `export default ${JSON.stringify(b64)}`
    },
  }
}

// 构建后由 tools/make-offline.mjs 把 JS/CSS/模型/wasm 内联成单个 html，
// 产物既可部署为网站，也可下载后双击离线运行（file://）
export default defineConfig({
  base: './',
  plugins: [wasmB64(), react()],
  // Worker 用 iife(classic) 格式构建：file:// 双击运行时，Chromium 内核会异步拒绝
  // blob: 的 module Worker（报 "Refused to cross-origin redirects of the top-level worker script"），
  // Vite 内联 Worker 的 catch 只兜同步异常、永远走不到 data: 兜底 → 卡死。
  // classic Worker 的 blob: 在 file:// 下实测正常（2026-08-20 有头 Edge 探针验证），
  // 且 classic 脚本里 dynamic import() 依然可用，onnxruntime 加载 wasm 工厂不受影响。
  worker: {
    format: 'iife',
    // worker 子构建（ocrWorker）用独立的 rollup 实例，默认不带主配置插件，
    // 必须显式挂上 wasmB64，否则 worker 里的 openjpeg.wasm?b64 导入无法内联
    plugins: () => [wasmB64()],
  },
  build: {
    // onnxruntime 的 wasm 走独立文件（运行时由 paddleOcr.ts 的 fetch 拦截提供内嵌字节），
    // 其余资源（字体/pdf.worker 等）全部内联
    assetsInlineLimit: (filePath: string) =>
      filePath.endsWith('.wasm') ? false : true,
    chunkSizeWarningLimit: 100 * 1024,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
