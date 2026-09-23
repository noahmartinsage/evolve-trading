import { useEffect, useRef, useState } from 'react'

/**
 * 「这个值刚刚变了」——一小段时间内为 `true`。
 *
 * ── 为什么值得单独一个 hook ──────────────────────────────────────────
 * 密集的行情列表里，**变**这个信息比"当前是多少"更值钱：
 * 一行二十个数字，人眼扫不出哪一个刚动过。上游 OpenTerminal 用同样的手法
 * （`useFlash` → 450ms 白闪），这里学的是它的**语义**，不是它的实现。
 *
 * ── 两条容易写错的地方 ──────────────────────────────────────────────
 * ① **首次赋值不许闪**。`prev` 的初值就是当前值，所以挂载时 `prev === value`，
 *    自然不闪。若把初值写成 `undefined` 再判 `prev !== value`，那么每一行
 *    在第一次收到行情时都会闪一下 —— 二十行同时闪，等于没有信号。
 * ② **`null → 数字` 不许闪**。那是"第一次拿到报价"，不是"报价变了"；
 *    让它闪会把"行情刚接上"伪装成"价格在动"（判据 17）。
 *    反过来 `数字 → null`（断线清空）也不闪 —— 那不是价格变动。
 *
 * 用法：`const on = useFlash(px)`，然后把它当成 class 的一个开关。
 */
export function useFlash(value: number | string | null | undefined, ms = 450): boolean {
  const prev = useRef(value)
  const [flashing, setFlashing] = useState(false)

  useEffect(() => {
    const had = prev.current !== null && prev.current !== undefined
    const has = value !== null && value !== undefined
    const changed = had && has && prev.current !== value
    prev.current = value
    if (!changed) return
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), ms)
    return () => clearTimeout(t)
  }, [value, ms])

  return flashing
}
