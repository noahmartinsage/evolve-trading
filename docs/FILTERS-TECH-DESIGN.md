# 团队内保存常用筛选 · 技术方案

- 版本：v1.0（草案，待评审）
- 日期：2026-09-17
- 目标周期：两周（10 个工作日）
- 状态：**待确认三个前提假设后冻结**（见 §10）

---

## 0. 摘要

为 EVOLVE 控制面新增"保存常用筛选"能力：用户可在各数据页把当前筛选条件保存为具名筛选（私有或团队共享），一键复用、可分享链接直达。本方案基于仓库勘察（`docs/REPO-SURVEY.md`）起草。

**三个决定性前提（不满足则方案退化为降级形态，见 §10）：**

1. 现有数据层是 **SQLite（`node:sqlite`）**，不是 PostgreSQL——方案按"沿用 SQLite"设计；若 PostgreSQL 是硬约束，工作量与风险大幅上升。
2. 现有系统**没有用户/团队模型**——方案给出"最小身份模型"与"降级形态"两条路线。
3. "旧链接"在现有代码中**无对应物**——前端没有路由，唯一 URL 形态是 `?pet=1`。

---

## 1. 目标与非目标

### 目标（In Scope）

- **保存与复用**：任意数据页可将当前筛选条件保存为具名筛选，之后一键套用。
- **可见性双级**：筛选分"仅自己可见（私有）"与"团队共享"两种。
- **配额**：每名用户最多 **50 个**筛选（私有 + 共享各自或合计的语义见 §4.4，推荐合计）。
- **链接直达**：分享链接可还原筛选条件（兼容未来的"旧链接"形态，见 §4.6）。
- **不要求实时协同**：共享筛选为"发布后可见"，不做多人同时编辑、不做实时推送。

### 非目标（Out of Scope）

- 实时协同编辑（多人同时改一个筛选）——明确不做。
- 完整的用户注册/登录/权限体系——只做本功能所需的最小身份载体（见 §10 前提 2）。
- 筛选执行层改造——筛选**只存条件 JSON**，不改变现有各页的数据获取逻辑。
- PostgreSQL 迁移——除非用户确认其为硬约束（见 §10 前提 1）。
- 与现有 `localStorage` 偏好（`evolve.prefs.v1`）合并——筛选是服务端对象，偏好是浏览器本地对象，两者不混。

---

## 2. 现状链路（勘察结论）

```
浏览器 ──fetch──▶ server/index.ts（node:http 手写路由，60+ 分支）
                      │  x-orch-token 单令牌鉴权（无用户概念）
                      ▼
               persistence.ts（node:sqlite · DatabaseSync · WAL）
                      │  CREATE TABLE IF NOT EXISTS（只增不改，无迁移版本）
                      ▼
               data/orch.db（events / promotions / strategies / audit_chain …）

前端：App.tsx switch(page) 内存路由 ── 无 URL 同步 ── localStorage 仅存 4 字段偏好
```

关键事实（与需求的差异已在 §0 与 `docs/REPO-SURVEY.md` §1 列全）：

- 后端是 `node:http` + 手写路由，**无 Express/Fastify**；新接口照抄现有分支风格即可，无需引框架。
- 前端是**单文件 Store（`useReducer`）**；页内筛选状态均为组件内 `useState`/`useMemo` 的即时 `.filter()`，没有统一的"当前筛选状态"出口——这是本方案前端改造的主要工程量。
- 服务端无用户身份；唯一鉴权是 `x-orch-token` 静态令牌。

---

## 3. 方案选项

### 3.1 数据层：沿用 SQLite（推荐） vs 迁移 PostgreSQL

| 维度 | 沿用 SQLite（推荐） | 迁移 PostgreSQL |
|---|---|---|
| 成本 | 低：复用 `DatabaseSync` 与 `persistence.ts` 模式 | 高：新增驱动/连接池/迁移工具/部署依赖 |
| 风险 | 低：与现有 events 等表同库同构 | 高：双写一致性、回滚复杂 |
| 并发写 | `busy_timeout` + 单写者模式（现有 `claimInstance` 已假设单写者） | 更强但本功能不需要 |
| 团队共享 | 单实例内即可 | 多实例共享才有意义，但当前部署是单写者 |

**推荐：沿用 SQLite。** 理由：本功能是低频读写的配置类数据（50 个/人 × 10 人团队 = 500 行量级），SQLite 完全胜任；现有系统所有持久化都是 SQLite；两周周期内引入 PostgreSQL 无法同时完成功能。

### 3.2 身份模型：最小身份（推荐） vs 无身份降级

- **路线 A（推荐）：最小身份载体**——`x-orch-token` 之外，为每个"操作者"引入一个**可配置的用户标识**（`X-Evolve-User` 头或查询参数），由部署方在接入层分配（如反向代理注入 / 前端登录后持有）。服务端把它当作不透明字符串：`owner` = 该字符串，`scope='team'` 的筛选全员可见。
  - 不引入密码/注册/会话；不做权限分级（团队内人人可读写共享筛选，如需限制可后加）。
- **路线 B（降级）：无身份**——所有筛选都是"团队共享"，`owner` 字段留空。功能可完整演示，但"私有"与"每用户 50 个"不可落地。

**推荐：路线 A，但以"身份字符串可配置可替换"为前提实现**（见 §10 前提 2）。若两周内无法确定身份来源，先按路线 B 上线共享部分，私有部分留接口。

### 3.3 存储模型：独立表（推荐） vs 复用 events 表

| | 独立表 `saved_filters` | 复用 `events` 追加写 |
|---|---|---|
| 查询 | 直接 SQL，简单 | 需重建最新态（快照语义），复杂 |
| 审计 | 另行 appendEvent | 天然留痕 |
| 匹配现状 | 与 `promotions`/`proposals` 一致（同为配置表） | 与 `events` 语义不符（events 是事件流） |

**推荐：独立表 `saved_filters`**，变更留痕走现有 `appendEvent('FILTER_*', …)` 审计通道（哈希链覆盖）。

### 3.4 前端状态出口：`useSavedFilters` hook（推荐） vs Store 全局化

| | 独立 hook + 页内接线 | 全部塞进 Store |
|---|---|---|
| 耦合 | 各页自持"当前筛选"状态，hook 只做增删改查与链接编解码 | 需要给每个页面字段加 action，Store 膨胀 |
| 改造量 | 每页约 40~80 行接线 | 每页约同量 + Store 30 个新 action |
| 可测 | hook 可单测 | reducer 可单测但页面数据流更难隔离 |

**推荐：独立 `useSavedFilters` hook**（`src/filters/useSavedFilters.ts`），页内"当前条件"由各页已有的 `useState` 持有，保存时把当前条件序列化传给 hook。不引入全局 Store 改造，最小化回归面。

### 3.5 链接形态：`?f=<encoded>` 查询参数（推荐） vs hash 路由

- 现有前端**没有路由**，引入 `react-router` 属于大改，不在两周内做。
- **推荐：查询参数 `?f=<short-id>`（引用已保存筛选）或 `?fc=<base64url(条件JSON)>`（内联未保存条件）**，在 `App.tsx` 或页面入口解析一次，套用后**清除参数**（用 `history.replaceState`），避免每次刷新都重新套用。
- "旧链接兼容"（§4.6）：未来若出现旧形态链接（如 `?page=monitor&filter=<hash>`），解析层做成**策略数组**：先试新格式，再试旧格式，兜底忽略。当前仓库无旧格式样本，需用户提供。

### 3.6 配额实现：服务端强制（推荐） + 前端提示

- 服务端在 INSERT 前 `COUNT(*)` 校验（`owner` + `scope` 口径，§4.4），超限返回 `409 QUOTA_EXCEEDED`。
- 前端保存前本地预检 + 收到 409 时 toast 提示。
- 不依赖数据库约束（SQLite 无部分唯一索引方案可干净表达"每用户 50 个"），靠服务端事务内校验。

---

## 4. 数据 / 接口设计

### 4.1 表结构（新增）

```sql
CREATE TABLE IF NOT EXISTS saved_filters (
  id          TEXT PRIMARY KEY,            -- ULID（有序，可当排序键）
  owner       TEXT NOT NULL,               -- 身份字符串（路线 A）；'*' 表示降级模式全员共享
  name        TEXT NOT NULL,               -- 显示名（≤ 64 字符）
  page        TEXT NOT NULL,               -- 所属页面，如 'monitor' | 'seam' | 'terminal'
  scope       TEXT NOT NULL CHECK (scope IN ('private','team')),  -- 私有/团队共享
  criteria    TEXT NOT NULL,               -- 筛选条件 JSON 字符串（见 4.2）
  created_ts  INTEGER NOT NULL,
  updated_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_filters_owner ON saved_filters(owner);
CREATE INDEX IF NOT EXISTS idx_filters_page  ON saved_filters(page);
```

- 迁移方式：沿用现有模式，在 `initPersistence()` 里追加 `CREATE TABLE IF NOT EXISTS`（与 `promotions` 等一致），**不引入迁移版本号**（与现状对齐；如未来要版本化另行立项）。
- 审计：每次写操作 `appendEvent('FILTER_CREATE'|'FILTER_UPDATE'|'FILTER_DELETE', JSON.stringify({id, owner, scope, ts}))`，进现有哈希链。

### 4.2 筛选条件 JSON 的 Schema（v1）

筛选条件 = 页面 + 该页面可筛选字段的键值集合。通用信封 + 页面自由字段：

```jsonc
{
  "v": 1,                                // schema 版本，未知版本一律拒绝（fail-closed）
  "page": "monitor",
  "conds": {
    "kind": ["ORDER_FILL", "KILLSWITCH_ON"],   // 多选=并集；缺省=不过滤
    "mode": "live",
    "symbol": "ETHUSDT",
    "timeRange": { "hours": 24 }
  }
}
```

- 每个页面维护自己的 `conds` 字段白名单（`src/filters/schema.ts`：`{ [page]: { [field]: validator } }`）。
- 解析规则：**未知字段忽略、非法值拒绝整个筛选（不静默裁剪）**——避免"看似套用了实则有出入"的歧义。
- 大小上限：`criteria` ≤ 8 KB（服务端校验，超限 413）。

### 4.3 REST 接口（沿用 `x-orch-token` + 新增 `X-Evolve-User` 头）

| 方法 | 路径 | 语义 | 鉴权 | 配额校验 |
|---|---|---|---|---|
| GET | `/filters?page=&scope=` | 列出（私有=本人，团队=全员可见） | ✅ | — |
| POST | `/filters` | 创建 `{name, page, scope, criteria}` → `{id}` | ✅ | ✅ COUNT |
| GET | `/filters/:id` | 取单个（校验可见性） | ✅ | — |
| PUT | `/filters/:id` | 更新（仅 owner；可改 name/criteria/scope） | ✅ | 改 scope 时重算 |
| DELETE | `/filters/:id` | 删除（仅 owner；团队筛选删除后他人 404） | ✅ | — |

- 响应错误约定（与现有风格一致）：`401 UNAUTHORIZED`、`403 FORBIDDEN`（非 owner 操作他人私有）、`404 NOT_FOUND`、`409 QUOTA_EXCEEDED`、`413 CRITERIA_TOO_LARGE`、`422 INVALID_CRITERIA`。
- 前端 `src/orch/client.ts` 追加 `listSavedFilters` / `createSavedFilter` / `updateSavedFilter` / `deleteSavedFilter` / `getSavedFilter`，与现有 API 函数同风格。

### 4.4 配额口径（每用户 50 个）

- **推荐：50 = 私有 + 共享 合计**（`COUNT(*) WHERE owner=?`），语义最简单、最不易误解。
- 备选：私私有 50 + 共享 50 分开（需用户确认；共享配额按"创建者"计，团队共享条目不占用他人配额）。
- 删除不软删（物理删除），配额立即释放；被删除的共享链接 404 并在页面上给出 toast。

### 4.5 可见性与权限矩阵

| 操作 | 本人私有 | 本人共享 | 他人共享 | 他人私有 |
|---|---|---|---|---|
| 读 | ✅ | ✅ | ✅ | ❌ 404 |
| 改 | ✅ | ✅ | ❌ 403 | ❌ 403 |
| 删 | ✅ | ✅ | ❌ 403 | ❌ 403 |
| 套用（链接） | ✅ | ✅ | ✅ | ❌（套用前校验可见性，私有链接他人打开→404 提示"该筛选已不存在或无权限"） |

### 4.6 "旧链接"兼容策略

1. 先采集旧链接样本（用户提供）；当前代码库无任何旧格式证据。
2. 解析层做**策略链**：`?f=<id>`（新）→ `?fc=<inline>`（新内联）→ 旧格式（待样本）→ 无匹配则忽略参数。
3. 不破坏现状：`?pet=1` 等现有参数**原样保留**（筛选解析与桌宠判定互不干扰）。
4. 套用后 `history.replaceState` 清除筛选参数：链接只负责"第一次套用"，不负责"状态持续"。

---

## 5. 状态与异常处理

| 场景 | 行为 |
|---|---|
| 创建超配额（409） | 前端 toast「已保存 X/50 个筛选，已达上限」，不关弹窗 |
| 无身份头（路线 B 部署） | 服务端按 `owner='*'` 处理；`scope` 强制 `team` |
| 打开私有筛选链接但无权限 | 404 + toast「筛选不存在或无权访问」（不泄露存在性） |
| 筛选条件 JSON 含未知字段 | 422 拒绝（服务端），前端 schema 校验先行拦截 |
| 保存时页面无任何条件 | 前端禁用保存按钮（空筛选无意义） |
| 网络失败/服务不可达 | 复用现有 `useOrch` 的失败路径与 toast 模式 |
| 筛选被他人删除后本地还开着 | 页面保留当前已套用条件（不自动撤销），仅 toast 提示 |
| 重复保存同名 | 允许（不查重），列表按 `updated_ts` 倒序；同名靠名称展示区分 |

---

## 6. 安全

- 身份载体 `X-Evolve-User` 由部署接入层注入（反代/网关），**前端不签发**；服务端把它当不透明字符串，不解析不信任其内容。
- `criteria` 是**数据而非代码**：服务端 `JSON.parse` + schema 白名单校验，字段名与值类型双检；渲染侧用现有文本/表单控件展示条件（不 `dangerouslySetInnerHTML` 用户输入）。
- 越权矩阵（§4.5）在服务端强制，前端隐藏按钮只是体验不是安全边界。
- 审计：所有变更 `appendEvent` 入哈希链；`/audit/verify` 天然覆盖。
- 现有 `x-orch-token` 鉴权不降级：所有 `/filters*` 都过 `authorized()`。
- 隐私提示：共享筛选名与条件**全员可见**，创建时 UI 明示「团队共享后所有人可见，请勿保存敏感信息」。
- 本仓库为**公开仓库**（`evolve-trading`），代码内不得出现真实密钥/内网地址样本；`.env.example` 保持占位符。

---

## 7. 可观测性

- `server/metrics.ts` 增加计数器：`filters_created` / `filters_updated` / `filters_deleted` / `filters_quota_rejected` / `filters_auth_failed`（挂到现有 `/metrics`）。
- 错误日志沿用现有 `console.error` + `data/app-stack.log` 模式，写入 `filter_criteria_parse_error` 时**只记 page + 错误码，不记条件内容**（避免敏感条件入日志）。
- 链接解析失败（格式不认识）记一条 warning 计数，供"旧链接"采集期观察真实流量形态。

---

## 8. 测试

| 层 | 内容 | 形式 |
|---|---|---|
| 服务端单测 | schema 校验（未知字段/非法值/超限）、配额（49→50✅ 51❌）、权限矩阵全 8 例 | `node:test` 或断言式脚本 |
| 服务端集成 | 建/查/改/删 + 审计链可验（`/audit/verify` 不断链） | 沿用 `scripts/*-smoke.ts` 惯例 |
| 前端 hook | `useSavedFilters`：编解码往返、错误映射、409 处理 | vitest（若无则先建最小 runner，或并入现有 node 脚本测纯函数编解码） |
| 链接解析 | `?f=`/`?fc=`/旧格式/无参/`?pet=1` 共存 5 例 | 纯函数测试 |
| 门禁接入 | `npm run test:filters` 并入 `ci` 链（lint 与 build 之间） | `package.json` 脚本 |

**验证基线**：推送前已实测 `tsc`/`lint`/`build` 全绿；本功能合入后需再跑 `npm run ci` 全链 + 人工过一遍 Monitor/Seam/Terminal 三页的保存→套用→链接往返。

---

## 9. 发布与回滚

### 9.1 发布（两周节奏）

- **第 1 周（方案确认 + 骨架）**：确认 §10 三前提 → 表 + 接口 + 校验 + smoke（服务端可独立验收）。
- **第 2 周（前端 + 联调）**：`useSavedFilters` + 链接解析 + 三页接线 + 门禁全绿 → 提交并推送（沿用本次 `evolve-trading` 仓库，`main` 分支直推 + CI 把关）。
- 部署方式与现有编排一致（`npm run stack` / `npm run orch`），**不引入新部署设施**。

### 9.2 回滚

- **代码**：git revert 该功能 commit（前端 + 服务端同仓同 commit，天然原子）。
- **数据**：`saved_filters` 表为纯新增，**回滚不删表**（保留数据，代码回退后新字段无人读写，无兼容风险）；如确需清场，提供 `DELETE FROM saved_filters` 一次性脚本（不进 CI）。
- **链接**：回滚后 `?f=` 参数被解析层忽略（策略链兜底），不产生错误页。

---

## 10. 未验证假设与需原型验证的风险

| # | 假设/风险 | 当前证据 | 验证方式 | 若证伪 |
|---|---|---|---|---|
| 1 | **PostgreSQL 非硬约束** | 代码全为 SQLite，需求文本写 PostgreSQL | 用户确认 | 两周内只能做"数据层设计 + 迁移计划"，功能交付推迟或改路线 B |
| 2 | **身份来源可配置** | 系统无用户模型 | 确认接入层（反代/前端登录）能否注入 `X-Evolve-User` | 退化为路线 B：仅团队共享，无私有/配额 |
| 3 | **"旧链接"存在且可采到样本** | 代码中无任何旧格式 | 用户提供 2~3 个真实旧链接样本 | 仅支持新格式；策略链保留扩展位 |
| 4 | **单写者部署假设成立** | `claimInstance`/`heartbeatInstance` 存在；`busy_timeout=5000` | 部署拓扑确认（几人同时用？多实例？） | 多实例并发写 SQLite 需改 WAL 多写或加锁，风险升级 |
| 5 | **页内筛选状态可收敛** | 各页筛选是即时 `.filter()`，无统一出口 | 原型验证 1 个页面（Monitor）接线成本 | 若页面状态分散超预期，改用 Store 收敛（§3.4 备选），工期 +2 天 |
| 6 | **50 配额口径（合计 vs 分开）** | 无现有配额先例 | 用户确认 | 仅改服务端 COUNT 口径，前端文案联动 |

**原型验证建议（第 1 周前三天）**：在 Monitor 页做端到端最小闭环（保存→列表→套用→链接→他人视角），重点验证 #5 与 #2 的可行性，再全量铺开。

---

## 11. 交付物清单

1. `server/savedFilters.ts`（或并入 `persistence.ts`）：表初始化 + CRUD + 配额/权限/校验。
2. `server/index.ts`：5 个 `/filters*` 路由分支（照现有风格）。
3. `src/filters/schema.ts`：页面字段白名单与校验器。
4. `src/filters/link.ts`：链接编解码（`?f=` / `?fc=` / 旧格式策略链）。
5. `src/filters/useSavedFilters.ts`：前端数据层 hook。
6. `src/orch/client.ts`：5 个 API 函数。
7. 页面接线：Monitor / Seam / Terminal 三页（保存按钮 + 筛选抽屉 + 链接分享）。
8. `scripts/filter-smoke.ts` + `package.json` 脚本 + CI 挂载。
9. `docs/FILTERS-SCHEMA.md`：条件 JSON 的字段字典（随功能迭代）。

---

*本方案为草案，§10 三前提确认后冻结为 v1.1。*
