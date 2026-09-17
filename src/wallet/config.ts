import { createConfig, fallback, http } from 'wagmi'
import { mainnet, base, arbitrum, optimism, polygon, bsc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { USDC_BY_CHAIN } from '../dex/uniswap'

/** 多链支持：Ethereum / Base / Arbitrum / Optimism / Polygon / BNB Chain */
export const chains = [mainnet, base, arbitrum, optimism, polygon, bsc] as const

/** 各链 USDC 合约（单一来源：src/dex/uniswap.ts，勿在此处另维护副本） */
export const usdcByChain = USDC_BY_CHAIN

export const chainColor: Record<number, string> = {
  [mainnet.id]: '#8A92B2',
  [base.id]: '#0052FF',
  [arbitrum.id]: '#28A0F0',
  [optimism.id]: '#FF0420',
  [polygon.id]: '#8247E5',
  [bsc.id]: '#F0B90B',
}

export const config = createConfig({
  chains: [mainnet, base, arbitrum, optimism, polygon, bsc],
  connectors: [injected()],
  transports: {
    [mainnet.id]: fallback([http('https://ethereum-rpc.publicnode.com'), http('https://eth.llamarpc.com'), http()]),
    [base.id]: fallback([http('https://base-rpc.publicnode.com'), http()]),
    [arbitrum.id]: fallback([http('https://arbitrum-one-rpc.publicnode.com'), http()]),
    [optimism.id]: fallback([http('https://optimism-rpc.publicnode.com'), http()]),
    [polygon.id]: fallback([http('https://polygon-bor-rpc.publicnode.com'), http()]),
    [bsc.id]: fallback([http('https://bnb-rpc.publicnode.com'), http()]),
  },
})
