import { createStack, renderExitReport, stackRoles } from './stackCore.ts'
import { loadDotEnv } from './loadEnv.ts'

loadDotEnv()

// C-1 dev stack: ledger(8791) + orchestration(8790) + web(vite dev server)
// Usage: npm run stack   (local development only, never production)
//
// ★ 角色清单（端口 / 令牌 / 场所 / 账本地址）**不在这里**，在 `stackCore.ts`。
//   它同时服务"开发（dev server）"与"双击启动（构建产物 + 桌宠）"两个入口；
//   各写一遍的后果是那种最难查的症状：一边能连上、另一边 `Failed to fetch`，
//   而原因（端口或令牌不一致）与症状看起来毫无关系。
//
//   本文件现在只负责两件事：选前端形态 = `dev`，以及把"意外退出即收尾"接上。
if (process.env.NODE_ENV === 'production') {
  console.error('[devStack] production deployment must run roles separately; aborting')
  process.exit(1)
}

const stack = createStack({
  onUnexpectedExit: (report) => {
    // 与双击启动走**同一个**渲染函数：否则"开发时看到的告警"和"双击时看到的告警"
    // 会慢慢长成两份，而排查时你手里只有其中一份。
    for (const line of renderExitReport(report)) console.error(line)
    stack.shutdown()
  },
})

for (const role of stackRoles({ web: 'dev', venue: process.env.VENUE ?? 'sandbox' })) stack.start(role)

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => stack.shutdown())

console.log('[devStack] ledger + orch + web(vite dev) · Ctrl+C stops all')
