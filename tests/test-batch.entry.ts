// 纯逻辑回归断言（node 运行，经 stub-build.mjs 打包；浏览器依赖已打 stub）
// 覆盖 v1.1.4 三项修复 + 历史核心回归（踩坑 53 名册字母簇优先 / 装箱单拦截 / 病毒行粘连）
import {
  extractArchiveRow,
  extractInfo,
  applyRoster,
  type OcrLine,
  type RosterPage,
} from '../app/src/lib/ocr'

let pass = 0
let fail = 0
function eq<T>(name: string, got: T, want: T) {
  const ok = Object.is(got, want)
  if (ok) {
    pass++
    console.log(`PASS ${name}`)
  } else {
    fail++
    console.log(`FAIL ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
  }
}
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++
    console.log(`PASS ${name}`)
  } else {
    fail++
    console.log(`FAIL ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`)
  }
}

/** 编造 OcrLine（bbox 按自上而下坐标） */
function L(text: string, x0: number, y0: number, x1: number, y1: number): OcrLine {
  return { text, confidence: 1, bbox: { x0, y0, x1, y1 } }
}
function row(debugText: string, animalId = 'B265001') {
  return extractArchiveRow({
    debug: [debugText],
    animalId,
    sourceName: 'test.pdf',
    pageRange: '1',
  })
}

// ── a. 体重分行猪版式：「体重/Bodyweight:（kg）」下一行「8.9」→ 8.9 ──
{
  const r = row('动物编号：B265001\n性别/Gender\n体重/Bodyweight:（kg）\n8.9')
  eq('a 体重分行猪版式=8.9', r['最新体重(kg)'], '8.9')
}

// ── b. 体重分行猴版式：体重/DateofBirth/Weight(kg)/2.30 → 2.30 ──
{
  const r = row('动物编号 027\n体重\nDateofBirth\nWeight(kg)\n2.30', '027')
  eq('b 体重分行猴版式=2.30', r['最新体重(kg)'], '2.30')
}

// ── c. 体重同行版式不回归：「体重 8.5」→ 8.5 ──
{
  const r = row('动物编号：B265002\n性别/Sex F\n体重 8.5\n体检记录正常', 'B265002')
  eq('c 体重同行版式=8.5', r['最新体重(kg)'], '8.5')
}

// ── d. 性别同行双语不回归：「性别/Sex M」→ M ──
{
  const r = row('动物编号：B265005\n性别/Sex M\n体重 8.5', 'B265005')
  eq('d 性别同行双语=M', r.性别, 'M')
}

// ── e. 性别分行有值：「性别」下一行「♀」→ F ──
{
  const r = row('动物编号：B265003\n性别\n♀\n体重 7.2', 'B265003')
  eq('e 性别分行♀=F', r.性别, 'F')
  eq('e 附带体重=7.2', r['最新体重(kg)'], '7.2')
}

// ── f. 性别分行无值：「性别/Gender」下一行是体重标签 → 未识别（绝不硬猜）──
{
  const r = row('动物编号：B265001\n性别/Gender\n体重/Bodyweight:（kg）\n8.9')
  eq('f 性别分行无值=未识别', r.性别, '')
}

// ── a2. 体重「最后一次称重」跨版式语义：分行在前、同行在后 → 同行（位置靠后）赢 ──
{
  const r = row('体重/Bodyweight:（kg）\n8.9\n备注\n体重 9.4')
  eq('a2 分行在前同行在后=9.4', r['最新体重(kg)'], '9.4')
}
// ── a3. 反向：同行在前、分行在后 → 分行（位置靠后）赢 ──
{
  const r = row('体重 9.4\n备注\n体重/Bodyweight:（kg）\n8.9')
  eq('a3 同行在前分行在后=8.9', r['最新体重(kg)'], '8.9')
}

// ── g. isFormDoc 含「装箱」：装箱单标题页不从候选池抓编号 ──
{
  const info = extractInfo(
    [
      L('实验动物装箱单', 200, 10, 500, 40),
      L('A123456', 50, 100, 150, 118),
      L('目的地 上海', 50, 140, 200, 158),
    ],
    1000
  )
  eq('g 装箱单标题不抓候选池', info.animalId, null)
  // 对照组：同版式、标题无单据关键词时候选池本应抓到（证明断言有效）
  const ctrl = extractInfo(
    [
      L('实验动物运输明细', 200, 10, 500, 40),
      L('A123456', 50, 100, 150, 118),
      L('目的地 上海', 50, 140, 200, 158),
    ],
    1000
  )
  eq('g 对照组候选池正常取值', ctrl.animalId, 'A123456')
}

// ── h. 装箱单文字层版式：37 个同形态编号页 → listPage=true, animalId=null ──
{
  const lines: OcrLine[] = [
    L('实验动物装箱单', 200, 10, 500, 40),
    L('装箱日期：2026-09-03', 50, 60, 300, 76),
  ]
  for (let i = 0; i < 37; i++) {
    lines.push(L(String(8343501 + i), 50, 100 + i * 20, 150, 116 + i * 20))
  }
  const info = extractInfo(lines, 900)
  eq('h 装箱单37编号页 listPage', info.listPage, true)
  eq('h 装箱单37编号页 animalId', info.animalId, null)
}

// ── i. 群体档案病毒行粘连变体：STLV-1/SRV/BV 表头粘连 token 不当编号 ──
{
  const info = extractInfo(
    [
      L('猴群体健康档案', 200, 10, 500, 42),
      L('猴号 A190123', 50, 80, 260, 98),
      L('病毒检测', 50, 120, 200, 138),
      L('STLV-1（-）', 50, 140, 220, 158),
      L('SRV（-）BV（-）', 50, 160, 280, 178),
    ],
    1000
  )
  eq('i 病毒行粘连不误当编号', info.animalId, 'A190123')
  ok(
    'i 病毒 token 未入候选',
    !info.idCandidates.some((c) => c.includes('STLV') || c === 'SRV' || c === 'BV'),
    info.idCandidates
  )
}

// ── j. 花名册字母前缀优先不回归（踩坑 53 核心）：OD 值 4 位纯数字簇 32 个 + B 编号簇 18 个
//        → 名册必须是 B 编号簇，pool 垃圾尾巴编号纠回 B265003 ──
{
  const odValues = Array.from({ length: 32 }, (_, i) => String(1000 + i * 37)) // 4 位纯数字簇
  const bIds = Array.from({ length: 18 }, (_, i) => `B2650${String(1 + i).padStart(2, '0')}`)
  const pages: RosterPage[] = [
    { idCandidates: [...odValues, ...bIds] }, // 抗体检测表页：OD 大簇 + 名册簇同页
    { animalId: 'B265003N', idSource: 'pool', idCandidates: ['B265003N'] },
  ]
  const n = applyRoster(pages)
  eq('j 名册规模=18（B 编号簇，非 OD 值簇）', n, 18)
  eq('j pool 尾巴粘连纠回名册', pages[1].animalId, 'B265003')
  eq('j 纠错标记', pages[1].corrected, true)
  eq('j 检测表页判为花名册清单页', pages[0].rosterPage, true)
}

console.log(`\n==== ${pass}/${pass + fail} PASS ====`)
if (fail > 0) process.exit(1)
