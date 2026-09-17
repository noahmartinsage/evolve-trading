# 仓库勘察记录（"团队内保存常用筛选"方案前置）

> 生成时间：2026-09-17 · 方法：只读检查工作区，不修改源码
> 目的：为技术方案提供**可核对的现状事实**，并标出与需求描述不一致之处。

## 1. 结论速览

| 需求描述中的前提 | 代码中的事实 | 判定 |
|---|---|---|
| 前端 React | React 18 + Vite 8，自研 Store（`useReducer` + Context） | ✅ 一致 |
| 后端 Node.js | 自研 `node:http` 服务（`server/index.ts`，手写路由） | ✅ 一致 |
| 数据库 PostgreSQL | **`node:sqlite`（`DatabaseSync`）**，无 PostgreSQL / 无 ORM | ❌ **不一致** |
| "每名用户最多 50 个" | **系统当前没有用户概念**，只有单一共享 `ORCH_TOKEN` | ❌ **前置缺失** |
| "团队共享" | **没有 teams / 成员模型** | ❌ **前置缺失** |
| "兼容旧链接" | 前端**没有路由**，无 hash / history API 使用 | ⚠️ 需澄清所指 |

## 2. 前端链路

- 入口：`src/main.tsx` → `StoreProvider` → `AppInner`。
- 路由：**不存在路由库**。`src/App.tsx` 的 `Router()` 直接 `switch (page)`，`page` 来自 Store 内存状态（`PageId` 联合类型，12 个页面）。
- 状态：`src/store/Store.tsx`（451 行）单文件。持久化仅 `localStorage` 键 `evolve.prefs.v1`，且**只存 4 个字段**：`mode` / `risk` / `orchUrl` / `orchToken`。
- URL 使用面：**只有一处** —— `?pet=1`（`main.tsx` 与 `App.tsx` 各读一次，用于桌宠透明窗形态）。
  - 无 `pushState` / `replaceState` / `hashchange` / `popstate` 监听。
  - 浏览器后退按钮不会切换页面；页面状态无法通过 URL 复现。
- 现有"筛选"：全部是数组的即时 `.filter()`（如 `TerminalPage.tsx:229` 的 `activeOrders`），**没有可保存 / 可共享的筛选概念**，本需求是净新增。

## 3. 后端链路

- 服务：`server/index.ts` 单文件手写路由，按 `url.pathname` 字符串比较分发（约 60+ 个 endpoint 分支）。
- 鉴权：`authorized(req)` 仅比较 `req.headers['x-orch-token'] === TOKEN`，`TOKEN` 来自 `process.env.ORCH_TOKEN`，开发默认 `dev-insecure-token`；`NODE_ENV=production` 且未设置时为 fail-closed（拒绝启动，`server/index.ts:123`）。
- **没有**：用户表、会话、JWT、团队、角色、成员关系。请求者身份不可区分。
- 持久化：`server/persistence.ts` 使用 `node:sqlite` 的 `DatabaseSync`，`PRAGMA journal_mode = WAL`。表：`events` / `snapshots` / `promotions` / `strategies` / `audit_chain` / `proposals` / `event_origins`。
- 迁移方式：`initPersistence()` 内联 `CREATE TABLE IF NOT EXISTS`（**只增不改，无版本号、无回滚脚本**）。
- 已有的可复用能力：
  - 审计哈希链 `audit_chain` + `appendEvent`（可承载筛选变更审计）。
  - 单实例声明 `claimInstance` / `heartbeatInstance`（说明当前部署模型是**单写者**）。
  - 保留策略 `server/retention.ts`（先归档 JSONL 再清理）。

## 4. 工程门禁与验证方式

- `package.json` 的 `ci` 是 **`&&` 短路链**：lint → typecheck → 22 套 smoke → golden 回测 → build → audit:sec（README 称 27 道）。
- 缺省 smoke 已成惯例：`scripts/*-smoke.ts` 直接用 `node` 跑。新功能应循此惯例补 `scripts/filter-smoke.ts` 并挂进 CI。
- 本次实际执行的验证（推送前）：`npx tsc --noEmit` ✅ exit 0、`npm run lint` ✅ exit 0、`npm run build` ✅ exit 0。
- CI 工作流 `.github/workflows/ci.yml` 跑的是 lint / typecheck / backtest:golden / build / audit —— **注意它与 `npm run ci` 并不等价**（CI 未跑全部 smoke）。

## 5. 与"推送仓库"相关的现场事实

- 工作区原先**不是 git 仓库**（无 `.git`），本次首次 `git init -b main`。
- `gh` 已以 `noahmartinsage` 登录（scopes：`repo`、`workflow`、`gist`、`read:org`）。
- 账号下原先**不存在** `evolve-app` / `evolve-trading` 仓库。
- `.env` 存在且含测试网密钥（`OKX_TESTNET_*` / `BINANCE_TESTNET_*`），**已被 `.gitignore` 排除**，未入库。
- 工作区存在大量调试中间产物与运行数据，本次已补充 `.gitignore` 排除：
  - 目录：`data/`（33MB，含 `ledger.db` + WAL）、`artifacts/`（1.4MB 演练记录）、`.preview/`、`.preview-pylibs/`（15MB）、`_upstream/`（上游参考代码，非本项目）。
  - 文件：根目录 `_*.txt` / `_*.log` / `_*.mjs`（22 个）。
- 待提交文件 220 个，密钥模式扫描仅命中 `scripts/mission-smoke.ts:482` 的 `sk-abcdefghijklmnopqrstuvwx` —— 它是 redact 功能的**测试夹具字符串**，非真实密钥。

## 6. 需要澄清的三个问题（影响方案走向）

1. **PostgreSQL 从哪来？** 现有数据层是 SQLite。若"PostgreSQL"是硬约束，则等于新增数据层 + 迁移 + 连接管理，两周内无法与筛选功能同时完成。
2. **用户与团队从哪来？** 现有系统无身份。若需新建身份体系，"50 个/用户"与"团队共享"才可落地；否则只能退化为"单实例内共享"。
3. **"旧链接"具体指什么？** 现有前端唯一可分享的 URL 形态是根路径 + `?pet=1`。若团队日常分享的链接形如 `?f=xxx` 之类而代码中不存在，需用户提供样本。
