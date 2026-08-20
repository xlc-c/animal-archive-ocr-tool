# 动物档案 OCR 工具（animal-archive-ocr-tool）

扫描版动物档案 PDF 的**本地识别、拆分、重命名**工具：把整本扫描合集拖进浏览器，自动逐页 OCR，按动物编号拆成单只一份的 PDF，并生成 Excel 档案汇总表（编号/性别/出生日期/父母编号/体重等）。

**全程本地运行，文件不上传任何服务器。** 无需安装任何软件——双击单个 html 文件即可使用（支持 file:// 离线直开）。

## 使用

从 [Releases](../../releases) 下载 `animal-archive-ocr.html`，双击打开（推荐 Edge/Chrome），拖入 PDF 即可。

- 支持整本多页合集、多文件批处理
- 按动物编号自动分段拆分，同编号连续页合并，中英文档案自动配对合并
- 单据类页面（合格证/检疫证明/检测报告/发票等）按标题 + 编号单独拆出
- 识别结果可在线预览、手动改名；可疑项（推定编号/低可信识别）自动高亮置顶待核对
- 输出：拆分重命名后的 PDF（ZIP 打包）+ Excel 汇总表 + OCR 原文对照

## 支持的版式

- 犬（耳号/芯片号行式档案）、猴（标签式个体档案）、猪（标签式档案）等扫描件
- 合集附检测表（编号清单）时自动对齐纠错、顺序推定糊掉的编号

## 从源码构建

```bash
cd app
bash rebuild.sh   # 需要 Node.js；产物在 app/dist-offline/index.html（单文件）
```

技术栈：Vite + React + TypeScript，OCR 为 PaddleOCR PP-OCRv4 mobile（onnxruntime-web WASM，多 Worker 并行），PDF 渲染 pdf.js、拆分 pdf-lib，全部内联为单个离线 html。

## 说明

- 仓库文档与注释中的示例编号/证号均为**虚构数据**，仅用于说明版式规则。
- 模型文件（`app/assets-bin/`）为 PaddleOCR 官方开源模型（Apache-2.0）。
