import React, { useEffect, useMemo, useState } from 'react'
import { useAccount, useSendTransaction, usePublicClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { parseEther, parseUnits, formatUnits, encodeFunctionData, maxUint256 } from 'viem'
import { contractsByChain, dexSupported, quoterV2Abi, swapRouterAbi, erc20Abi, DexChainId } from '../dex/uniswap'
import { useStore, pushToast, MODE_META } from '../store/Store'

interface Props {
  symbol: string // 仅支持 ETH-USDC
  side: 'buy' | 'sell'
  qty: string
  refPrice: number // Binance 实时价，用于价格冲击
}

export default function DexSwapPanel({ side, qty, refPrice }: Props) {
  const { state, dispatch } = useStore()
  const live = state.mode === 'live'
  const { address, chainId, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { sendTransactionAsync, isPending: sending } = useSendTransaction()

  const [amount, setAmount] = useState(qty || (side === 'sell' ? '1' : '3000'))
  const [slippage, setSlippage] = useState(0.5)
  const [status, setStatus] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)

  useEffect(() => { if (qty) setAmount(qty) }, [qty])

  const ok = dexSupported(chainId)
  const c = ok ? contractsByChain[chainId as DexChainId] : null

  const sellEth = side === 'sell'
  const tokenIn = sellEth ? c?.weth : c?.usdc
  const tokenOut = sellEth ? c?.usdc : c?.weth
  const decimalsIn = sellEth ? 18 : 6
  const decimalsOut = sellEth ? 6 : 18

  const amountIn = useMemo(() => {
    const n = parseFloat(amount)
    if (!n || n <= 0 || !c) return 0n
    try {
      return sellEth ? parseEther(amount) : parseUnits(amount, 6)
    } catch {
      return 0n
    }
  }, [amount, sellEth, c])

  type QuoteResult = readonly [bigint, bigint, number, bigint]
  const enable = ok && !!c && !!publicClient && amountIn > 0n
  const quoteKey = (fee: number) => ['dexQuote', chainId, tokenIn, tokenOut, amountIn.toString(), fee]
  const quoteFn = (fee: number): Promise<QuoteResult> =>
    publicClient!.readContract({
      address: c!.quoter,
      abi: quoterV2Abi,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: tokenIn as `0x${string}`, tokenOut: tokenOut as `0x${string}`, amountIn, fee, sqrtPriceLimitX96: 0n }],
    }) as Promise<QuoteResult>

  const qOpt = { enabled: enable, refetchInterval: 15000, retry: 1 }
  const q100 = useQuery<QuoteResult>({ queryKey: quoteKey(100), queryFn: () => quoteFn(100), ...qOpt })
  const q500 = useQuery<QuoteResult>({ queryKey: quoteKey(500), queryFn: () => quoteFn(500), ...qOpt })
  const q3000 = useQuery<QuoteResult>({ queryKey: quoteKey(3000), queryFn: () => quoteFn(3000), ...qOpt })

  const best = useMemo(() => {
    const entries: { fee: number; out: bigint }[] = []
    if (q100.data) entries.push({ fee: 100, out: q100.data[0] })
    if (q500.data) entries.push({ fee: 500, out: q500.data[0] })
    if (q3000.data) entries.push({ fee: 3000, out: q3000.data[0] })
    if (entries.length === 0) return null
    return entries.reduce((a, b) => (b.out > a.out ? b : a))
  }, [q100.data, q500.data, q3000.data])

  const quoting = q100.isPending || q500.isPending || q3000.isPending

  const outNum = best ? Number(formatUnits(best.out, decimalsOut)) : 0
  const inNum = Number(formatUnits(amountIn, decimalsIn))
  const execPrice = inNum > 0 && outNum > 0 ? (sellEth ? outNum / inNum : inNum / outNum) : 0
  const impact = execPrice > 0 && refPrice > 0 ? ((execPrice - refPrice) / refPrice) * 100 : 0
  const minOut = best ? (best.out * BigInt(10000 - Math.round(slippage * 100))) / 10000n : 0n
  const minOutNum = best ? Number(formatUnits(minOut, decimalsOut)) : 0

  // ERC-20 输入（USDC→ETH）需先授权 Router；native 输入（ETH→USDC）不需要
  const needsAllowanceCheck = !sellEth && ok && !!c && !!address && !!publicClient && amountIn > 0n
  const allowanceQuery = useQuery({
    queryKey: ['usdcAllowance', chainId, address, tokenIn],
    enabled: needsAllowanceCheck,
    refetchInterval: 20000,
    queryFn: () =>
      publicClient!.readContract({
        address: tokenIn as `0x${string}`,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address as `0x${string}`, c!.router as `0x${string}`],
      }) as Promise<bigint>,
  })
  const allowance = allowanceQuery.data
  const needsApprove = !sellEth && amountIn > 0n && (allowance === undefined || allowance < amountIn)

  const buildTx = () => {
    if (!c || !best || !address) return null
    const data = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: tokenIn!,
          tokenOut: tokenOut!,
          fee: best.fee,
          recipient: address,
          amountIn: amountIn,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
    return {
      to: c.router,
      data,
      value: sellEth ? amountIn : undefined,
    }
  }

  const simulate = async () => {
    if (!publicClient || !address || !c || !best) return
    const tx = buildTx()
    if (!tx) return
    setStatus('⏳ 链上模拟执行中…')
    try {
      const r = await publicClient.simulateContract({
        address: tx.to as `0x${string}`,
        abi: swapRouterAbi,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: tokenIn!,
            tokenOut: tokenOut!,
            fee: best.fee,
            recipient: address,
            amountIn: amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0n,
          },
        ],
        value: sellEth ? amountIn : undefined,
        account: address,
      })
      setStatus(`✅ 模拟通过 · 预计输出 ${formatUnits(r.result as bigint, decimalsOut)}${needsApprove && !sellEth ? ' · 注意：当前 USDC 未授权，真实执行前需先 approve' : ''}`)
      pushToast(dispatch, '🧪 Uniswap V3 模拟执行通过（eth_call，无资金风险）')
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 140) : String(e)
      setStatus(`❌ 模拟回滚：${msg}`)
    }
  }

  const approve = async () => {
    if (!c || !address || amountIn <= 0n) return
    setApproving(true)
    setStatus('⏳ 请在钱包中确认 USDC 授权…')
    try {
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [c.router as `0x${string}`, maxUint256],
      })
      const hash = await sendTransactionAsync({ to: tokenIn as `0x${string}`, data })
      setStatus(`📡 授权已广播 ${hash.slice(0, 14)}… 等待链上确认`)
      await publicClient!.waitForTransactionReceipt({ hash })
      await allowanceQuery.refetch()
      setStatus('✅ USDC 授权完成 · 可执行兑换')
      pushToast(dispatch, '✅ USDC 授权成功')
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 120) : String(e)
      setStatus(`❌ 授权失败：${msg}`)
    } finally {
      setApproving(false)
    }
  }

  const execute = async () => {
    const tx = buildTx()
    if (!tx || !c) return
    if (!live) {
      pushToast(dispatch, '🔒 链上签名仅在实盘模式开放 · 请在顶栏切换模式并二次确认')
      return
    }
    if (needsApprove && !sellEth) {
      pushToast(dispatch, '① 请先完成 USDC 授权，再执行兑换')
      return
    }
    setStatus('⏳ 请在钱包中确认交易…')
    try {
      const hash = await sendTransactionAsync({ to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: tx.value })
      setStatus(`📡 已广播 ${hash.slice(0, 14)}…${hash.slice(-8)}`)
      pushToast(dispatch, `📡 实盘交易已广播 · 等待矿工确认`)
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 120) : String(e)
      setStatus(`❌ 发送失败：${msg}`)
    }
  }

  const canExecute = live && !!best && isConnected && !sending && !(needsApprove && !sellEth)

  return (
    <div className="dex-panel">
      <div className="dex-mode-row">
        <span className={`chip ${live ? 'chip-red' : 'chip-gray'}`}>
          {live ? '实盘 · 链上交易' : `${MODE_META[state.mode].label} · 虚拟资金`}
        </span>
        {!sellEth && best && needsApprove && (
          <span className="chip chip-amber">需要 USDC 授权</span>
        )}
      </div>

      <div className="op-field">
        <span className="op-label">{sellEth ? '卖出数量 (ETH)' : '花费 (USDC)'}</span>
        <div className="op-input-wrap">
          <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <span className="op-suffix">{sellEth ? 'ETH' : 'USDC'}</span>
        </div>
      </div>

      {!ok ? (
        <div className="dex-note">⚠️ 当前链暂不支持 DEX 路由 · 请切换到 Ethereum / Base / Arbitrum / OP / Polygon</div>
      ) : (
        <>
          <div className="dex-quote">
            <div className="dq-row">
              <span className="dq-label">路由</span>
              <span className="dq-val">Uniswap V3 · 费率 {best ? (best.fee / 10000).toFixed(2) + '%' : '—'} 池</span>
            </div>
            <div className="dq-row">
              <span className="dq-label">预计获得</span>
              <span className="dq-val big">{quoting ? '询价中…' : best ? `${outNum.toLocaleString('en-US', { maximumFractionDigits: sellEth ? 2 : 6 })} ${sellEth ? 'USDC' : 'ETH'}` : '输入数量'}</span>
            </div>
            {best && (
              <>
                <div className="dq-row">
                  <span className="dq-label">执行价</span>
                  <span className="dq-val">${execPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
                </div>
                <div className="dq-row">
                  <span className="dq-label">价格影响 (vs Binance)</span>
                  <span className="dq-val" style={{ color: Math.abs(impact) > 0.3 ? 'var(--up)' : 'var(--down)' }}>{impact >= 0 ? '+' : ''}{impact.toFixed(3)}%</span>
                </div>
                <div className="dq-row">
                  <span className="dq-label">最小获得 (滑点 {slippage}%)</span>
                  <span className="dq-val">{minOutNum.toLocaleString('en-US', { maximumFractionDigits: sellEth ? 2 : 6 })}</span>
                </div>
                {!sellEth && (
                  <div className="dq-row">
                    <span className="dq-label">Router 授权额度</span>
                    <span className="dq-val">{allowanceQuery.isPending ? '查询中…' : allowance !== undefined ? Number(formatUnits(allowance, 6)).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' USDC' : '—'}</span>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="dex-slippage">
            <span className="op-label">滑点容忍</span>
            <div className="seg">
              {[0.1, 0.5, 1].map((s) => (
                <button key={s} className={slippage === s ? 'on' : ''} onClick={() => setSlippage(s)}>{s}%</button>
              ))}
            </div>
          </div>

          <div className="dex-actions">
            <button className="btn" disabled={!best || !address} onClick={simulate}>🧪 模拟执行</button>
            {needsApprove && !sellEth ? (
              <button className="btn btn-lg btn-primary" disabled={!live || !isConnected || approving} onClick={approve}>
                {!live ? '🔒 实盘模式才可授权' : approving ? '授权中…' : '① 授权 USDC'}
              </button>
            ) : (
              <button className={`btn btn-lg ${sellEth ? 'btn-sell' : 'btn-buy'}`} disabled={!canExecute} onClick={execute}>
                {!isConnected ? '先连接钱包' : !live ? '🔒 实盘才可签名' : sending ? '发送中…' : needsApprove && !sellEth ? '② 钱包签名兑换' : '⚡ 钱包签名执行'}
              </button>
            )}
          </div>

          {!live && (
            <div className="dex-lock">
              🔒 链上签名已锁定 · 当前为 <b>{MODE_META[state.mode].label}</b> 模式（虚拟资金）。<br />
              在顶栏切换到 <b>实盘</b> 并完成二次确认后，此处才会发起真实链上交易。
            </div>
          )}
          {isConnected && live && !sellEth && needsApprove && (
            <div className="dex-note">首次使用或额度不足时，需先签署一笔 USDC.approve(Router) 授权交易，再执行兑换。</div>
          )}
          {!isConnected && live && <div className="dex-note">连接钱包后即可通过 SwapRouter02 签名真实链上交易</div>}
          {status && <div className="dex-status">{status}</div>}
        </>
      )}

      <style>{`
        .dex-panel { display: flex; flex-direction: column; gap: 9px; }
        .dex-mode-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .dex-quote {
          background: var(--bg-surface); border: 1px solid var(--border);
          border-radius: 8px; padding: 10px 12px;
          display: flex; flex-direction: column; gap: 6px;
        }
        .dq-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .dq-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); white-space: nowrap; }
        .dq-val { font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: var(--text-main); text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dq-val.big { font-size: 14px; font-weight: 800; color: var(--primary); }
        .dex-slippage { display: flex; align-items: center; justify-content: space-between; }
        .dex-actions { display: flex; gap: 8px; }
        .dex-actions .btn { flex: 1; }
        .dex-note { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); line-height: 1.6; }
        .dex-lock {
          font-family: var(--font-ui); font-size: 11px; line-height: 1.7;
          color: var(--warning);
          background: rgba(255,176,32,0.07); border: 1px solid rgba(255,176,32,0.35);
          border-radius: 8px; padding: 8px 10px;
        }
        .dex-status {
          font-family: var(--font-mono); font-size: 10px; line-height: 1.6;
          background: var(--bg-surface); border: 1px solid var(--border);
          border-radius: 8px; padding: 8px 10px; color: var(--text-sub);
          word-break: break-all;
        }
      `}</style>
    </div>
  )
}
