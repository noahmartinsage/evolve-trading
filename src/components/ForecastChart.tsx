import React, { useMemo } from 'react'
import type { ForecastPathPointView } from '../orch/client'

export interface ForecastChartProps {
  /**
   * 逐步的价位分位带。**空数组是合法输入**，而且必须被区别对待 ——
   * 见下面的 `emptyNote`。
   */
  path: ForecastPathPointView[]
  /** 预测所站的那根 bar 的收盘价（"现在在哪"）。 */
  spot: number
  /** 名义 80% 区间对应的价位。`null` = 算不出来。 */
  interval: { lo: number; hi: number; coverage: number } | null
  direction: 'up' | 'down' | null
  target: number | null
  barMinutes: number
  horizonBars: number
  /**
   * ★ 画不出来时**必须**由调用方给一句具体的话。
   *
   * 为什么不让组件自己兜一句"暂无数据"：这张图有两个完全不同的"空" ——
   * ① 预测算成功了，但**样本不足以给分位带**（`path: []`，是研究的结论）；
   * ② 请求根本没成功（那是错误，走 `fcErr`，不走到这里）。
   * 两者都是"屏幕上什么都没有"，但下一步动作相反：
   * 前者是"这个标的在历史上找不到足够的近邻，换更长的时间尺度再看"，
   * 后者是"编排服务没连上，去检查它起没起"。
   * 兜一句"暂无数据"会把这两件事压成同一句 —— 用户就只能猜（判据 25）。
   */
  emptyNote?: string
}

/**
 * 走势图 —— 把 `ForecastResult.path` 画成价位分位带。
 *
 * ── 为什么画的是「带」而不是一条预测线 ──────────────────────────────
 * 预测产出的是**未来收益的经验分布**，不是一条确定的轨迹。
 * 画一条单点曲线出来，等于把"分布"谎报成"路径"：用户会盯着那根线问
 * "它会先跌后涨吗"，而数据根本没回答过这个问题。
 * 带宽本身就是「确定性有多低」的读数 —— 这是这张图唯一的诚实画法。
 *
 * ── 为什么几何用 SVG、文字用 HTML ──────────────────────────────────
 * 这个组件要填满一块**宽度不定、高度固定**的容器。若让 SVG 按 `viewBox`
 * 等比缩放，图会缩成中间一小团；若用 `preserveAspectRatio="none"` 拉满，
 * **图里的文字会被横向拉扁**（一眼假）。
 * ⇒ 所以：几何走 `preserveAspectRatio="none"` 的归一化坐标系（0~100），
 *   描边加 `vectorEffect="non-scaling-stroke"` 保证线宽不被拉粗；
 *   所有文字与标记走**绝对定位的 HTML 层**，位置用百分比给 —— 它们不会变形。
 *
 * ── 涨跌配色 ────────────────────────────────────────────────────────
 * 中位路径按方向着色：`up` = `var(--up)`（**红**）、`down` = `var(--down)`（**绿**）。
 * 这是中国市场的约定，与本项目 `tokens.css` 的定义一致（`--up: #FF4D6D`）。
 * 方向为 `null` 时用中性色 —— 它表示"样本不足以给方向"，不是"持平"，
 * 拿红或绿去涂都是在替数据表态。
 */
export default function ForecastChart({
  path,
  spot,
  interval,
  direction,
  target,
  barMinutes,
  horizonBars,
  emptyNote,
}: ForecastChartProps) {
  const geo = useMemo(() => {
    if (path.length === 0 || !Number.isFinite(spot) || spot <= 0) return null

    // x 轴：第 0 点是"现在"，右边缘是"未来第 horizonBars 根"。
    // ★ 除以 `horizonBars` 而不是 `path.length` —— 两者本应相等，
    //   但若服务端少给了一两步，除以 `path.length` 会把图画成"到点了"，
    //   而实际上还差一截。宁可右边留白。
    const xs: number[] = [0]
    const p10: number[] = [spot]
    const p50: number[] = [spot]
    const p90: number[] = [spot]
    for (const pt of path) {
      xs.push((pt.step / Math.max(horizonBars, 1)) * 100)
      p10.push(pt.p10)
      p50.push(pt.p50)
      p90.push(pt.p90)
    }

    const all = [...p10, ...p50, ...p90]
    if (interval) all.push(interval.lo, interval.hi)
    if (target !== null && Number.isFinite(target)) all.push(target)
    let lo = Math.min(...all)
    let hi = Math.max(...all)
    if (!(hi > lo)) {
      // 全部落在同一个价位（比方说极端平滑的样本）：给一个极小的窗，
      // 否则除以 0 会得到 NaN，而 `NaN` 写进 SVG 属性的表现是**图整体消失** ——
      // 一个"画不出来"和"数据是平的"分不清的现场。
      lo = lo * 0.999
      hi = hi * 1.001
      if (!(hi > lo)) {
        lo = lo - 1
        hi = hi + 1
      }
    }
    const pad = (hi - lo) * 0.08
    lo -= pad
    hi += pad
    const y = (p: number) => 100 * (1 - (p - lo) / (hi - lo))

    const bandPoints = [
      ...xs.map((x, i) => `${x.toFixed(2)},${y(p90[i]).toFixed(2)}`),
      ...xs
        .map((x, i) => `${x.toFixed(2)},${y(p10[i]).toFixed(2)}`)
        .reverse(),
    ].join(' ')
    const medianPoints = xs.map((x, i) => `${x.toFixed(2)},${y(p50[i]).toFixed(2)}`).join(' ')

    const last = xs.length - 1
    return {
      y,
      lo,
      hi,
      bandPoints,
      medianPoints,
      spotY: y(spot),
      endX: xs[last],
      endY: y(p50[last]),
      endP50: p50[last],
    }
  }, [path, spot, interval, target, horizonBars])

  if (!geo) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 16px',
          textAlign: 'center',
          fontFamily: 'var(--font-ui)',
          fontSize: 10,
          lineHeight: 1.6,
          color: 'var(--text-weak)',
          border: '1px dashed var(--border)',
          borderRadius: 8,
        }}
      >
        {emptyNote ?? '没有可画的走势（调用方没有给原因，这本身是个缺陷）'}
      </div>
    )
  }

  const lineColor =
    direction === 'up' ? 'var(--up)' : direction === 'down' ? 'var(--down)' : 'var(--text-sub)'
  const hours = ((horizonBars * barMinutes) / 60).toFixed(1).replace(/\.0$/, '')

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0 }}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
      >
        {/* 80% 分位带：这是"未来可能走到的范围"，不是"预测的路径" */}
        <polygon points={geo.bandPoints} fill="var(--primary)" fillOpacity={0.13} />
        <polyline
          points={geo.bandPoints}
          fill="none"
          stroke="var(--primary)"
          strokeOpacity={0.35}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {/* 中位路径 */}
        <polyline
          points={geo.medianPoints}
          fill="none"
          stroke={lineColor}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* 现价基线 */}
        <line
          x1={0}
          y1={geo.spotY}
          x2={100}
          y2={geo.spotY}
          stroke="var(--text-weak)"
          strokeWidth={1}
          strokeDasharray="1 1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* ── 文字层（HTML，不受 SVG 拉伸影响）───────────────────────── */}
      <div
        style={{
          position: 'absolute',
          left: 2,
          top: `${geo.spotY}%`,
          transform: 'translateY(-50%)',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-weak)',
          background: 'var(--bg-card)',
          padding: '0 3px',
          borderRadius: 3,
        }}
      >
        现价 {spot >= 1000 ? spot.toFixed(0) : spot.toFixed(2)}
      </div>

      {/* 区间上下沿（右侧） */}
      <div style={{ position: 'absolute', right: 0, top: 0, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-weak)', lineHeight: 1 }}>
        {geo.hi.toFixed(0)}
      </div>
      <div style={{ position: 'absolute', right: 0, bottom: 0, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-weak)', lineHeight: 1 }}>
        {geo.lo.toFixed(0)}
      </div>

      {/* 时间轴：左端"现在"、右端"+N 小时" */}
      <div style={{ position: 'absolute', left: 0, bottom: -2, fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--text-weak)', lineHeight: 1 }}>
        现在
      </div>
      <div style={{ position: 'absolute', right: 0, bottom: -2, fontFamily: 'var(--font-ui)', fontSize: 9, color: 'var(--text-weak)', lineHeight: 1 }}>
        +{hours}h（{horizonBars}×{barMinutes}m）
      </div>

      {/* 中位目标：只在中位路径的**终点**标一个点。
          ★ 不画成一条通到右边缘的横线 —— 那会看起来像"价位会被锁定在这"。 */}
      {target !== null && direction !== null && (
        <div
          style={{
            position: 'absolute',
            left: `${geo.endX}%`,
            top: `${geo.endY}%`,
            transform: 'translate(-50%, -50%)',
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: lineColor,
            boxShadow: '0 0 0 2px var(--bg-card)',
          }}
        />
      )}
    </div>
  )
}
