# EVOLVE

Web4.0 自进化量化交易系统的**控制面 + 受控执行编排**。

> **当前定位（2026-09-15 · 阶段 C 控制面闭环 + 过拟合判定闭环）**：真实行情 + 独立 orchestration 进程 + 默认拒绝风控 + **晋升内禁强制（live 意图按策略阶段授权+资金帽）** + **审计哈希链防篡改** + **SLO 真实度量** + **LLM 提案器（只提案不下单）** + **过拟合门禁（CSCV-PBO 真实统计量，非自报布尔量）**。  
> **不是**商用生产级系统（L5 **6/8**；自进化 **4.5/5** = E1/E2/E4/E5 ✅ + E3 🟡；合规辖区与牌照 ❌ 未启动，缺一不得对客）。  
> **投真钱当前不可行，且这次是有数字依据的**：20 个候选在 30 天真实行情上 BTC PBO 40.1% / ETH 59.1%，过不了 `maxPbo=0.25`——
> 门禁给出的答案是「证据不足」，解锁路径是**延长历史到 6~12 个月**，不是放宽阈值。HFT 明确另立项目，本仓库永不承载。  
> 路线图冻结为：止血 ✅ → 回测/纸交易内核 ✅ → 小资金受控实盘（进行中）→ 商用；期间不加监控动画与协议 Tab。详见 [`docs/DEV_PROGRESS.md`](docs/DEV_PROGRESS.md)。

## 真实能力 vs 界面演示

| 能力 | 状态 |
|------|------|
| Binance 公开 REST / WebSocket 行情、K 线 | **真实**（失败时降级为本地随机游走） |
| 浏览器钱包连接、多链切换、链上余额 | **真实**（wagmi + 公共 RPC） |
| Uniswap V3 询价、approve 授权、SwapRouter02 兑换 | **真实 · 仅 LIVE 模式开放**（单参 exactInputSingle，含滑点保护与模拟执行） |
| sim / paper / live 模式硬隔离 | **双层**：UI 门禁 + 服务端强制（sim 拒收、live 必须带策略身份过晋升闸） |
| 下单前风控 / killswitch | **服务端真实执行**：默认拒绝、回撤熔断联动出站闸+撤单风暴、演练归档进 CI |
| 审计账本 | **SQLite(WAL) 追加写 + SHA-256 哈希链**（`/audit/verify` 可验证，篡改定位断点） |
| SLO 度量 | `/metrics` 真实测量：ACK P50/P99、拒绝归因、行情新鲜度（无告警/看板） |
| 策略晋升流水线 | **promotion-v4 强制化**：回测门（含**过拟合门禁**）→ 纸交易观察期 → 测试网实测 → 人工审批 → 小资金帽 → 全量，每步可回滚 |
| LLM 接入 | **仅提案器接口**（结构校验/去重/唯一出口=candidate）；「LLM 推理」动画仍为演示文案 |
| 密钥治理 | **生产 fail-closed + 权限范围自检**：`npm run keys:audit` 真问交易所「这把钥匙能做什么」（Read ✓ / Trade ✓ / Withdraw ✗ 三态判定，缺证据一律不放行） |
| 语音交互台 | **真实**：文字 + 语音对话、随时打断、持续播报"在做什么/下一步"、读日报。定位是**既有编排层的新入口**，不新开交易通道；悬浮桌宠与语音管家已合并为同一页（`standalone` 切形态，0 条新 API） |
| x402 / ERC-8004 / MCP / 治理投票 | **静态文案**（扩展已冻结） |

## 本地运行

```bash
npm install
npm run dev
```

默认 Vite 开发服务器。生产构建：

```bash
npm run build
npm run preview
```

## 工程门禁（二十七道）

> ✅ **当前实况：27/27 逐道实跑全绿**（2026-09-16 复核：`lint` / `typecheck` / 22 套 smoke / `backtest:golden` / `build` / `audit:sec`）。
> ⚠️ **`npm run ci` 是 `&&` 短路链——第一道红后面的都不会跑**，所以「跑一次没报错」不等于全绿；上面的数字是逐道跑出来的。
> 本节曾长期写着「15/18 通过、3 道红」——而那 3 道（`test:sandbox` / `test:autopilot` / `backtest:golden`）
> 已于 2026-09-13 全部闭环。**文档里的红灯不会自己灭**，逐道实测表见 [`docs/DEV_PROGRESS.md`](docs/DEV_PROGRESS.md) §3.6 / §7。

```bash
npm run ci                # 27 道串联：lint + typecheck + 22 套 smoke + golden 回归 + build + audit:sec
npm run test:pet          # 语音交互台（79 项 / 12 组）：可找回性 / 回声闸门 / 口型 / 透明窗三处同向 / P0 报警对比度 / 单一实现
npm run test:voice        # 语音层（12 场景）：意图解析 / 中文数字归一 / 两段式确认 / 打断作废 / P0 不可压制 / 播报溯源
npm run test:keyscope     # 密钥权限范围自检（21 项）：三态判定 / 缺证据不放行 / 调用方无从自报结论 / 聚合最坏优先
npm run keys:audit        # ⚠️ 非门禁：真问交易所「这把钥匙能做什么」（需密钥 + 联网，刻意不进 CI）
npm run test:risk-guard   # 风控内核（29 项断言）：1R 定规模 / 止损几何 / 0.8R 保本棘轮 / 宪法红线 / 样本量不可自报
npm run test:overfit      # 过拟合门禁（30 项断言）：CSCV-PBO / 赢家样本外分位 / 选择净收益 / 凭据不可伪装
npm run test:r20          # R20 内化（40 项断言）：原子写盘 / 风险预算预留 / 证据分档 / 口径插值 / 政策快照
npm run test:trusted-seam # 可信接缝（49 项断言）：成本闸门 / 对手方三档信任 / 跨通道结算 / 声称核验 / 上下文预算
npm run backtest:golden   # 可复现回测黄金回归（同输入 bit 级一致 + 过拟合凭据 + 基线比对）
npm run test:orch         # 编排冒烟：风控/熔断/晋升闸/资金帽/握手门/killswitch 同步断言
npm run test:commercial   # 商用加固冒烟：审计哈希链/篡改定位/SLO 指标/提案器安全边界
node quote-check.cjs      # 主网 QuoterV2 询价冒烟
```

> 两套纯逻辑烟测（`test:risk-guard` + `test:r20`，共 69 项断言）不需要网络与交易所，
> 1 秒内即可判断「风控内核与账本语义是否完好」——**在新环境里这是最快的可信度判据**。

## Orchestration 服务

```bash
npm run stack   # 一键三进程开发栈：ledger(8791) + orchestration(8790, 镜像互查默认启用) + web(vite)
```

独立 Node 进程：下单前风控、killswitch、追加写哈希链账本、纸面撮合、晋升流水线、提案器：

```bash
ORCH_TOKEN=<随机密钥> npm run orch   # 默认 :8787 · 配置见 .env.example
```

- `GET /healthz | /state | /events?since= | /gateway/status | /metrics | /audit/verify | /promotions | /proposals`
- `POST /orders`（需 `x-orch-token`）：paper 直接撮合；live 必须携带 `strategyId` 且该策略处于 `small_cap_live` 阶段并受资金帽约束
- `POST /proposals` → 提案入库；`POST /proposals/:id/promote` → 仅创建 candidate 记录（无法直接交易）
- `DELETE /orders/:id` · `POST /killswitch`
- 密钥治理：生产环境未设令牌拒绝启动；venue 凭证缺失 fail-closed 不挂载

## 回测/进化内核（src/engine）

纯 TypeScript 引擎包，零 UI 依赖，可被 Vite 应用与 Node 脚本双端加载：

- **订单状态机**：`new → ack → partial → filled / cancelled / rejected`
- **撮合假设参数化**：maker/taker 费率、固定滑点、成交量参与上限、信号延迟 K 线
- **统一执行接口**：`BrokerClient` 契约；终端纸交易与 orchestration 均运行在 `PaperBroker` 上
- **适应度 fitness-v2**（冻结版本化）+ **Walk-forward + 组合净化** + **过拟合门禁（CSCV-PBO / 赢家样本外分位 / 选择净收益）** 均进 CI
- **可复现**：数据 contentHash 锁定 + 黄金基线锁定引擎行为
- **Autopilot（AP）**：一键启动 paper 全自治循环——因子挖掘→门禁评估→胜出策略执行→盈利目标止盈/-10%回撤保护，全事件落审计链
- **变异沙箱（E3）**：用户 makeStrategy 代码在 Node Permission Model 隔离子进程评估（受限 FS、脱敏环境变量、超时 SIGKILL）；POST /sandbox/evaluate
  网络出口已于 2026-09-13 **封死**（`server/sandbox/network-lockdown.ts` 经 `--import` 在用户代码前加载，实测 `fetch` / `net.connect` / `https.get` / `dns.lookup` 四条通道全部 BLOCKED，进 CI）
  ⚠️ **残留风险**：`--allow-fs-read` 仍指向项目根，沙箱**能读到 `.env`**（但网络已断，「读密钥→外发」链已断）。收窄到 `src/engine` + `server/sandbox` 仍待办，详见 [`docs/DEV_PROGRESS.md`](docs/DEV_PROGRESS.md) §3.6.1

## 技术栈

- React 18 + TypeScript + Vite 8（控制面）
- Node orchestration：`ws` + `node:sqlite`(WAL)
- 行情：Binance 公开 API（`src/data/market.ts`）
- 钱包 / 链：wagmi + viem；DEX：Uniswap V3（`src/dex/uniswap.ts` 单一来源）

## 文档

> 每个事实**只允许有一个权威出处**，其余文档用引用而非复述。
> 冲突时的判定优先级见 `docs/DEV-PROMPT-KIT.md` 的 Part J3。

- [技术开发提示词套件](docs/DEV-PROMPT-KIT.md) — ★ **技术事实与复现提示词的唯一出处**：架构 / 契约 / 坑位 / 门禁 / 多智能体团队 / 生产级交付（13 Part）
- [开发进度总控文档](docs/DEV_PROGRESS.md) — ★ **完成度与缺陷清单的唯一出处**：商用达标矩阵、缺陷清单、分阶段路线图
- [提示词套件方法论母版](docs/PROMPT-KIT-METHOD.md) — 如何给任意项目产出同款套件 + LLM 提示词模板库
- [R20 对标与内化报告](docs/R20-BENCHMARK.md) — 外部开源项目对标、双向优劣矩阵、内化清单与明确不内化项
- [双通道可信接缝对标与内化报告](docs/SEAM-BENCHMARK.md) — 多源情报对标（Web4.0 / 多 Agent 验证 / Skill 经济 / 加密量化成熟度）、6 模块内化、过程缺陷与遗留项
- [合规能力映射](docs/COMPLIANCE.md) — 合规门槛与对客交付清单
