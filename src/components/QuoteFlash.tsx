import { useEffect, useRef, useState } from 'react'

import { useFlash } from '../ui/useFlash'

/**
 * 会闪的价格。
 *
 * ★ 它必须是一个**组件**（而不是在列表里直接调 `useFlash`）：
 *   hook 不能出现在 `map` 回调里 —— 每个价格要有**自己的** `prev`，
 *   共用一个的话，第二行一变就会把第一行的比较基准冲掉（判据 31 同族：
 *   两个行情的数不能进同一个口径）。
 *
 * ★★ 方向在 **effect 里**判定，不在 render 里。
 *   第一版把 `prev` 存在 ref 里、在 render 期间读它来算涨跌方向 ——
 *   `eslint react-hooks/refs` 直接报「Cannot access refs during render」，
 *   而且它是对的：那个写法在**并发渲染**下会读到被丢弃的那次渲染推进过的 ref，
 *   于是出现「涨了但闪绿」。判据 8：同一件事只能有一条实现路径 ——
 *   方向与"变没变"必须由**同一个观测点**推出，且那个观测点只能是 effect。
 *
 * ★ 不闪的两个时机（与 `useFlash` 一致，这里必须自己再判一次，
 *   因为方向需要"变之前"的那个数）：首次赋值、以及 `null ↔ 数字` 的过渡。
 *   那两种都不是"价格在动"，让它闪就是把"行情刚接上"伪装成"价格动了"。
 */
export function QuoteFlash({
  value,
  text,
  className = '',
  style,
}: {
  value: number | null
  text: string
  className?: string
  style?: React.CSSProperties
}) {
  const on = useFlash(value)
  const prevRef = useRef<number | null>(null)
  const [dir, setDir] = useState<'' | 'qflash-up' | 'qflash-down'>('')

  useEffect(() => {
    const last = prevRef.current
    // 只在拿到真实数字时推进基准：`null` 是"还没报价"，它不该成为一个比较基准。
    if (value === null) return
    prevRef.current = value
    if (last === null || value === last) return
    setDir(value > last ? 'qflash-up' : 'qflash-down')
    return () => setDir('')
  }, [value])

  return (
    <span className={`${className}${on && dir !== '' ? ' ' + dir : ''}`} style={style}>
      {text}
    </span>
  )
}

export default QuoteFlash
