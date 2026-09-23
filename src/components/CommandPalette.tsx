import { useEffect, useMemo, useRef, useState } from 'react'

import { MARKET, DEFAULT_SYMBOL_INTERNAL } from '../market/registry.ts'
import { navItems } from './Sidebar.tsx'
import { usePage, useStore } from '../store/Store'
import type { PageId } from '../store/Store'

/**
 * ⌘K / Ctrl+K 命令面板。
 *
 * ── 学上游的哪一点 ────────────────────────────────────────────────────
 * 上游 OpenTerminal 的招牌交互就是这个 ⌘K（暗色、密集、键盘优先）。
 * 值得学的是**形态**：一个覆盖层 + 一个输入框 + 上下键 + 回车，
 * 「跳到某个标的」这件事从"用鼠标在一列里找"变成"打两个字回车"。
 *
 * ── 但有两点必须与它不同（否则会违反本项目的红线）────────────────────
 * ① **名单不许在这里再抄一份。**
 *    上游的候选是它自己调 `/api/search` 取回来的；本项目已经有
 *    `src/market/registry.ts` 作为标的的**唯一事实源**（上一轮刚从五个主人收敛成一个）。
 *    面板里再写一张表 = 立刻多出第六个主人，而它不会因为注册表改了而报错。
 *    ⇒ 候选**从注册表现读**，翻页项**从侧边栏现读**。
 * ② **它只做导航，不做操作。**
 *    本项目里"执行一个操作"是一件有闸门的事（`server/uiActions.ts` 注册表 +
 *    两段式确认 + `writes` 白名单）。命令面板若自己发动作，就等于开了
 *    第二条路径 —— 而"同一个业务动作只能有一条实现路径"是判据 8。
 *    ⇒ 面板只切**交易对**与**页面**；要按按钮请走桌宠/界面那条唯一的路。
 *    （上游没有这个约束，因为它不执行交易。）
 *
 * ── 为什么开着的时候要把底层页面的快捷键让开 ─────────────────────────
 * 本项目没有别的全局快捷键，所以这里只需要管住自己：Esc 关、回车选、
 * 上下键移动，且输入框自动聚焦。除此之外不拦任何按键（不 preventDefault）。
 */
interface Item {
  kind: 'pair' | 'page'
  key: string
  label: string
  hint: string
}

export default function CommandPalette() {
  const { state, dispatch } = useStore()
  const { page } = usePage()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // 全局开关：Ctrl+K / ⌘K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      // 稍等一帧再聚焦：覆盖层这一帧还没挂到 DOM 上
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const pairs: Item[] = MARKET.map((m) => ({
      kind: 'pair',
      key: m.symbol,
      label: m.symbol,
      hint: m.exchange + (m.symbol === DEFAULT_SYMBOL_INTERNAL ? ' · 常用' : ''),
    }))
    const pages: Item[] = navItems.map((n) => ({ kind: 'page', key: n.id, label: n.label, hint: '页面' }))
    return [...pairs, ...pages]
  }, [])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle === '') return items
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(needle) ||
        // 打 `btcusdt` 也要能命中 `BTC-USDT`（人不会记得那个连字符）
        it.label.toLowerCase().replace(/-/g, '').includes(needle.replace(/-/g, '')),
    )
  }, [items, q])

  useEffect(() => setSel(0), [q])

  if (!open) return null

  const pick = (it: Item) => {
    if (it.kind === 'pair') {
      // 与左侧列表点击**同一件事**（同一个 action），不是第二条路径。
      dispatch({ type: 'SET_PAIR', pair: it.key })
      dispatch({ type: 'SET_PAGE', page: 'terminal' })
    } else {
      dispatch({ type: 'SET_PAGE', page: it.key as PageId })
    }
    setOpen(false)
  }

  return (
    <div className="cmdk-mask" onClick={() => setOpen(false)}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            '交易对或页面…（Enter 打开 · Esc 关闭 · 现在在「' +
            (navItems.find((n) => n.id === page)?.label ?? page) +
            '」）'
          }
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, Math.max(0, shown.length - 1)))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            }
            if (e.key === 'Enter' && shown[sel]) pick(shown[sel])
          }}
        />
        <div className="cmdk-list">
          {shown.map((it, i) => (
            <div key={it.kind + it.key} className={`cmdk-item ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => pick(it)}>
              <span className="cmdk-label">{it.label}</span>
              <span className="cmdk-hint">{it.hint}</span>
            </div>
          ))}
          {shown.length === 0 && (
            <div className="cmdk-empty">
              没有匹配「{q}」的标的或页面。
              {/* ★ 空结果也要说清它搜的是**哪些**东西 —— 否则用户会以为系统里没有这个标的 */}
              （可搜的只有 {MARKET.length} 个标的与 {navItems.length} 个页面；标的名单来自行情注册表）
            </div>
          )}
        </div>
        <div className="cmdk-foot">
          只做跳转 —— 下单与其它会改状态的动作一律走界面按钮或桌宠那条唯一的路（{state.pairs.length} 个标的已加载）
        </div>
      </div>
    </div>
  )
}
