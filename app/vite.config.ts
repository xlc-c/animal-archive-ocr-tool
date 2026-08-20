import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// 构建后由 tools/make-offline.mjs 把 JS/CSS/模型/wasm 内联成单个 html，
// 产物既可部署为网站，也可下载后双击离线运行（file://）
export default defineConfig({
  base: './',
  plugins: [react()],
  // Worker 用 iife(classic) 格式构建：file:// 双击运行时，Chromium 内核会异步拒绝
  // blob: 的 module Worker（报 "Refused to cross-origin redirects of the top-level worker script"），
  // Vite 内联 Worker 的 catch 只兜同步异常、永远走不到 data: 兜底 → 卡死。
  // classic Worker 的 blob: 在 file:// 下实测正常（2026-08-20 有头 Edge 探针验证），
  // 且 classic 脚本里 dynamic import() 依然可用，onnxruntime 加载 wasm 工厂不受影响。
  worker: { format: 'iife' },
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
