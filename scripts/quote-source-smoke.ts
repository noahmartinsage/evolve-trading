/**
 * 行情来源凭据烟测
 *
 * ── 它守的是什么 ──────────────────────────────────────────────────────
 * 一条红线：**「这个数是谁给的」必须能从数据里读出来，不许是屏幕上拼的字符串。**
 *
 * 本轮修掉的是一个**假绿**：门禁 `U29d` 断言的是「旧的 `K线 · Binance` 字面量
 * 已经不在 `CandleChart` 里了」—— 那条一直是绿的，因为那句话只是被**搬到了调用点**：
 *   `sourceLabel={klineState === 'ok' ? 'Binance' : 'Binance（上次成功）'}`
 * 于是"引进了第二个数据源"之后，第二个源答话时屏幕仍写 Binance。
 * ⇒ 断言"某个旧字面量不在了"**不等于**断言"这个事实现在有了出处"（判据 34）。
 *   这里改成断**那个位置不许出现任何品牌名**，且**来源必须从数据层来**。
 *
 * ── 为什么纯逻辑断言也要在这里（而不是只查源码）──────────────────────
 * 源码扫描只能证明"写了这几行"，证明不了"回退链真的按顺序试、真的记健康账、
 * 真的在旧数据上拒收"。所以两组都要有，且**用夹具证明第二组有牙**。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  AllSourcesFailedError,
  StaleSourceError,
  ageWords,
  assertFresh,
  resetSourceHealth,
  sourceHealth,
  withSourceFallback,
} from '../src/market/quoteSource.ts'

const ROOT = process.cwd()
let pass = 0
let fail = 0
/**
 * 失败清单。
 *
 * ★ 这个格式不是装饰：`_mutate_quote.mjs`（变异验证）**只认烟测自己打印的汇总行**
 *   与这份清单。少了它，变异探针会得到"0 条红"，而那与"断言没有牙"长得一模一样
 *   —— 上一轮就是这么误判过一次的（见 `_mutate_lib.mjs` 顶部）。
 */
const failed: { id: string; what: string }[] = []

function ok(id: string, cond: boolean, what: string): void {
  if (cond) {
    pass++
    console.log('  ✅ ' + id + ' ' + what)
  } else {
    fail++
    failed.push({ id, what })
    console.log('  ❌ ' + id + ' ' + what)
  }
}

function eq(id: string, actual: unknown, expected: unknown, what: string): void {
  ok(id, JSON.stringify(actual) === JSON.stringify(expected), what + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）')
}

/** 读源码，**先剥掉注释**。★ 不剥的话，注释里提到品牌名会让断言假绿（判据 32）。 */
function readCode(rel: string): string {
  const t = readFileSync(join(ROOT, rel), 'utf8')
  return t
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

async function main(): Promise<void> {
  console.log('【一】回退链的语义（用夹具，不碰网络）')

  resetSourceHealth()
  let secondCalled = 0
  const chain = await withSourceFallback('取一个数', [
    {
      name: '甲源',
      run: async () => {
        throw new Error('甲源 503')
      },
    },
    {
      name: '乙源',
      run: async () => {
        secondCalled++
        return { v: 42 }
      },
    },
    {
      name: '丙源',
      run: async () => {
        throw new Error('丙源不该被调用 —— 甲失败后乙已经成功了')
      },
    },
  ])
  eq('Q1 取第一个成功的', chain.value, { v: 42 }, '值来自乙源')
  // ★ 来源名**跟着数据走**：这就是屏幕上那行字的唯一出处
  eq('Q2 来源是数据的一部分', chain.source, '乙源', 'source 记录「谁给的」')
  eq('Q3 成功的那个也留在 tried 里', chain.tried.map((t) => t.name), ['甲源', '乙源'], '试过哪些源可追溯')
  ok('Q4 成功即止（不试后面的）', secondCalled === 1 && chain.tried.length === 2, '甲失败 → 乙成功 → 丙不再被调用')
  ok('Q5 值带年龄', typeof chain.atMs === 'number' && chain.atMs > 0, 'atMs 让消费方能算"这个数多旧"')

  resetSourceHealth()
  const firstErr = chain.tried[0].error ?? ''
  ok(
    'Q6 失败的源不被吞掉',
    firstErr.includes('503'),
    '甲源的错误原样留在 tried 里（"都取不到"要能说清各自为什么）',
  )

  resetSourceHealth()
  let threw: unknown = null
  try {
    await withSourceFallback('取一个数', [
      { name: '甲源', run: () => Promise.reject(new Error('甲源超时')) },
      { name: '乙源', run: () => Promise.reject(new Error('乙源 429')) },
    ])
  } catch (e) {
    threw = e
  }
  ok('Q7 全失败要抛，不许返回占位值', threw instanceof AllSourcesFailedError, '拿不到就是拿不到，不给 0 / 空数组')
  const allTried = threw instanceof AllSourcesFailedError ? threw.tried : []
  eq('Q8 异常里带着逐条证据', allTried.map((t) => t.ok), [false, false], '两条都是失败')
  ok(
    'Q9 异常文案点名到源',
    threw instanceof AllSourcesFailedError && threw.message.includes('甲源') && threw.message.includes('乙源'),
    '一条能直接看出"该去修哪个源"的消息',
  )

  resetSourceHealth()
  await withSourceFallback('取一个数', [{ name: '甲源', run: () => Promise.resolve(1) }])
  try {
    await withSourceFallback('取一个数', [{ name: '甲源', run: () => Promise.reject(new Error('挂了')) }])
  } catch {
    /* 预期内 */
  }
  const h = sourceHealth().find((x) => x.name === '甲源')
  eq('Q10 健康账记成败', [h?.ok, h?.failed], [1, 1], '同一来源的成功/失败分别累计')
  ok('Q11 健康账记延迟', typeof h?.lastLatencyMs === 'number' && (h?.lastError ?? '').includes('挂了'), '延迟与最后一条错误都留下来了')

  console.log('【二】旧数据必须拒收（这是**故意不学**上游的一处）')
  const old = { value: 1, source: '甲源', atMs: 100_000, tried: [] }
  /**
   * ★ 时钟**注入**，不取 `Date.now()`。
   *
   *   第一版写的是 `atMs: Date.now() - 60_000` 然后断言年龄**恰好等于** 60000 ——
   *   可年龄是在 `assertFresh` 内部用**另一次** `Date.now()` 算的，
   *   两次读取差 1 毫秒就变成 60001。连跑 6 次里红了 1 次。
   *   ⇒ 判据 31（两个数口径不同就不能相减）与判据 16（会随机变红的门禁）
   *     的同一条：**把时钟传进去，让它变成确定的**。
   */
  const NOW = old.atMs + 60_000
  let staleErr: unknown = null
  try {
    assertFresh(old, 30_000, NOW)
  } catch (e) {
    staleErr = e
  }
  ok('Q12 超龄要抛', staleErr instanceof StaleSourceError, '60 秒前的值、上限 30 秒 ⇒ 拒收')
  eq('Q13 拒收要说出年龄与来源', [staleErr instanceof StaleSourceError ? staleErr.source : '', staleErr instanceof StaleSourceError ? staleErr.ageMs : -1], ['甲源', 60_000], '不然没法判断"是慢还是坏了"')
  let freshThrew = false
  try {
    assertFresh({ ...old, atMs: NOW - 1000 }, 30_000, NOW)
  } catch {
    freshThrew = true
  }
  ok('Q14 没超龄就放行', !freshThrew, '★ 这条防 Q12「永远抛」的假绿：上限内的值必须过')
  eq('Q15 年龄说人话', [ageWords(0, 1000), ageWords(0, 20_000), ageWords(0, 300_000)], ['刚刚', '20 秒前', '5 分钟前'], '屏幕上要显示的是这个，不是时间戳')

  console.log('【三】接线：来源必须从数据层来（源码扫描）')
  const term = readCode('src/pages/TerminalPage.tsx')
  const app = readCode('src/App.tsx')
  const market = readCode('src/data/market.ts')
  const qs = readCode('src/market/quoteSource.ts')

  // ★ 位置级断言：图上那行来源所在的**表达式**里不许有品牌名。
  const labelLine = term.split('\n').find((l) => l.includes('sourceLabel=')) ?? ''
  ok('Q16 抽到了那行（否则下面两条是空串上变绿）', labelLine.length > 0, 'sourceLabel= 那一行确实存在')
  ok('Q17 来源不许写死品牌名', !/['"`][^'"`]*Binance/.test(labelLine), '原文：' + labelLine.trim().slice(0, 90))
  ok('Q18 来源读的是数据', labelLine.includes('klineSrc.source'), '唯一出处是 fetchKlines 带回来的凭据')
  ok('Q19 年龄一起显示', labelLine.includes('ageWords('), '只写来源不够 —— 旧数据与当前价在屏幕上长得一样')

  // ★ 视图层整体不许出现品牌名：只搬走一处、别处再写一个，是最容易漏的形态。
  ok('Q20 终端页通篇没有品牌名', !term.includes('Binance'), '品牌名只能来自数据，不是常量')
  ok(
    'Q21 行情提示的来源也来自数据',
    app.includes('已接入 ${source}') && !app.includes('Binance'),
    'toast 里那句"已接入 X"原来写死 Binance',
  )

  ok('Q22 两个入口都走回退链', (market.match(/withSourceFallback\(/g) ?? []).length === 2, '快照与 K 线各一次')
  /*
   * ★ 抽取必须**从 `= [` 之后开始**。
   *   第一版写的是 `const KLINE_SOURCES[\s\S]*?\n\]`，于是把**类型标注**里的
   *   `{ name: string; base: string }` 也圈进来了 —— 数 `name:` 时它算一条，
   *   于是"只剩一个源"的变异**照样 ≥2、照样绿**（M8 实测没抓到）。
   *   判据 32 的同族：正则量到的**不是**它声称要量的那个东西。
   */
  const srcBlock = market.match(/const KLINE_SOURCES[\s\S]*?= \[([\s\S]*?)\n\]/)?.[1] ?? ''
  ok('Q23a 抽到了 KLINE_SOURCES 的**元素区**', srcBlock.length > 0 && !srcBlock.includes('base: string'), '（抽到的必须是数据，不是类型标注）')
  ok(
    'Q23b K 线源不止一个（否则回退链是摆设）',
    (srcBlock.match(/\{\s*name:/g) ?? []).length >= 2,
    '元素区里数出 ' + String((srcBlock.match(/\{\s*name:/g) ?? []).length) + ' 个源',
  )
  ok('Q24 来源名可分辨', /Binance · data-api/.test(srcBlock) && /Binance · api/.test(srcBlock), '两个端点同名同姓 ⇒ 回退生效时屏幕上看不出差别')

  ok('Q25 拉取层不许返回裸数组', /fetchKlines[\s\S]{0,200}Promise<Sourced<Candle\[\]>>/.test(market), '裸数组让"谁给的、多旧"在类型上无法表达')
  ok('Q26 stale 有上界且会抛', /export function assertFresh/.test(qs) && /throw new StaleSourceError/.test(qs), '★ 上游是"静默返回任意旧值"，这里必须拒收')
  ok('Q27 没有"静默返回旧值"的口子', !/staleGet|staleStore/.test(qs), '那个口子一旦存在，忘一处检查就静默了')

  console.log('\n' + (fail === 0 ? '✅' : '❌') + ' 行情来源凭据：' + String(pass) + ' 通过 / ' + String(fail) + ' 失败')
  if (fail > 0) {
    console.log('失败的断言：')
    for (const f of failed) console.log('  · ' + f.id + ' ' + f.what)
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('烟测自身异常：' + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
})
