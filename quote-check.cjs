const { createPublicClient, http, parseUnits, formatUnits } = require('viem')
const { mainnet } = require('viem/chains')

const quoterV2Abi = [{
  type: 'function',
  name: 'quoteExactInputSingle',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'fee', type: 'uint24' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [
    { name: 'amountOut', type: 'uint256' },
    { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' },
    { name: 'gasEstimate', type: 'uint256' },
  ],
}]

async function main() {
  const client = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') })
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
  const amountIn = parseUnits('3000', 6)
  for (const fee of [100, 500, 3000]) {
    try {
      const [out] = await client.readContract({
        address: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: USDC, tokenOut: WETH, amountIn, fee, sqrtPriceLimitX96: 0n }],
      })
      const eth = Number(formatUnits(out, 18))
      console.log(`fee=${fee} -> out=${eth} ETH, price=${3000/eth}`)
    } catch (e) {
      console.log(`fee=${fee} ERR: ${(e.message || String(e)).slice(0,120)}`)
    }
  }
}
main().catch(console.error)
