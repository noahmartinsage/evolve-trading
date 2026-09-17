import WebSocket from 'ws'

export interface FeedTick {
  symbol: string
  price: number
  ts: number
}

export interface FeedHandle {
  close(): void
}

/**
 * C-13 实时行情：Binance combined miniTicker WebSocket 流。
 * - 每秒级推送最新价（真实实时同步，替代 30s 轮询定价）
 * - 断线指数退避重连；30s 无消息判定 stale 并告警回调
 */
export function connectTickerStream(
  symbols: string[],
  restBase: string,
  onTick: (t: FeedTick) => void,
  onStatus: (online: boolean, staleSymbols: string[]) => void,
): FeedHandle {
  const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join('/')
  const wsBase = process.env.FEED_WS_URL ?? 'wss://data-stream.binance.vision'
  const wsUrl = `${wsBase}/stream?streams=${streams}`

  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0
  let reconnectTimer: NodeJS.Timeout | null = null
  const lastTickBySymbol = new Map<string, number>()

  const staleCheck = setInterval(() => {
    const now = Date.now()
    const stale = symbols.filter((s) => {
      const t = lastTickBySymbol.get(s)
      return t === undefined || now - t > 30_000
    })
    onStatus(closed ? false : stale.length < symbols.length, stale)
  }, 5_000)

  function connect(): void {
    if (closed) return
    attempt += 1
    try {
      ws = new WebSocket(wsUrl)
    } catch {
      scheduleReconnect()
      return
    }

    ws.on('open', () => {
      attempt = 0
      onStatus(true, [])
    })

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as { stream?: string; data?: MiniTicker }
        const d = msg.data
        if (!d || !d.s) return
        lastTickBySymbol.set(d.s, Date.now())
        onTick({ symbol: d.s, price: parseFloat(d.c), ts: d.E ?? Date.now() })
      } catch {
        /* 坏帧忽略 */
      }
    })

    ws.on('error', () => {
      /* close 会触发重连 */
    })

    ws.on('close', () => {
      if (!closed) onStatus(false, [])
      scheduleReconnect()
    })
  }

  function scheduleReconnect(): void {
    if (closed) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempt, 5)))
    reconnectTimer = setTimeout(connect, delay)
  }

  connect()

  return {
    close() {
      closed = true
      clearInterval(staleCheck)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try {
        ws?.close()
      } catch {
        /* noop */
      }
    },
  }
}

interface MiniTicker {
  s: string
  c: string
  E?: number
}
