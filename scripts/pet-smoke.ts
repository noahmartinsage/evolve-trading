/**
 * 桌宠 · 烟测（不需要 Electron）
 *
 * ── 为什么这里一个 Electron API 都不调 ────────────────────────────────
 * 桌宠最容易坏的地方**全在参数组合与判定逻辑上**，而不是"窗口有没有起来"：
 * 少写一个 `transparent` 就变黑方块、冷却窗误清凭证、口型在没词边界时定住。
 * 这些都不是抛异常，是"看起来不对"。
 *
 * 所以本文件断言的每一件事都满足两个条件：
 *   ① 它是纯函数，不需要起窗口；
 *   ② **它有一个明确的"什么条件下会变红"** —— 答不上来的检查不算检查。
 * 真正的"窗口能不能起来"由 `PET_SMOKE=1 npm run pet` 那条真跑 Electron 的冒烟负责，
 * 两者不能互相替代。
 *
 * 用法：npm run test:pet
 */

import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  alwaysOnTopArgs,
  clampToNearestWorkArea,
  createPetWindowPlan,
  DEFAULT_PET_SIZE,
  nextDragPosition,
  PET_MIN_VISIBLE_PX,
  resolveRecoveryPlan,
} from '../src/pet/petWindow.ts'
import type { PetRect } from '../src/pet/petWindow.ts'
import {
  DEFAULT_SPEECH_TAIL_COOLDOWN_MS,
  ECHO_MIN_CHARS,
  ECHO_OVERLAP_THRESHOLD,
  judgeBargeIn,
  normalizeForEchoCompare,
  speechTailCooldownDeadline,
  textOverlapRatio,
} from '../src/pet/echoGuard.ts'
import {
  computeAvatarFrame,
  createAvatarMotion,
  markWordBoundary,
  setSpeaking,
} from '../src/pet/avatarMotion.ts'
import {
  blinkClosure,
  clamp01,
  fallbackMouthAperture,
  MOUTH_CLOSED_APERTURE,
  mouthAperture,
  mouthPeakForWord,
} from '../src/pet/lipsync.ts'
import { coverCropRect, PET_PHOTO_SIZE, PET_PHOTO_SOFT_LIMIT } from '../src/pet/petPhoto.ts'
import { AVATAR_MEDIA_LIMIT, detectMediaKind } from '../src/pet/petMedia.ts'
import { DEFAULT_AVATAR_SIZE, PET_AVATAR_SIZES, parseAvatarSize } from '../src/pet/avatarSize.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * 读项目内文件。
 *
 * 用在「接线断言」上：有些性质不在任何纯函数的返回值里，而在
 * **几个文件是否同向**（例如透明窗要三处齐备、退出只能有一个入口）。
 * 这类断言同样满足"什么条件下变红"这个门槛，所以是合格的检查，
 * 而不是"扫一遍源码看有没有某个词"。
 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/**
 * 去掉注释，**只留代码**。
 *
 * ── 为什么这个函数必须存在 ────────────────────────────────────────────
 * 凡是"源码里不得出现 X"这类断言，都会撞上同一件事：**解释 X 为什么不能用，
 * 本身就得写出 X**。本文件里已经连撞两次：
 *   · P9 ⑤ 断言主进程不依赖 `-webkit-app-region`，被注释里那句
 *     "为什么不用 -webkit-app-region"绊红；
 *   · P10 ① 断言退出只有一个入口，被 quitApp 上方那段
 *     "不得出现 `app.exit(` 或 `app.quit()`"绊红。
 *
 * 两次都是断言的问题，不是代码的问题。修法不是把注释删掉（那条注释比断言值钱），
 * 而是**断言只扫代码**。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSDoc）
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释；[^:] 是为了不误伤 https://
}

let passed = 0
let failed = 0
const failures: string[] = []

function pass(name: string, detail: string): void {
  passed += 1
  console.log(`  ✅ ${name} · ${detail}`)
}

function fail(name: string, detail: string): void {
  failed += 1
  failures.push(`${name} :: ${detail}`)
  console.log(`  ❌ ${name} · ${detail}`)
}

function check(name: string, cond: boolean, detail: string): void {
  if (cond) pass(name, detail)
  else fail(name, detail)
}

function section(title: string): void {
  console.log('')
  console.log(`── ${title} ──`)
}

const PRELOAD = 'C:\\fake\\preload.mjs'

/**
 * 二元组包含度，**不做归一化**。
 *
 * 只用于 P6 的对照：证明"归一化"这一步真的在起作用，而不是一个可以被删掉的装饰。
 * 刻意不复用 `textOverlapRatio` —— 复用就等于拿实现去验证实现，两边同时错也照样绿。
 */
function rawBigramOverlap(a: string, b: string): number {
  const bigrams = (s: string) => {
    const out = new Set<string>()
    for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2))
    return out
  }
  const sa = bigrams(a.toLowerCase())
  const sb = bigrams(b.toLowerCase())
  if (sa.size === 0 || sb.size === 0) return 0
  let hit = 0
  for (const g of sa) if (sb.has(g)) hit += 1
  return hit / Math.min(sa.size, sb.size)
}

// ═══════════════════════════════════════════════════════════
section('P1 窗口标志位：每一条都是"少写就看起来不对"的')

{
  const plan = createPetWindowPlan({ preloadPath: PRELOAD })

  check('P1 透明无边框', plan.transparent === true && plan.frame === false, `transparent=${plan.transparent} frame=${plan.frame}（false 会变成一块黑底方块）`)
  check('P1 不描边', plan.hasShadow === false, 'hasShadow=false（默认投影会在透明窗上描一圈方形灰边）')
  check('P1 全透明底色', plan.backgroundColor === '#00000000', `backgroundColor=${plan.backgroundColor}（退化时用全透明而不是黑）`)
  check('P1 置顶', plan.alwaysOnTop === true, 'alwaysOnTop=true（否则全屏应用一开就被压住，用户以为崩了）')
  check('P1 尺寸固定', plan.resizable === false && plan.maximizable === false && plan.minimizable === false && plan.fullscreenable === false, 'resizable/maximizable/minimizable/fullscreenable 全 false（拖一下头像就变扁）')
  check('P1 先不显示', plan.show === false, 'show=false（避免先闪现在屏幕外再跳回来）')

  const w = plan.webPreferences
  check(
    'P1 后台不降频',
    w.backgroundThrottling === false,
    'backgroundThrottling=false（开着会被降到 ~1fps：头像不呼吸、口型卡住）',
  )
  check(
    'P1 预加载与隔离',
    w.preload === PRELOAD && w.contextIsolation === true && w.nodeIntegration === false && w.sandbox === false,
    `preload 透传 + contextIsolation + 无 nodeIntegration + sandbox=false（某些组合下静默拿不到麦克风）`,
  )

  check('P1 尺寸默认值', plan.width === DEFAULT_PET_SIZE.width && plan.height === DEFAULT_PET_SIZE.height, `${plan.width}×${plan.height}`)

  const withPos = createPetWindowPlan({ preloadPath: PRELOAD, position: { x: 12.6, y: -3.2 } })
  check('P1 坐标取整', withPos.x === 13 && withPos.y === -3, `x=${withPos.x} y=${withPos.y}（非整数坐标会让 Electron 四舍五入后再报回来，位置记忆每次都"漂一点"）`)

  const noPos = createPetWindowPlan({ preloadPath: PRELOAD, position: null })
  check('P1 无记忆时不指定坐标', noPos.x === undefined && noPos.y === undefined, '交给系统决定初始位置，而不是把 0,0 当默认')
}

// ═══════════════════════════════════════════════════════════
section('P2 置顶层级：Linux 上不许传 level')

{
  const win = alwaysOnTopArgs('win32')
  const mac = alwaysOnTopArgs('darwin')
  const linux = alwaysOnTopArgs('linux')

  check('P2 Windows/macOS 用最高层', win.level === 'screen-saver' && mac.level === 'screen-saver', `win32=${win.level} darwin=${mac.level}（默认 normal 会被全屏应用抢占）`)
  check(
    'P2 Linux 不传 level',
    linux.flag === true && linux.level === undefined,
    'X11/Wayland 部分合成器上传层级会静默无效 —— 传了会让人以为置顶生效了，实际没有',
  )
}

// ═══════════════════════════════════════════════════════════
section('P3 可找回性不变量：无边框 + 无标题 + skipTaskbar 三者叠加的代价')

{
  const ok = resolveRecoveryPlan({ trayCreated: true })
  const bad = resolveRecoveryPlan({ trayCreated: false })

  check('P3 有托盘 → 干净桌面', ok.skipTaskbar === true && ok.hideOnClose === true, ok.reason)
  check(
    'P3 无托盘 → 退回任务栏当入口',
    bad.skipTaskbar === false && bad.hideOnClose === false,
    bad.reason,
  )
  // 死局组合必须在所有输入下都不出现：任务栏没条目 **且** 窗口关不掉
  const deadlock = bad.skipTaskbar === false && bad.hideOnClose === true
  check('P3 不存在"入口有但关不掉"', !deadlock, 'skipTaskbar=false + hideOnClose=true 会把窗口变成关不掉的僵尸，比原本更难收拾')
}

// ═══════════════════════════════════════════════════════════
section('P4 越界钳制：拔掉外接屏之后它必须还在屏幕上')

{
  const primary: PetRect = { x: 0, y: 0, width: 1920, height: 1080 }
  const secondary: PetRect = { x: 1920, y: 0, width: 1920, height: 1080 }
  const size = DEFAULT_PET_SIZE

  // 副屏还在 → 留在副屏
  const onSecondary = clampToNearestWorkArea({ x: 2200, y: 300, ...size }, [primary, secondary])
  check(
    'P4 多屏时留在原屏',
    onSecondary.x >= secondary.x && onSecondary.x + size.width <= secondary.x + secondary.width,
    `x=${onSecondary.x} 落在副屏内（用户把桌宠放副屏是常态，不该被拽回主屏）`,
  )

  // 副屏拔掉 → 回到主屏，且至少有 PET_MIN_VISIBLE_PX 可见
  const orphan = clampToNearestWorkArea({ x: 2400, y: 300, ...size }, [primary])
  const visibleX = Math.min(orphan.x + size.width, primary.x + primary.width) - Math.max(orphan.x, primary.x)
  check(
    'P4 屏幕消失后回到主屏',
    orphan.x < primary.width && visibleX >= Math.min(PET_MIN_VISIBLE_PX, size.width),
    `x=${orphan.x} 可见宽=${visibleX}px（≥${PET_MIN_VISIBLE_PX} 才可能被鼠标拖回来）`,
  )

  // 纵轴同理：负坐标（屏幕在上方被撤掉）也要拉回来
  const above = clampToNearestWorkArea({ x: 100, y: -800, ...size }, [primary])
  check(
    'P4 上方越界也拉回',
    above.y >= primary.y && above.y + size.height <= primary.y + primary.height + 1,
    `y=${above.y}（存下的坐标可能来自已撤掉的"上方"显示器）`,
  )

  // 工作区比窗口还小：不许产生 min > max 的 NaN
  const tiny = clampToNearestWorkArea({ x: 999, y: 999, ...size }, [{ x: 0, y: 0, width: 40, height: 40 }])
  check(
    'P4 极小工作区不产生 NaN',
    Number.isFinite(tiny.x) && Number.isFinite(tiny.y),
    `x=${tiny.x} y=${tiny.y}（min>max 时 Math.min/max 会因 NaN 传播把坐标变成 NaN，setBounds 直接抛）`,
  )

  const none = clampToNearestWorkArea({ x: 7, y: 8, ...size }, [])
  check('P4 无显示器信息时原样返回', none.x === 7 && none.y === 8, '拿不到显示器列表时不做任何猜测')
}

// ═══════════════════════════════════════════════════════════
section('P5 原生拖动：位移计算错了会"一跳就跑到屏幕外"')

{
  const origin = { x: 100, y: 200 }
  const moved = nextDragPosition(origin, { dx: 30, dy: -50 })
  check('P5 起点 + 位移', moved.x === 130 && moved.y === 150, `(${moved.x}, ${moved.y})`)

  const still = nextDragPosition(origin, { dx: 0, dy: 0 })
  check(
    'P5 零位移不移动',
    still.x === origin.x && still.y === origin.y,
    '按下但没拖 → 不得移动（否则"点一下它就跳走"，是对齐方式写成了绝对坐标的特征）',
  )

  const bad = nextDragPosition(origin, { dx: Number.NaN, dy: Number.POSITIVE_INFINITY })
  check(
    'P5 非法位移按 0 处理',
    bad.x === origin.x && bad.y === origin.y,
    'NaN/Infinity 必须被挡在 setBounds 之前，否则 Electron 会抛且窗口卡在半路',
  )

  const rounded = nextDragPosition({ x: 0.4, y: 0.6 }, { dx: 1.5, dy: 1.5 })
  check('P5 结果取整', Number.isInteger(rounded.x) && Number.isInteger(rounded.y), `(${rounded.x}, ${rounded.y})`)
}

// ═══════════════════════════════════════════════════════════
section('P6 回声闸门：这一层挡住的是"助手把自己念断"')

{
  const SPOKEN = '订单已拒绝，原因：名义金额 800 超过单笔上限 500。'
  const base = { listening: true, cooldownUntil: 0, now: 1_000_000 }

  // ③ 麦克风没开：迟到的中间结果不得触发打断
  const micOff = judgeBargeIn({ ...base, interim: '买两百块钱的比特币', speakingText: SPOKEN, listening: false })
  check('P6 未收音不打断', !micOff.bargeIn && micOff.reason === 'mic-off', micOff.detail)

  const empty = judgeBargeIn({ ...base, interim: '   ', speakingText: SPOKEN })
  check('P6 空结果不算输入', !empty.bargeIn && empty.reason === 'no-speech', empty.detail)

  // ② 短命令必须放行 —— 它是止损命令，被吞掉比误打断严重得多
  for (const cmd of ['停', '停下', '别说了']) {
    const v = judgeBargeIn({ ...base, interim: cmd, speakingText: SPOKEN })
    check(`P6 短命令「${cmd}」打断`, v.bargeIn && v.reason === 'interrupt', v.detail)
  }

  // ②′ 「确认」也是短命令：它在被念到的句子里必然出现（"说确认我就执行"），
  //     若走包含关系判定会被整句吞掉
  const confirmCmd = judgeBargeIn({ ...base, interim: '确认', speakingText: '买 200 美元的比特币，请复述金额确认' })
  check('P6「确认」不被念的话吞掉', confirmCmd.bargeIn, confirmCmd.detail)

  // ① 自听回声：麦克风收到的就是它自己那句
  const echo = judgeBargeIn({ ...base, interim: SPOKEN, speakingText: SPOKEN })
  check(
    'P6 自听回声不打断',
    !echo.bargeIn && echo.reason === 'self-echo' && echo.overlap >= ECHO_OVERLAP_THRESHOLD,
    `重合 ${(echo.overlap * 100).toFixed(0)}% —— ${echo.detail}`,
  )

  // ①′ 归一化是这条闸门的前提：ASR 会往中间结果里插标点与空格，
  //     而"插入的标点"会造出原句里不存在的二元组。这里用一个**不复用实现**的
  //     裸比对做对照 —— 若有人把 `normalizeForEchoCompare` 去掉，
  //     两者会变成同一个数，这条断言当场变红。
  const asrText = '订单已拒绝原因名义金额800超过单笔上限500'
  const normOverlap = textOverlapRatio(SPOKEN, asrText)
  const rawOverlap = rawBigramOverlap(SPOKEN, asrText)
  check(
    'P6 归一化才判得出回声',
    normOverlap >= ECHO_OVERLAP_THRESHOLD && rawOverlap < normOverlap,
    `归一化后 ${(normOverlap * 100).toFixed(0)}%（阈值 ${ECHO_OVERLAP_THRESHOLD * 100}%），不归一化只有 ${(rawOverlap * 100).toFixed(0)}% —— 差了 ${((normOverlap - rawOverlap) * 100).toFixed(0)} 个点`,
  )

  // 真插话：长句且与朗读内容无关
  const real = judgeBargeIn({ ...base, interim: '帮我把以太坊的仓位平掉', speakingText: SPOKEN })
  check('P6 无关长句判为插话', real.bargeIn && real.reason === 'interrupt', `重合仅 ${(real.overlap * 100).toFixed(0)}%`)

  // ⑤ 合成静止：不得打断。这条直接对着服务端 interrupt() 会清 pending 的行为
  const idle = judgeBargeIn({ ...base, interim: '我现在的持仓是什么', speakingText: null })
  check(
    'P6 静止时不打断',
    !idle.bargeIn && idle.reason === 'idle',
    `${idle.detail}`,
  )

  // ④ 尾响窗：合成刚结束，余音还在麦克风里
  const cooldownUntil = speechTailCooldownDeadline(base.now)
  check(
    'P6 尾响窗长度',
    cooldownUntil === base.now + DEFAULT_SPEECH_TAIL_COOLDOWN_MS,
    `${DEFAULT_SPEECH_TAIL_COOLDOWN_MS}ms（与上游 airi 的 suppressedUntil 同量级：它压的是音箱尾响而非人声）`,
  )
  const tail = judgeBargeIn({ ...base, interim: '帮我把以太坊的仓位平掉', speakingText: null, cooldownUntil })
  check('P6 尾响窗内不打断', !tail.bargeIn && tail.reason === 'speaker-tail', tail.detail)

  // 尾响窗**不得**在正在念的时候生效 —— 否则"念到第二句时喊停"会被吞掉
  const during = judgeBargeIn({
    ...base,
    interim: '帮我把以太坊的仓位平掉',
    speakingText: SPOKEN,
    cooldownUntil,
  })
  check(
    'P6 出声时冷却窗不生效',
    during.bargeIn,
    '冷却窗是"上一句说完"开的；正在出声说明它已经过期，否则真插话会被误吞',
  )

  // 阈值与门槛必须与文档一致，防止有人把常数改成"永远放行"
  check(
    'P6 门槛常量合理',
    ECHO_MIN_CHARS === 4 && ECHO_OVERLAP_THRESHOLD > 0.3 && ECHO_OVERLAP_THRESHOLD < 1,
    `ECHO_MIN_CHARS=${ECHO_MIN_CHARS} 阈值=${ECHO_OVERLAP_THRESHOLD}（阈值取 1 等于闸门失效，取 0 等于永不打断）`,
  )
  check(
    'P6 归一化只留实义字符',
    normalizeForEchoCompare(SPOKEN) === asrText,
    '去掉空格与标点后的形式',
  )
}

// ═══════════════════════════════════════════════════════════
section('P7 口型：speechSynthesis 拿不到波形，只能靠词边界 + 确定性兜底')

{
  check(
    'P7 播报中从零开始 → 兜底包络',
    (() => {
      const m = createAvatarMotion()
      setSpeaking(m, true, 5000)
      return computeAvatarFrame(m, 5050).usingFallback
    })(),
    'lastBoundaryAt=0 表示"这个引擎一次词边界都没触发" —— 这正是"嘴在动但对不上声音"的唯一可见证据',
  )

  check(
    'P7 刚收到词边界 → 真口型',
    (() => {
      const m = createAvatarMotion()
      setSpeaking(m, true, 5000)
      markWordBoundary(m, 4, 5050)
      const f = computeAvatarFrame(m, 5050)
      return !f.usingFallback && f.boundaryCount === 1 && f.aperture > 0.6
    })(),
    '词边界那一刻嘴张到接近最大（这是"像在说话"与"在抽搐"的分界）',
  )

  check(
    'P7 词边界过期 → 回退兜底',
    (() => {
      const m = createAvatarMotion()
      setSpeaking(m, true, 5000)
      markWordBoundary(m, 4, 5050)
      return computeAvatarFrame(m, 5050 + 900).usingFallback
    })(),
    '超过 BOUNDARY_STALE_MS 未再收到边界 ⇒ 认定引擎不触发，走兜底包络',
  )

  check(
    'P7 不说话时嘴留一条缝',
    (() => {
      const m = createAvatarMotion()
      const f = computeAvatarFrame(m, 1000)
      return !f.speaking && f.aperture === MOUTH_CLOSED_APERTURE && f.bob === 0
    })(),
    `aperture=${MOUTH_CLOSED_APERTURE}（全闭的头像看起来像张照片）`,
  )

  // 关键：没有词边界时嘴**必须仍在动**，否则就是"张嘴说话但嘴一动不动"
  check(
    'P7 兜底包络真的在动',
    (() => {
      const m = createAvatarMotion()
      setSpeaking(m, true, 0)
      const samples = [0, 120, 240, 360, 480].map((t) => computeAvatarFrame(m, t).aperture)
      const distinct = new Set(samples.map((v) => v.toFixed(3)))
      const spread = Math.max(...samples) - Math.min(...samples)
      return distinct.size >= 4 && spread > 0.15
    })(),
    '跨 5 个时间点采样：至少 4 个不同值且极差 >0.15（恒定值就是"静止的嘴"）',
  )

  check(
    'P7 兜底包络可重放',
    fallbackMouthAperture(1234, 0.7) === fallbackMouthAperture(1234, 0.7),
    '同一 (elapsed, seed) 必得同一值 —— 用 Math.random() 会帧间不连续，看起来像抖动',
  )

  check(
    'P7 值域封闭',
    [0, 1, 100, 1e9].every((t) => {
      const v = fallbackMouthAperture(t, 0.3)
      return v >= 0 && v <= 1
    }) && clamp01(Number.NaN) === 0,
    '开口度落在 [0,1]，NaN 归零',
  )

  check(
    'P7 长词嘴张得更大',
    mouthPeakForWord(1) < mouthPeakForWord(6) && mouthPeakForWord(1) >= 0.45 && mouthPeakForWord(999) <= 1,
    `1 字=${mouthPeakForWord(1).toFixed(2)} / 6 字=${mouthPeakForWord(6).toFixed(2)}（读唇的可辨特征）`,
  )

  check(
    'P7 词边界后线性衰减到闭合',
    (() => {
      const peak = mouthAperture({ sinceBoundaryMs: 0, charCount: 5, speaking: true })
      const mid = mouthAperture({ sinceBoundaryMs: 80, charCount: 5, speaking: true })
      const end = mouthAperture({ sinceBoundaryMs: 160, charCount: 5, speaking: true })
      return peak > mid && mid > end && Math.abs(end - MOUTH_CLOSED_APERTURE) < 1e-9
    })(),
    '开 → 衰减 → 闭合缝，单调',
  )

  check(
    'P7 时钟回拨不锁死嘴',
    mouthAperture({ sinceBoundaryMs: -500, charCount: 3, speaking: true }) > 0.5,
    '负 elapsed 按"刚触发"处理（事件乱序时不该把嘴锁在闭合位）',
  )

  check(
    'P7 不眨眼会进恐怖谷',
    (() => {
      // 扫描一个完整眨眼周期：必须既出现"睁开"(≈0) 也出现"闭上"(≈1)
      const samples = Array.from({ length: 400 }, (_, i) => blinkClosure(i * 12))
      const open = samples.filter((v) => v < 0.05).length
      const shut = samples.filter((v) => v > 0.9).length
      return open > 0 && shut > 0
    })(),
    '睁/闭两种状态都必须出现 —— 退化成恒 0（永不眨眼）是断言级错误，人眼只会觉得"有点瘆人"',
  )

  check(
    'P7 眨眼值域与周期边界',
    blinkClosure(0) === 0 && blinkClosure(-1234) >= 0 && blinkClosure(1e9) <= 1 && Number.isFinite(blinkClosure(Number.NaN)),
    '负时间与巨大时间都不得越界（performance.now() 回绕或首帧为 0 都会碰到）',
  )
}

// ═══════════════════════════════════════════════════════════
section('P8 照片：先裁剪再压缩，否则 localStorage 配额会把"换照片"变成本地玄学')

{
  const landscape = coverCropRect(1920, 1080)
  check(
    'P8 横图按短边裁',
    landscape.sw === 1080 && landscape.sh === 1080 && landscape.sx === 420 && landscape.sy === 0,
    `sx=${landscape.sx} side=${landscape.sw}（按长边算会越界）`,
  )

  const portrait = coverCropRect(1080, 1920)
  check(
    'P8 竖图按短边裁',
    portrait.sw === 1080 && portrait.sh === 1080 && portrait.sx === 0 && portrait.sy === 420,
    `sy=${portrait.sy}`,
  )

  const square = coverCropRect(800, 800)
  check('P8 方图不裁', square.sx === 0 && square.sy === 0 && square.sw === 800, '原样')

  const degenerates = [
    coverCropRect(0, 0),
    coverCropRect(Number.NaN, 100),
    coverCropRect(-50, 20),
  ]
  check(
    'P8 退化输入不抛且不产生 NaN',
    degenerates.every((r) => [r.sx, r.sy, r.sw, r.sh].every((v) => Number.isFinite(v) && v >= 0)),
    '损坏/极端图片不该让整页崩掉',
  )

  // 一般化不变量：裁剪框永远落在原图内
  const cases: [number, number][] = [[1920, 1080], [1080, 1920], [1, 1000], [1000, 1], [37, 41]]
  check(
    'P8 裁剪框不越界（全量抽查）',
    cases.every(([w, h]) => {
      const r = coverCropRect(w, h)
      return r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= w && r.sy + r.sh <= h
    }),
    cases.map(([w, h]) => `${w}×${h}`).join(' / '),
  )

  check(
    'P8 软上限低于 localStorage 常见配额',
    PET_PHOTO_SOFT_LIMIT < 5_000_000 && PET_PHOTO_SIZE >= 256,
    `上限 ${(PET_PHOTO_SOFT_LIMIT / 1024 / 1024).toFixed(1)}MB / 导出 ${PET_PHOTO_SIZE}px`,
  )
}

// ═══════════════════════════════════════════════════════════
section('P9 透明窗三处必须同向（少任何一处都变黑方块）')

{
  const plan = createPetWindowPlan({ preloadPath: PRELOAD })
  const css = read('src/styles/pet.css')
  const app = read('src/App.tsx')
  const main = read('src/main.tsx')

  check('P9 ① 窗口声明透明', plan.transparent === true && plan.backgroundColor === '#00000000', 'petWindow.ts')

  check(
    'P9 ② 样式抹掉页面底色',
    /html\.pet-standalone[\s\S]*?background:\s*transparent/.test(css),
    'pet.css 必须覆盖 html/body/#root 的底色 —— 不抹掉的话透明窗渲染成一块黑方块，而这件事在浏览器里预览看不出来',
  )

  check(
    'P9 ③ 挂载前打标记',
    /classList\.add\('pet-standalone'\)/.test(main) && /get\('pet'\)\s*===\s*'1'/.test(main),
    'main.tsx 必须在 React 挂载之前给 <html> 打标记（等挂载再改会先闪一下黑底）',
  )

  check(
    'P9 ④ 独立态绕开侧边栏',
    /standalonePet/.test(app) && /<VoiceHubPage standalone \/>/.test(app),
    'App.tsx 的 ?pet=1 分支不得渲染 Sidebar/TopBar，且它渲染的是**合并后的同一个页面**的悬浮布局',
  )

  // 断言要落在**代码**上，不能落在"文件里有没有这几个字"上 ——
  // 主进程的注释里就写着"为什么不用 -webkit-app-region"，
  // 按字面搜会被自己的解释绊倒（这条第一次写就是这么红的）。
  //
  // 同时钉住后缀：主进程**必须是 `.ts`**。它带类型注解，而 Node 的类型擦除
  // 只作用于 `.ts`/`.mts` —— 叫 `.mjs` 会在启动第一行就 SyntaxError。
  // （踩过一次：改名成 .mjs 后窗根本起不来，报错却是 `Unexpected token ':'`。）
  const desktopMain = read('desktop/main.ts')
  check(
    'P9 ⑤ 拖动走原生通道而不是 CSS',
    /ipcMain\.on\('pet:drag-begin'/.test(desktopMain) &&
      /ipcMain\.on\('pet:drag-by'/.test(desktopMain) &&
      !/-webkit-app-region\s*:/.test(css),
    '无边框窗上用 CSS drag 有已知 bug（丢帧、松手后继续跟鼠标）；本实现走 pet:drag-* 原生通道，且样式里不得再出现 app-region 写法',
  )

  check(
    'P9 ⑥ 预加载暴露的通道与 TS 声明同名',
    (() => {
      const pre = read('desktop/preload.mjs')
      const bridge = read('src/pet/petBridge.ts')
      const channels = ['pet:hide', 'pet:quit', 'pet:reset-position', 'pet:set-click-through', 'pet:get-state', 'pet:drag-begin', 'pet:drag-by']
      return channels.every((c) => pre.includes(`'${c}'`)) && /dragBegin/.test(bridge) && /dragBy/.test(bridge)
    })(),
    '两条 IPC 通道名两边必须逐字一致 —— 只在一侧改名的表现是"点了没反应"，且没有任何报错',
  )
}

// ═══════════════════════════════════════════════════════════
section('P10 主进程结构不变量：这两条都是"跑起来看着不对"以外的形态')

{
  const mainProc = stripComments(read('desktop/main.ts'))

  // ① 退出只能有一个入口。
  //    这条是真的踩出来的：托盘"退出"置了 allowClose 所以没事，
  //    而冒烟里的 app.exit() 没置 → 窗口的 close 拦截把它挡下 →
  //    截图都落盘了、进程却挂到 60s 超时。两条退出路径的一致性没人管就会漂移。
  const quitBlock = mainProc.match(/function quitApp\([\s\S]*?\n\}/)
  const outsideQuitApp = quitBlock ? mainProc.replace(quitBlock[0], '') : mainProc
  const strayExits = (outsideQuitApp.match(/\bapp\.(exit|quit)\(/g) ?? []).filter(Boolean)
  check(
    'P10 ① 退出只走 quitApp()',
    Boolean(quitBlock) && strayExits.length === 0,
    `quitApp 之外还有 ${strayExits.length} 处直接调用（${strayExits.join(' / ') || '无'}）—— 每一处都会漏掉 allowClose，症状是"进程关不掉"`,
  )

  // ② `.mjs` 不得含 TS 注解。
  //    这条同一个错误已经犯过三次（main / launch / 探测脚本各一次），
  //    所以做成语法门而不是靠记性：用 node --check 真解析一遍。
  const mjsFiles = readdirSync(join(ROOT, 'desktop')).filter((f) => f.endsWith('.mjs'))
  const badParse: string[] = []
  const unverified: string[] = []
  // ★★ 用**异步** `execFile`，不用 `execFileSync`（2026-09-22 修）。
  //   本机实测（`.trash/<ts>/_diag_spawn.cjs`）：agent 环境注入的 node shim 下，
  //   `spawnSync`/`execSync`/`execFileSync` **恒 EBUSY**，而异步的 `spawn`/`exec` 正常。
  //   用同步版本 ⇒ "环境不许起进程"会被报成"preload.mjs 里写了 TS 注解"，
  //   两者指向**相反**的动作（判据 C5），而误报会训练人忽略这道门（判据 A1）。
  const execFileAsync = promisify(execFile)
  for (const f of mjsFiles) {
    try {
      await execFileAsync(process.execPath, ['--check', join(ROOT, 'desktop', f)])
    } catch (e) {
      // 事因必须分开（判据 C5）：spawn 失败 ⇒ `code` 是**字符串**（EBUSY/ENOENT…）；
      // `node --check` 真失败 ⇒ `code` 是**数字**（退出码），stderr 里有 SyntaxError。
      const code = (e as NodeJS.ErrnoException | undefined)?.code
      if (typeof code === 'string') {
        unverified.push(`${f}（起不来进程：${code}）`)
        continue
      }
      const msg = e instanceof Error ? e.message.split('\n').slice(0, 2).join(' ') : String(e)
      badParse.push(`${f}（${msg.slice(0, 90)}）`)
    }
  }
  check(
    'P10 ② .mjs 必须是纯 JS',
    mjsFiles.length > 0 && badParse.length === 0,
    badParse.length > 0
      ? `类型擦除只作用于 .ts —— ${badParse.join('；')}`
      : `${mjsFiles.join(' / ')} 全部通过 node --check（预加载脚本不过类型擦除，写了注解就会在第一行 SyntaxError）`,
  )
  // ★ 配对断言（判据 A3：假绿）：上面那条的通路是"解析过 ⇒ 绿"。
  //   若进程根本起不来，`badParse` 会是空的 —— 于是它**照样绿**，
  //   而实际上一个字节都没验。所以"没跑成"必须自己说出来，不许冒充通过。
  check(
    'P10 ②b 每一条 .mjs 都真的解析过（没有"起不来"冒充"通过"）',
    unverified.length === 0,
    unverified.length > 0
      ? `以下文件**没有真的验证**（进程起不来，≠ 语法通过）：${unverified.join('；')}`
      : `${mjsFiles.length} 条全部真的解析过`,
  )

  // ③ 主进程与启动器必须是 .ts（带注解），预加载必须是 .mjs（纯 JS）。
  //    命名和内容要求方向相反，所以两边都要钉。
  const desktopFiles = readdirSync(join(ROOT, 'desktop'))
  check(
    'P10 ③ 脚本后缀与内容要求同向',
    desktopFiles.includes('main.ts') && desktopFiles.includes('launch.ts') && desktopFiles.includes('preload.mjs') && !desktopFiles.includes('main.mjs'),
    '主进程/启动器 = .ts（可带注解）；preload = .mjs（纯 JS）。取反任一侧都会起不来',
  )

  // ④ 启动器判定冒烟结果，**不得依赖子进程退出事件**。
  //    这条钉的是一个本机实测出来的环境事实（见 `desktop/launch.ts` 顶部）：
  //    Electron 子进程终止后，父进程的 exit / close 事件不触发，
  //    `child.exitCode` 恒为 null —— 最小 Electron 也能复现，inherit/pipe 都一样。
  //    所以判定必须落在「协议行」和「存活轮询」两条不会失灵的通道上。
  //    少了任何一条，症状是冒烟要么误判失败、要么一直挂到超时
  //    （这个症状真的出现过，而且当时被误读成"子进程退不掉"，查反了方向）。
  const launcher = stripComments(read('desktop/launch.ts'))
  const protocolOnBothEnds =
    mainProc.includes('PET_SMOKE_OK') &&
    mainProc.includes('PET_SMOKE_FAIL') &&
    launcher.includes('PET_SMOKE_OK') &&
    launcher.includes('PET_SMOKE_FAIL')
  const hasLivenessPoll = /process\.kill\(pid,\s*0\)/.test(launcher)
  check(
    'P10 ④ 冒烟判定靠协议行 + 存活轮询',
    protocolOnBothEnds && hasLivenessPoll,
    !protocolOnBothEnds
      ? '两端（main.ts / launch.ts）的协议行前缀必须逐字一致 —— 改名只改一侧的表现是"冒烟永远超时"'
      : 'launch.ts 缺少存活轮询 process.kill(pid, 0)：本机 child.on(\'exit\') 不触发，只靠它必然挂到超时',
  )

  // ⑤ 冒烟截图默认不得落在项目目录里。
  //    它是内部验证产物（唯一用途是证明窗真的画出来了），不是交付物。
  //    写进仓库只会让每跑一次冒烟就多一个"要不要提交"的文件。
  check(
    'P10 ⑤ 冒烟截图落系统临时目录',
    /tmpdir\(\)/.test(mainProc) && /tmpdir\(\)/.test(launcher) && !/_pet-shot\.png/.test(mainProc) && !/_pet-shot\.png/.test(launcher),
    'main.ts 与 launch.ts 的截图兜底路径都要用 tmpdir()，且不得再引用项目内的 _pet-shot.png —— 截图是验证产物，不进仓库',
  )
}

// ═══════════════════════════════════════════════════════════
section('P11 P0 报警的可读性：这条必须用算的，眼睛看不出来')

{
  const css = read('src/styles/pet.css')

  // ── WCAG 相对亮度 / 对比度（手写，不引依赖）─────────────────────
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = (rgb: number[]): number =>
    0.2126 * lin(rgb[0] / 255) + 0.7152 * lin(rgb[1] / 255) + 0.0722 * lin(rgb[2] / 255)
  const ratio = (a: number[], b: number[]): number => {
    const la = lum(a)
    const lb = lum(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }
  /** rgba 与某底色做 alpha 混合 —— 半透明底色必须落到实底上才能算对比度。 */
  const over = (rgba: number[], base: number[]): number[] => {
    const a = rgba.length > 3 ? rgba[3] : 1
    return [0, 1, 2].map((i) => Math.round(rgba[i] * a + base[i] * (1 - a)))
  }
  const blockOf = (sel: string): string => {
    const at = css.indexOf(`${sel} {`)
    if (at < 0) return ''
    const end = css.indexOf('}', at)
    return end < 0 ? '' : css.slice(at, end)
  }
  const numsIn = (text: string, prop: string): number[] => {
    const m = text.match(new RegExp(`${prop}\\s*:\\s*rgba?\\(([^)]+)\\)`))
    return m ? m[1].split(',').map((s) => parseFloat(s)) : []
  }
  const hexIn = (text: string, prop: string): number[] => {
    const m = text.match(new RegExp(`${prop}\\s*:\\s*#([0-9a-fA-F]{6})`))
    return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : []
  }

  const bgRgba = numsIn(blockOf('.pet-cap-p0'), 'background')
  const metaHex = hexIn(blockOf('.pet-cap-p0 .pet-cap-meta'), 'color')
  const hex = metaHex.map((v) => v.toString(16).padStart(2, '0')).join('')

  // ① 标签行必须**单独**给色。
  //    原先 `.pet-cap-p0` 只覆盖了边框和底色，标签行于是退回通用的 `--text-weak`。
  //    这不是"不够好看"：那行字的内容正是"紧急报警"四个字。
  check(
    'P11 ① P0 条目给标签行单独指定了文字色',
    metaHex.length === 3,
    metaHex.length === 3
      ? '`.pet-cap-p0 .pet-cap-meta` 已单独覆盖'
      : '缺失 —— `.pet-cap-p0` 只覆盖了边框与底色，标签行会退回通用的 `--text-weak`（#5C6478）：整条里最该被看见的字用了最弱的颜色',
  )

  // ② 对比度必须按**最坏一侧**算。
  //    P0 条底色是 rgba(46,12,20,0.82) 半透明，而桌宠是透明窗、身后可能是纯白 ——
  //    纯白就是对比度最低的那一侧，也是用户真会遇到的一侧。
  const worstBg = bgRgba.length >= 3 ? over(bgRgba, [255, 255, 255]) : []
  const worstRatio = metaHex.length === 3 && worstBg.length === 3 ? ratio(metaHex, worstBg) : 0
  check(
    'P11 ② 最坏底色（叠纯白）下仍达 WCAG AA 小字 4.5:1',
    worstRatio >= 4.5,
    worstRatio >= 4.5
      ? `#${hex} on rgb(${worstBg.join(',')}) = ${worstRatio.toFixed(2)}:1`
      : `实测 ${worstRatio > 0 ? `${worstRatio.toFixed(2)}:1` : '无法计算'}（阈值 4.5:1）。` +
        '口径：P0 底色为半透明，透明窗身后的浅色会把它抬亮、把对比度压低 —— 所以按叠纯白算，这是最坏一侧',
  )
}

// ═══════════════════════════════════════════════════════════
section('P12 合并后的架构不变量：单一入口 · 单一通道 · 单一实现')

{
  /**
   * 这一组守的是**合并本身**。
   *
   * 「语音管家」与「悬浮桌宠」曾经是两个页面、两套会话实现。合并的收益不是
   * 少了一个页面，而是"同一件事只有一处实现"。而这条收益**没有任何运行时症状**：
   * 第二份实现照样能跑、照样好看，只是它的行为会在某次改动后与第一份分叉 ——
   * 分叉出来那套没有人测。
   *
   * 所以这里用源码级扫描把它变成会变红的东西：谁想再开一条通道 / 再养一份实现，
   * 必须同时改这些断言，也就必然会看见这段注释。
   */
  const walk = (rel: string, out: string[] = []): string[] => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) walk(child, out)
      else out.push(child)
    }
    return out
  }
  const srcFiles = walk('src').filter((f) => /\.(ts|tsx)$/.test(f))
  const codeOf = (rel: string): string => stripComments(read(rel))

  /**
   * 抹掉**函数定义**，只留调用点。
   *
   * 不这么做的话，`export function postUtterance(...)` 这一行本身会被当成一次调用 ——
   * 断言就会因为"定义处也在文件里"而永远红（第一次写就是这么红的）。
   * 而这里要问的问题很具体：**除了定义它的那个文件，还有谁在发这条请求。**
   */
  const callSites = (rel: string, names: string[]): string =>
    codeOf(rel).replace(
      new RegExp(`(export\\s+)?(async\\s+)?function\\s+(?:${names.join('|')})\\s*\\(`, 'g'),
      '',
    )

  // ① 业务通道只能有**一个**发起处。
  //    第二个入口不会有第二份测试 —— 它也不会经过第一份的审查。
  const channelCallers = srcFiles.filter((f) => callSites(f, ['postUtterance', 'postInterrupt']).match(/post(Utterance|Interrupt)\s*\(/))
  check(
    'P12 ① 业务通道（postUtterance / postInterrupt）只有一个发起处',
    channelCallers.length === 1 && channelCallers[0] === 'src/voice/useVoiceSession.ts',
    channelCallers.length === 1
      ? '全部收敛到 src/voice/useVoiceSession.ts'
      : `发起处有 ${channelCallers.length} 个：${channelCallers.join(' / ')} —— ` +
        '多出来的那一个就是一条绕过既有审查与既有测试的新通道',
  )

  // ② 回声判定同理：判别口径只能有一处调用。
  const echoCallers = srcFiles.filter((f) => callSites(f, ['judgeBargeIn']).match(/judgeBargeIn\s*\(/))
  check(
    'P12 ② 回声闸门只有一个调用点',
    echoCallers.length === 1 && echoCallers[0] === 'src/voice/useVoiceSession.ts',
    echoCallers.length === 1
      ? '单一调用点（纯函数 judgeBargeIn 由 test:pet 的 P6 组单独喂样例）'
      : `调用点有 ${echoCallers.length} 个：${echoCallers.join(' / ')} —— 两套阈值必然漂移`,
  )

  // ③ 旧页面不得复活成第二份实现，只能是纯重定向。
  //    本机安全策略拒绝删除仓库文件（safe-delete fail-closed），所以用重定向表达
  //    "已合并"。这条断言就是它的守门人：一旦有人在里面写回状态/请求/JSX，
  //    重定向立刻变回一份没人管的旧实现。
  for (const legacy of ['src/pages/VoicePage.tsx', 'src/pages/PetPage.tsx']) {
    const code = codeOf(legacy).trim()
    check(
      `P12 ③ ${legacy.split('/').pop()} 是纯重定向`,
      /^export\s*\{\s*default\s*\}\s*from\s*'\.\/VoiceHubPage\.tsx'\s*;?$/.test(code),
      /^export\s*\{\s*default\s*\}\s*from/.test(code)
        ? '仅一行 re-export，无状态、无请求、无 JSX'
        : `实际内容不是纯重定向：${code.slice(0, 60) || '(空)'} —— 合并后它必须只剩这一行`,
    )
  }

  // ④ 导航与路由只能有一个入口。
  //    两个入口会诱导出第二套会话实现 —— 那正是这次合并要消灭的东西。
  const sidebar = codeOf('src/components/Sidebar.tsx')
  const store = codeOf('src/store/Store.tsx')
  check(
    'P12 ④ 侧边栏与 PageId 里只剩一个语音入口',
    /id: 'voice'/.test(sidebar) && !/id: 'pet'/.test(sidebar) && !/'pet'/.test(store),
    /id: 'pet'/.test(sidebar) || /'pet'/.test(store)
      ? '仍存在 pet 页入口 —— 桌宠已合并进语音管家，导航里不得再有第二个入口'
      : "Sidebar 只有 id: 'voice'；PageId 里没有 'pet'",
  )

  // ⑤ 路由里不得再有 pet 页，但 `?pet=1` 的悬浮分支**必须保留**。
  //    这条是双向的：只要少一侧，悬浮窗就没了 —— 而它在浏览器里测不出来。
  const app = codeOf('src/App.tsx')
  const hubApp = /<VoiceHubPage standalone \/>/.test(app)
  check(
    'P12 ⑤ 路由无 pet 页，但 ?pet=1 的悬浮分支仍在',
    !/case 'pet'/.test(app) && hubApp && /get\('pet'\)\s*===\s*'1'/.test(app),
    !hubApp
      ? 'App.tsx 的 ?pet=1 分支不再渲染 VoiceHubPage standalone —— 悬浮窗会退化成带侧边栏的普通页面'
      : /case 'pet'/.test(app)
        ? '路由里还留着 pet 页 —— 那是第二个入口'
        : '?pet=1 → <VoiceHubPage standalone />，且路由表里已无 pet',
  )

  // ⑥ 合并页必须**同时**提供两种布局。
  //    只留一种的话，另一个形态会静默消失（构建通过、lint 通过、没人发现）。
  const hub = codeOf('src/pages/VoiceHubPage.tsx')
  const hasStandalone = /if\s*\(standalone\)/.test(hub) && /className="pet-stage"/.test(hub)
  const hasConsole = /className="content-area"/.test(hub)
  check(
    'P12 ⑥ 合并页同时提供悬浮与常规两种布局',
    hasStandalone && hasConsole,
    hasStandalone && hasConsole
      ? 'standalone → pet-stage（头像+字幕+控制条）；常规 → content-area（控制台）'
      : `缺少${hasStandalone ? '' : '悬浮布局'}${hasConsole ? '' : (hasStandalone ? '常规布局' : '与常规布局')}`,
  )

  // ⑦ 悬浮形态不得偷偷把侧边栏/顶栏拉进来。
  //    P9④ 看的是 App.tsx 的分支，这里看的是页面自己 —— 两处都得干净。
  check(
    'P12 ⑦ 合并页不引入侧边栏/顶栏',
    !/Sidebar/.test(hub) && !/TopBar/.test(hub),
    /Sidebar|TopBar/.test(hub)
      ? '合并页里出现了 Sidebar/TopBar —— 悬浮窗会带出一条侧边栏'
      : '页面自身不依赖侧边栏与顶栏（由 App 决定挂不挂）',
  )
}

// ═══════════════════════════════════════════════════════════
section('P13 头像：尺寸有界 · 三种素材分流 · 动图不叠器官层')
{
  // ① 尺寸必须有上界 —— 这条断言就是"头像太大"这个缺陷本身。
  //    没有上界时头像直径等于容器剩余高度（控制台里 400px 以上，
  //    360×540 的悬浮窗里接近 280px），把真正要读的对话与状态挤到一边。
  const sizes = Object.values(PET_AVATAR_SIZES).map((s) => s.px)
  const maxSize = Math.max(...sizes)
  check(
    'P13 ① 头像尺寸有上界（上界与照片导出分辨率配套）',
    maxSize <= PET_PHOTO_SIZE / 2 && sizes.every((n) => n > 0),
    maxSize <= PET_PHOTO_SIZE / 2
      ? `最大档 ${maxSize}px ≤ 导出 ${PET_PHOTO_SIZE}px 的一半（2× DPR 下仍清晰）；档位 ${sizes.join(' / ')}`
      : `最大档 ${maxSize}px 超过 ${PET_PHOTO_SIZE}px 的一半 —— 头像会被放大到发糊`,
  )

  // ② 有上界还不够：默认档如果就是最大档，"默认偏小"这个意图等于没落实
  check(
    'P13 ② 默认档偏小而不是最大档',
    PET_AVATAR_SIZES[DEFAULT_AVATAR_SIZE].px < maxSize,
    `默认 ${DEFAULT_AVATAR_SIZE} = ${PET_AVATAR_SIZES[DEFAULT_AVATAR_SIZE].px}px（最大 ${maxSize}px）`,
  )

  // ③ 偏好值被写坏时必须回落默认。坏值的表现是"头像消失"或"头像撑满"，
  //    都属于不报错、只让用户看见的缺陷。
  //    ⚠️ 坏值列表里**不能放 'xl'** —— 它现在是合法档位（第九轮加的特大档）。
  //    把合法值当坏值断言"会回落"，方向正好相反：那会让"用户想调大却调不了"
  //    这个缺陷**永远测不出来**（改动合法档位时这条照样绿）。
  //    所以非法档位用 'xxl'（差一个字母、拼写相近，才是真的坏值形态）。
  const badInputs: unknown[] = [null, undefined, '', 'xxl', '152', 'SM', '{}', 0, 3]
  const badParsed = badInputs.map((v) => parseAvatarSize(v as string | null))
  check(
    'P13 ③ 尺寸偏好写坏时回落默认档',
    badParsed.every((s) => s === DEFAULT_AVATAR_SIZE),
    `${badInputs.length} 个坏值（${badInputs.map((v) => JSON.stringify(v)).join(', ')}）全部回落到 ${DEFAULT_AVATAR_SIZE}`,
  )
  // ③b 正例。没有它的话，③ 会被一个"永远返回默认"的实现骗过去 ——
  //     那种实现下用户永远调不了尺寸，而 ③ 照样全绿。
  const legalSizes = Object.keys(PET_AVATAR_SIZES) as (keyof typeof PET_AVATAR_SIZES)[]
  const notRoundTripped = legalSizes.filter((k) => parseAvatarSize(k) !== k)
  check(
    'P13 ③b 每一个合法档位都原样读出（否则 ③ 是"永远返回默认"的假绿）',
    notRoundTripped.length === 0,
    notRoundTripped.length === 0
      ? `${legalSizes.length} 个档位（${legalSizes.join(' / ')}）全部原样读出`
      : `这些档位存进去读不出来：${notRoundTripped.join(', ')} —— 用户点了也白点`,
  )

  // ④ 素材分流必须看**文件头**，不能只看 MIME。
  //    MIME 由扩展名给出，把 clip.mp4 改名成 clip.png 就能骗过去；
  //    而两种误判方向后果相反：把视频当图片 → 送进 canvas 变成一张静图；
  //    把动图当静态图 → 被裁掉动画，用户传了动图却一动不动。
  const enc = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)))
  const mediaCases: { mime: string; head: Uint8Array; want: string | null; why: string }[] = [
    { mime: 'image/jpeg', head: enc('JFIF'), want: 'image', why: '普通照片：可裁可压' },
    { mime: 'image/png', head: enc('PNG'), want: 'image', why: '静态 PNG：可裁' },
    { mime: 'image/png', head: enc('PNG....acTL'), want: 'animated', why: 'APNG 不能裁（裁了就不动了）' },
    { mime: 'image/webp', head: enc('RIFF....WEBPVP8 '), want: 'image', why: '静态 WebP：可裁' },
    { mime: 'image/webp', head: enc('RIFF....WEBPVP8X....ANIM'), want: 'animated', why: '动图 WebP 不能裁' },
    { mime: 'image/gif', head: enc('GIF89a'), want: 'animated', why: 'GIF 一律按动图' },
    { mime: 'video/mp4', head: enc('ftyp'), want: 'video', why: '视频原样存' },
    { mime: 'video/webm', head: enc('webm'), want: 'video', why: '视频原样存' },
    { mime: 'application/pdf', head: enc('%PDF'), want: null, why: '不支持的类型必须被拒' },
    { mime: '', head: enc('xxxx'), want: null, why: '空 MIME 也不能放行' },
  ]
  const wrongKind = mediaCases.filter((c) => detectMediaKind(c.mime, c.head) !== c.want)
  check(
    'P13 ④ 素材类型按文件头分流（MIME 不可信）',
    wrongKind.length === 0,
    wrongKind.length === 0
      ? `${mediaCases.length} 组用例全对：改名的 mp4 不会被当成 png，动图不会被裁成静图`
      : wrongKind
          .map((c) => `${c.mime}（${c.why}）期望 ${c.want}，实得 ${detectMediaKind(c.mime, c.head)}`)
          .join('；'),
  )

  // ⑤ 体积上限必须分级且有限：视频上限低于动图的话，一段正常视频会被当成"过大"拒掉；
  //    没有上限的话，一个 4GB 的文件也能塞进常驻窗口。
  check(
    'P13 ⑤ 体积上限分级、有限、量级合理',
    AVATAR_MEDIA_LIMIT.video > AVATAR_MEDIA_LIMIT.animated &&
      AVATAR_MEDIA_LIMIT.animated > AVATAR_MEDIA_LIMIT.image &&
      AVATAR_MEDIA_LIMIT.video <= 64 * 1024 * 1024,
    `静态 ${Math.round(AVATAR_MEDIA_LIMIT.image / 1024)}KB < 动图 ` +
      `${Math.round(AVATAR_MEDIA_LIMIT.animated / 1024 / 1024)}MB < 视频 ` +
      `${Math.round(AVATAR_MEDIA_LIMIT.video / 1024 / 1024)}MB（≤64MB）`,
  )

  // ⑥ 器官层必须由 `source.kind === 'image'` **单点**决定。
  //    动图/视频里那张脸本来就在动，再叠一张计算出来的嘴 = 两张嘴同时动。
  //    ★ 只扫"有没有 pet-mouth"是不够的 —— 无条件渲染也含这个词。
  //      所以还要确认那两层在这个判定**内部**。
  const avatarSrc = stripComments(read('src/pet/PetAvatar.tsx'))
  const gateDecl = /const\s+overlay\s*=\s*source\?\.kind\s*===\s*'image'/.test(avatarSrc)
  const mouthInGate = /overlay\s*&&\s*\([\s\S]*?pet-mouth[\s\S]*?\n\s*\)\}/.test(avatarSrc)
  check(
    'P13 ⑥ 只有静态照片叠器官层（动图/视频不叠）',
    gateDecl && mouthInGate,
    gateDecl && mouthInGate
      ? 'overlay 由 kind 单点决定，嘴与眼睑两层都在该判定内部'
      : `判定存在=${gateDecl}、叠加层在该判定内=${mouthInGate} —— 动图会变成两张嘴同时动`,
  )

  // ⑦ 两份存储必须互斥。否则"传了动图 → 换成静态照片 → 刷新又变回动图"，
  //    用户只会认为这个功能是坏的。
  //    加载顺序也必须在断言里：先问 localStorage 的话，
  //    上次传的动图会被一张更早的静态照片盖掉，而"哪份是真的"没有定论。
  const shellSrc = stripComments(read('src/pet/usePetShell.ts'))
  const clearsIdb = /clearAvatarBlob\(\)/.test(shellSrc)
  const clearsLs = /clearStoredPhoto\(\)/.test(shellSrc)
  const idbFirst = shellSrc.indexOf('loadAvatarRecord()') < shellSrc.indexOf('loadStoredPhoto()')
  check(
    'P13 ⑦ 两份存储互斥，且加载顺序先问 IndexedDB',
    clearsIdb && clearsLs && idbFirst,
    clearsIdb && clearsLs && idbFirst
      ? '两条分支各自清掉对方的存储；加载先 IDB 再 localStorage'
      : `清 IDB=${clearsIdb}、清 localStorage=${clearsLs}、IDB 优先加载=${idbFirst}`,
  )

  // ⑧ 像素值在 CSS 与 TS 里各写了一份（CSS 读不到 TS 常量），这类双份必然漂移。
  //    这条断言把两个来源直接对读：改了一边不改另一边当场报红。
  const petCss = read('src/styles/pet.css')
  const sizeKeys = Object.keys(PET_AVATAR_SIZES) as (keyof typeof PET_AVATAR_SIZES)[]
  const sizeMismatch = sizeKeys.filter(
    (k) => !new RegExp(`\\[data-size='${k}'\\]\\s*\\{\\s*--avatar-size:\\s*${PET_AVATAR_SIZES[k].px}px`).test(petCss),
  )
  check(
    'P13 ⑧ pet.css 的档位像素值与 avatarSize.ts 逐个一致',
    sizeMismatch.length === 0,
    sizeMismatch.length === 0
      ? `${sizeKeys.length} 个档位在两个来源里取值相同`
      : `对不上的档位：${sizeMismatch.join(', ')}`,
  )

  // ⑨ 头像高度不得回到"等于容器剩余高度" —— 那正是"头像太大"的原形。
  const wrapRule = /\.pet-photo-wrap\s*\{[\s\S]*?\}/.exec(petCss)?.[0] ?? ''
  const usesSizeVar = /(?:^|[\s;])height:\s*var\(--avatar-size/.test(wrapRule)
  // ★ 这里必须排除 `max-height`。直接写 `/height:\s*100%/` 会把
  //   `max-height: 100%` 也判成"百分比高度"，于是这条断言**永远红** ——
  //   而"永远红"和"永远绿"一样没用，前者只会逼人把它注释掉。
  //   要求 `height` 前面是行首/空白/分号，`-` 就不会被匹配到。
  const hasPctHeight = /(?:^|[\s;])height:\s*100%/.test(wrapRule)
  check(
    'P13 ⑨ 头像高度取自档位变量，而不是容器的 100%',
    usesSizeVar && !hasPctHeight,
    usesSizeVar && !hasPctHeight
      ? 'height: var(--avatar-size) + max-height 兜底：直径由档位决定，不再由容器决定'
      : `档位变量=${usesSizeVar}、百分比高度=${hasPctHeight} —— 头像会重新撑满容器`,
  )

  // ⑩ 档位必须**严格递增**。没有这一条时，"两个档位填了同一个像素值"
  //    会静默通过：用户点两个不同的按钮，头像一动不动，他不会来报 bug，
  //    只会以为这个功能就是坏的。
  const ordered = sizeKeys.map((k) => PET_AVATAR_SIZES[k].px)
  const strictlyAscending = ordered.every((n, i) => i === 0 || n > ordered[i - 1])
  check(
    'P13 ⑩ 档位严格递增（两个档同像素值 = 点了没反应）',
    strictlyAscending && PET_AVATAR_SIZES.xl.px === maxSize,
    strictlyAscending
      ? `${sizeKeys.map((k) => k + '=' + PET_AVATAR_SIZES[k].px).join(' < ')}（最大档是 xl）`
      : `档位像素值不是严格递增：${sizeKeys.map((k) => k + '=' + PET_AVATAR_SIZES[k].px).join(' / ')}`,
  )

  // ⑪ 「特大」档把早期"头像铺满窗口"的观感请回来了，但它仍然要有界：
  //    上界 ① 只管"会不会糊"，这一条管**会不会把窗口吃掉**。
  //    取默认悬浮窗高度的 60% 作为界 —— 超过它，Mood 徽标 + 三行字幕 + 待确认条
  //    就放不下了，而那是这个窗口存在的主体（见 avatarSize.ts 文件头）。
  //    ⚠️ 这条断言单独立着没有意义：必须同时确认**特大档真的存在**，
  //    否则删掉 xl 之后它照样绿 —— 那就成了"不可能失败的检查"。
  const windowShare = maxSize / DEFAULT_PET_SIZE.height
  check(
    'P13 ⑪ 最大档不超过默认悬浮窗高度的 60%（不把字幕挤没）',
    windowShare <= 0.6 && maxSize > PET_AVATAR_SIZES.lg.px,
    `${maxSize}px / 窗口高 ${DEFAULT_PET_SIZE.height}px = ${(windowShare * 100).toFixed(1)}%（上界 60%），且确实比 lg 的 ${PET_AVATAR_SIZES.lg.px}px 大一档`,
  )
}

// ═══════════════════════════════════════════════════════════
console.log('')
console.log('────────────────────────────────────────')
console.log(`PET SMOKE ${failed === 0 ? 'PASSED' : 'FAILED'} · ${passed} passed / ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
}
console.log('────────────────────────────────────────')

process.exit(failed === 0 ? 0 : 1)
