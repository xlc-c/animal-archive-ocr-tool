// 回归断言 harness 构建脚本：把 tests/test-batch.entry.ts 打成 cjs，浏览器侧依赖全部打 stub
// （只测 extractArchiveRow / extractInfo / applyRoster 等纯函数，不碰 pdfjs/paddleOcr 运行时）
// 用法：node tests/stub-build.mjs && node tests/dist/test-batch.cjs
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '../app/package.json'))
const esbuild = require('esbuild')

const stubPlugin = {
  name: 'browser-dep-stub',
  setup(build) {
    build.onResolve({ filter: /pdfjs-dist|paddleOcr/ }, (args) => ({
      path: args.path,
      namespace: 'stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path.includes('paddleOcr')) {
        return {
          contents: `
            export const recognizeCanvasPaddle = async () => []
            export const initEngine = async () => null
            export const makeCanvas = () => { throw new Error('stub: no canvas in node') }
          `,
        }
      }
      if (args.path.includes('worker')) {
        return { contents: `export default class PdfWorkerStub {}` }
      }
      // pdf.mjs：ocr.ts 顶层会执行 pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()
      return {
        contents: `
          export const GlobalWorkerOptions = {}
          export const getDocument = () => { throw new Error('stub: no pdfjs in node') }
        `,
      }
    })
  },
}

await esbuild.build({
  entryPoints: [path.join(here, 'test-batch.entry.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: path.join(here, 'dist', 'test-batch.cjs'),
  plugins: [stubPlugin],
  logLevel: 'warning',
})
console.log('bundle ok -> tests/dist/test-batch.cjs')
