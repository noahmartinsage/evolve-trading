// Uniswap V3 DEX 执行层：链上报价（QuoterV2）+ 交易构造（SwapRouter02）
// 全部通过公共 RPC 完成，无需任何 API key

export const FeeTier = { LOW: 100, MEDIUM: 500, HIGH: 3000 } as const
export const FEE_TIERS: number[] = [100, 500, 3000]

/** 各链合约地址（Uniswap V3 官方通用部署：QuoterV2 / SwapRouter02 在所有 EVM 链地址一致） */
const UNI_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
const UNI_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'

export const contractsByChain = {
  1: { // Ethereum
    quoter: UNI_QUOTER,
    router: UNI_ROUTER,
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  8453: { // Base
    quoter: UNI_QUOTER,
    router: UNI_ROUTER,
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  42161: { // Arbitrum One
    quoter: UNI_QUOTER,
    router: UNI_ROUTER,
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  10: { // OP Mainnet
    quoter: UNI_QUOTER,
    router: UNI_ROUTER,
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  137: { // Polygon
    quoter: UNI_QUOTER,
    router: UNI_ROUTER,
    weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
} as const

export type DexChainId = keyof typeof contractsByChain

export function dexSupported(chainId: number | undefined): chainId is DexChainId {
  return chainId !== undefined && chainId in contractsByChain
}

export const quoterV2Abi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const

export const swapRouterAbi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/** 全站唯一 USDC 地址来源（wallet/config 从此处引用，禁止另行维护副本） */
export const USDC_BY_CHAIN: Record<number, `0x${string}` | undefined> = {
  1: contractsByChain[1].usdc,
  8453: contractsByChain[8453].usdc,
  42161: contractsByChain[42161].usdc,
  10: contractsByChain[10].usdc,
  137: contractsByChain[137].usdc,
  56: undefined, // BNB Chain 未配置 Uniswap V3 路由
}

export interface DexRoute {
  chainId: DexChainId
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  symbolIn: string
  symbolOut: string
  decimalsIn: number
  decimalsOut: number
  fee: number
  isNativeIn: boolean // tokenIn 为 WETH 且以 native ETH 支付
}
