# EVOLVE 自进化量化交易系统 · 技术开发提示词套件（可复用）

> **文档定位**：把 `evolve-app` 这个「自进化量化交易系统」的全部技术决策、架构契约、踩坑记录，**压缩成可直接喂给 AI 复现项目的提示词**。
> **适用对象**：需要在新仓库 / 新会话中重建同类系统的开发者或 AI Agent。
> **源项目**：`C:\Users\noah\WorkBuddy\2026-08-18-10-08-22\evolve-app`
> **版本**：**v3 · 2026-09-12**（v2 为同日早些时候；v1 为 2026-08-30，仅覆盖前端四层）
> **v3 相对 v2 的核心变化**：
> 1. 执行了 v2 Part J3 列出的**文档收敛方案**——把 `PROMPT_ENGINEERING` / `SYSTEM_PROMPT` /
>    `PROD_PROMPT_KIT` / `PHASE_C_ARCHITECTURE` / `LLM-AGENT-TEAM` 五份的重叠精华并入本文与
>    `PROMPT-KIT-METHOD.md` 后删除，仓库文档从 **9 份收敛到 5 份**（见 Part J）。
> 2. 新增 **Part K**（LLM 智能体团队）、**Part L**（R20 对标内化）、**Part M**（生产级交付与充值实测）。
> 3. 内化了开源项目 R20 Quantum Trader 的 5 项能力，新增 **5 个 server 模块 / 14 个 API / 11 种事件**。
> 4. 门禁总数 16 → **18**（新增 `test:r20` 与 `test:risk-guard`）；lint 已清零。
> **v4 追加（2026-09-16，只增补不重写）**：
> 1. 新增 **L6.11 实时语音交互层**（`/voice`，11 → 12 场景）与
>    **L6.12 悬浮桌宠（桌面外壳层）**（**0 条新业务 API**，71 断言）。
> 2. **Part I 逐道实跑复核**：把 I1 表里一批过时数字按实跑输出改正
>    （`test:gateway` 8→9、`test:voice` 11→12、`test:autopilot` 6→9；
>    `recon` / `mirror` / `proposal-slo` / `surveillance` / `llm-provider` 从"—"补成实跑值）。
>    门禁总数 18 → 25（语音层）→ **26**（桌宠层）。
> 3. 新增三条**环境级**坑位（L6.12.3）：`ELECTRON_RUN_AS_NODE` 全局变量、
>    GPU 进程不可用即 FATAL 退出、**`child.on('exit')` 对 Electron 子进程不触发**。
> 4. 新增 **L6.12.5**：一条 UI 层的坑 —— **P0 报警的标签行不能沿用通用弱色**。
>    判据是"半透明底上的文字必须按**与最亮可能底色合成**算对比度"，
>    由 `test:pet` 的 **P11** 两条断言钉住（`test:pet` 71 断言 / 11 组）。
> **v5 追加（2026-09-16 第五轮，只增补不重写）**：
> 1. 新增 **L6.13 桌宠 ↔ 语音管家合并**（单页双布局 + 唯一会话内核 + 旧页重定向桩）与
>    **L6.14 密钥权限范围自检**（`server/keyScope.ts`，内化日报第③条；**0 条新 API**）。
> 2. 门禁总数 26 → **27**（+`test:keyscope`，21 断言）；`test:pet` 71 → **79 断言 / 12 组**（+P12 组）。
>    `npm run keys:audit` 是**联网探测**，**刻意不进 CI**（见 L6.14.4）。
> 3. 新增一条**最容易误判的坑**（L6.13.4）：**`tsc` 绿 + lint 绿 + 单测全绿，`vite build` 红** ——
>    `../store/Store.ts` 与 `../store/Store.tsx` 只差一个字母，`tsc` **不报**、打包器直接 `Build failed`。
>    ⇒ **中途只跑 typecheck + lint + 单测不能替代 `npm run build`**。
> 4. 新增一条**写门禁的坑**（L6.13.3）：源码扫描类门禁会把**函数定义行**当成调用点
>    （`export function postUtterance(` 也匹配 `/postUtterance\(/`），必须先剔除定义再看调用。
> 5. 新增三条**本机环境坑**（L6.13.4）：嵌套模板串在 Node 类型擦除下报 `ERR_INVALID_TYPESCRIPT_SYNTAX`；
>    `react-hooks/refs` 会让"返回对象里带 ref"的整个 hook 被判渲染期读 ref；
>    `react-hooks/immutability` 禁止改 `useState` 返回的实例。
> **v6 追加（2026-09-17 第六轮，只增补不重写）**：
> 1. 新增 **L6.15 拟人音色与出声链路**：零密钥神经 TTS + 双引擎降级 + **唯一音色目录**（14 档 = 云端 7 + 本机 7）。
> 2. 门禁总数**不变**（**27 道**），但断言数上升：`test:voice` 12 → **13 场景**（+S13 出声链路，8 组，**全离线**）；
>    `test:pet` 79 → **89 断言 / 13 组**（+P13 头像组）。端点 **84 → 86**（**不是新通道，是换嗓子**）。
> 3. 新增一条**判据级**补充（L6.15.10）：**判据要成对问** —— 不只问"会不会漏报"，
>    还要问**"它会不会对正确的输入报错"**。本轮同时抓到两例：① 只数总量的断言（总量守恒 ⇒ 永不红）；
>    ② 一个文档表格校验器把转义竖线 `\|` 当分隔符，在**完全正确**的文档上报出 4 处错。
>    ⇒ **先修检查器，再相信它的红**；否则你会被训练成忽略它。
> 4. 新增一条**环境事实**：`safe-delete` 报 `SAFE_DELETE_FAIL_CLOSED` **可能是假阴性** ——
>    文件其实已经进了回收站。⇒ **处置动作的返回码不是结果，重新观测一次才是。**
>    同源：注入的当前时间可能过期，判"今天做了什么"要看文件 mtime（本轮据此把日期从 09-16 更正为 09-17）。
> **v7 追加（2026-09-17 第七轮，只增补不重写）**：
> 1. 新增 **L6.16 任务层：先裁定，再执行** —— 一句自然语言目标先被**用系统自己的尺子**量一遍
>    （1R / 熔断 / 止损几何 / 成本地板 / 目标硬界 / 过拟合门），再决定放不放行。内化 AgentGit 四处：
>    内容寻址 id / 边缘脱敏 / 一任务一执行线 / 仅追加前缀。门禁 **27 → 28**（+`test:mission`，现 16 组），
>    端点 **86 → 89**，新增 `start_mission` 意图（**在 DANGEROUS 里，但语音只裁定不启动**）。
> 2. 新增一条**P0 类型**，与"不可能失败的检查"同族但**失效方向相反**：
>    **「不可能被命中的状态」** —— 任务层第一版里 `unverifiable` 是死代码
>    （"缺槽位"被记成 `block`，于是判定永远落在 `infeasible`）。
>    类型里有这个取值、文档写着这段说明、接口一切正常，**没有任何东西会报红**。
>    ⇒ 修法是让档位成为**结构**（新增 `hold`："我不知道" ≠ "它不行"），
>    并用破坏验证钉住（改回 `block` ⇒ 断言精确报红）。
> **v8 追加（2026-09-17 第八轮，只增补不重写）**：
> 1. 新增 **L6.17 启动口令与双击启动** —— 口令 = 固定词 + 服务端一次性四位码，只对"可做"的裁定签发；
>    `START-EVOLVE.cmd` / `STOP-EVOLVE.cmd` 把七个进程的手工编排变成一次双击。
>    门禁总数**不变（28 道）**，断言数上升：`test:mission` 13 → **16 组**、`test:mirror` 2 → **3 场景**。
> 2. 新增一条**P0 类型**（与 v7 那条同族、**方向再反一次**）：**「站错位置的门」**。
>    过拟合门曾被标成启动门，于是 `门拦启动 → 永不累积证据 → 门永无结论 → feasible 永不出现`，
>    形成一个**用真实数据跑就永远走不到的分支**。
>    ⇒ 通用提问：**"这个状态/分支在这个系统上真的可能发生吗？能用真实数据构造出来吗？"**
> 3. 新增一条**判据级**补充：**「每一条拒绝配一条放行」** ——
>    一个把任何输入都拒掉的实现能通过全部拒绝断言。
> 4. 新增**三件"只有真的跑起来才会露出来"的缺陷**（全部由"启动并预览"这一步抓到）：
>    ① `GET /events` 是 `ORDER BY seq ASC LIMIT 500` 且从不传 `since` ⇒ **永远返回最旧的 500 条**，
>    条数一直是满的、没有截断提示（账本已到 seq 32384，端点仍返回 seq 1..500）；
>    ② 播报文案里混进 markdown 星号（屏幕上是星号、念出来是多余停顿）与叠标点 `。；`/`。。`；
>    ③ 4xx 业务拒绝被当成连通故障显示（"服务没回应，去查端口"）。
>    ⇒ 一条共同的判据：**"这个输出会把用户/下游引向哪个动作？那个动作有用吗？"**
> 5. 新增一条**环境事实**：`safe-delete` 有批量删除护栏（阈值 50，`scope:"turn"`）。
>    删一个大目录（第八轮删 Chrome profile 清掉 3196 个文件）会让随后的删除动作被拦，
>    表现为**一个不相关的门禁突然崩掉**。
>    ⚠️ **第九轮更正**：第八轮把这条记成"按轮计、下一轮重置"，**那是错的**。
>    第九轮读护栏源码 + 读它自己的 `state.json` 后确认：**桶按「会话」计，不按"一条用户消息"计**
>    （证据是一个算术：某桶 count=3266，而新一轮开局第一条删除就报 3235 = 3196 + 39）。
>    ⇒ 一次批量删除会把**整个会话**的预算用光。更可靠的规矩不是"分轮"，而是
>    **门禁不要依赖删除**，以及**想跑 CI 就前台跑**（后台调用拿不到放行 ⇒ `build` 必红）；
>    双击启动不受影响（护栏只在 agent 工具调用环境里生效）。详见 L6.18.5 与 `DEV_PROGRESS §3.20.8`。
> 6. 记录一次**我自己犯的假绿**：写了一条"口令明文没落账 ✓ 没有"的检查，
>    而它扫的正是上面那个陈旧窗口 —— 结论对、**证据无效**。用 `since=32000` 重扫尾部才算验过。
> 7. 新增一条**判据级**补充：**缺证据的结论必须只针对真的缺**。
>    `parseGoal('做到100U')` 曾把 100 判成本金，于是回话里出现**"你没说目标金额"这句假话**
>    （用户明明说了）⇒ 断言要成对写：**说过的槽位不许被报成没说**。
> 8. 新增一条**夹具级**教训（第七轮第一次跑就栽在这里）：**"换个说法"必须是逐条同义的换说法。**
>    少一个从句就是另一件事，id 理应不同 —— 夹具写错会让断言变成**反向**证据。
>    ⇒ 边界要成对断言（同义必同 id / 少一个从句必换 id / 环境变必换 id）。
> **v9 追加（2026-09-17 第九轮，只增补不重写）**：
> 1. 新增 **L6.18 进程监督取证：退出状态本身不带信息** —— 本机实测「自己 `exit(1)`」
>    「被 `taskkill /T /F`」「未捕获异常」三种事因，父进程拿到的 `(code, signal)` **逐字节相同**
>    （`1, null`）。⇒ 交付**子进程遗言机制**（`crashLog`：先同步落盘再打印）+ **监督侧取证报告**
>    + **三态定性**（缺 `armed` 证据一律「无法判定」）。门禁 **28 → 29**（+`test:stack` 6 组）。
> 2. 新增一条**判据级**提问：**「我准备记下来的这几个观测量，能不能唯一确定原因？」**
>    答不上来就不是取证，只是打印。第八轮那句"给 `onUnexpectedExit` 加落盘（记退出码）"
>    方向对、**但记的是个常量**（§3.20.1）。
> 3. 新增一条**门禁可靠性**规矩：**不要让门禁依赖"能删文件"**。
>    `rmSync` 在删除配额满时会抛，于是"准备夹具"这一步能把整道门禁打红 ——
>    而它守的不变量一点问题都没有。这是"对完全正确的输入报错"，会训练人忽略这道门的红。
>    ⇒ 把"干净"交给**命名**（文件名带 pid + 时间戳 ⇒ 天然是新文件），删除只作尽力而为的收尾。
> 4. 新增**两条环境事实**：① 日志时间戳若用 `toISOString()`，会把现场**指错 8 小时**
>    （本机 GMT+8），判"这是多久以前"时会直接算错；② 事故**第二次复现**且 Windows
>    事件日志/WER 里**无任何记录** ⇒ 它不是原生崩溃（这类会留 WER）—— 排除一整类假设，
>    但排不出"崩溃 vs 被杀"，这正是必须靠遗言的原因。
> **v10 追加（2026-09-17 第十轮，只增补不重写）**：
> 1. 新增 **L6.19 答非所问：用户的意图被静默换成了一个数字** ——
>    用户问「在 OKX 测试网做 BTC 永续，3 天内翻倍」，系统回了一句 **BTC 现价**。
>    三处独立失效叠加：裸倍数（"翻倍"=2 倍）不被识别 ⇒ 判成"没有目标" ⇒
>    `looksLikeMission` 判 false ⇒ 意图层兜底"认出标的就当问行情"。
>    门禁总数**不变（29 道）**，断言数上升：`test:voice` 13→**14 场景**、
>    `test:mission` 16→**17 组**、`test:pet` 89→**91 断言**。
> 2. 新增一条**P0 类型**（继"不可能失败的检查"、"不可能命中的状态"之后的**第三族**）：
>    **「没读懂被伪装成读懂了」**。前两族的特征是"某个东西不会发生"；
>    这一族的特征是**答案看起来完全正确**（那句报价是真价），
>    用户没有任何线索判断自己的话被丢了。
>    ⇒ 通用提问：**"如果系统完全没读懂这句话，输出会长什么样？和我现在看到的能区分吗？"**
> 3. 新增一条**判据级**提问（对"变异测试"的补充）：
>    **「这条断言依赖的这个修复，是不是别的修复顺带也能让它变绿？」**
>    实测：拿"用户原话"验证"意图层接上了新判据" ⇒ 那句话在另一处修复后本来就绿，
>    撤掉接线断言照样全绿 ⇒ **假绿**。判据要选**只有该修复才救得活**的输入。
> 4. 新增一条**判据级**补充：**判据只写一份。**
>    "这句话是不是任务"必须只存在于 `goal.ts` 的 `hasExecutionSignal`，
>    意图层与兜底**共用同一个函数** —— 在兜底再写一份正则，两份分歧的方向恰好是
>    "任务被换成报价"（也就是这个判据要防的事）。
> 5. 新增一条**假绿方向**：**合法值被写进坏值列表。**
>    坏值列表里原本有 `'xl'`（当时非法，断言"会回落默认"）；加了 `xl` 档之后它变成合法值，
>    于是"用户点了特大号没反应"这个缺陷**永远测不出来**（断言本来就期望回落）。
>    ⇒ 加新档位/新枚举时必须**逐项复查坏值列表**；坏值首选"拼写相近但不合法"的形态（`'xxl'`）。
> 6. 新增一条**判据级**补充：**派生值不能当独立证据。**
>    `parseGoal` 里「说了币安」会让 `execution` 派生成 `testnet` —— 它不是第二个信号。
>    把它算进去的后果是「看看币安」凑够两个信号、被判成执行诉求，
>    于是系统反过来追问"你的本金是多少"：**同一个答非所问的镜像**（用户只是提了个场所）。
> 5. 更正一处**上一轮的错归因**：第八轮把 `build` 的一次红记成"`dist` 句柄与 `vite preview` 冲突"。
>    第九轮同一条 CI 链里 `test:mirror` / `test:stack` / `build` 三道同时红，前两道的报错文本
>    明确指向**同一个删除配额**。⇒ 没有证据之前不要给偶发失败写原因（哪怕它"听起来很合理"）。
> **配套母版**：`PROMPT-KIT-METHOD.md` —— 本文是 EVOLVE 的**实例**；想对别的项目产出同款套件，看母版的通用流程与空模板。
> **对标报告**：`R20-BENCHMARK.md` —— 外部项目对标与内化依据（含 17 个 R20 源文件的精读结论）。
> **本轮核验方式**：逐文件复读 `src/**` 与 `server/**`，并对 `npm run lint` / `npm run typecheck` /
> `npm run build` / 两套烟测做了实测。本文所有阈值、地址、端口、行数均为**实测值**，非推测。

---

## 使用说明（四档用法）

| 用法 | 场景 | 怎么做 |
|---|---|---|
| **A. 全量复现** | 从零重建整个项目（前端 + 服务端） | 复制 **Part A 主提示词**，一次性投喂给 AI |
| **B. 分层复现** | 只重建某一层（如只做 DEX 执行层） | 复制 **Part C**（前端 L0–L5）或 **Part H**（服务端 L6）中对应层的提示词，配合 Part D 契约 |
| **C. 二次开发** | 在现有项目上加功能 | 阅读 **Part B 架构** + **Part F 避坑清单**，避免踩已填过的坑 |
| **D. 验收/接盘** | 判断"能不能上线""谁说的算数" | 读 **Part I 验证层** + **Part J 文档治理地图**，先跑门禁再信文档 |

> ⚠️ **前置约定**：本文档中所有「金额/精度/地址/阈值/端口」均为生产实测值，**不要凭直觉改写**。特别是 `parseUnits` 的 decimals、合约地址、fitness 公式、端口来源——历史上这些地方出过严重 bug。
>
> ⚠️ **最重要的一条使用纪律**：**代码 > 文档**。任何结论都必须回到源码与 `npm run` 实测去验证，发现文档与代码冲突时**以代码为准并更新文档**。
> v3 已完成一轮文档收敛，同一事实现在**只允许有一个权威出处**（见 Part J 的新地图）。

---

# Part A · 一键复现主提示词（Master Prompt）

> 以下整段可直接复制投喂给 AI。

```text
你要从零构建一个名为 EVOLVE 的「自进化量化交易系统」。它由两部分组成：
（1）浏览器控制面 —— 深色 Bloomberg 终端风格的单页应用，只读订阅 + 审批操作；
（2）独立编排服务 —— Node 进程，持有全部风控、账本、撮合、晋升门禁与交易所出站通道。
关键架构决定：**控制面永不直接下单、永不持有交易所密钥**，一切资金操作必须经过编排服务的风控闸与晋升闸。

## 技术栈（版本锁定，不要升级大版本）
- React 18.3 + TypeScript 5.5（strict）+ Vite 8.2（注意：不是 Vite 5，rolldown 内核）
- 状态管理：React Context + useReducer（不要引入 Redux/Zustand）
- 链交互：wagmi 3.7 + viem 2.55
- 数据请求：@tanstack/react-query 5
- 样式：原生 CSS + CSS 变量设计令牌（不要引入 Tailwind / UI 组件库）
- 服务端：Node 原生 http + ws + node:sqlite（WAL），零 Web 框架（不引入 Express/Fastify）

## 前端四层（按此顺序实现，逐层验收）
第1层 真实行情：Binance 公开 API（REST 快照 + WebSocket miniTicker + K线），免密钥，失败自动降级模拟引擎。
第2层 多链钱包：wagmi + injected() 连接器，支持 Ethereum/Base/Arbitrum/Optimism/Polygon/BNB 六链，EIP-6963 多钱包发现。
第3层 DEX 执行层：Uniswap V3 链上报价（QuoterV2）+ 交易构造（SwapRouter02），三档费率并行询价取最优，含 ERC20 授权与滑点保护。
第4层 进化层：6 个策略族 × 参数网格 = 20 候选 + 适应度函数 + Walk-Forward 稳健性校验 + 晋升流水线状态机 + 隔离沙箱变异评估。

## 服务端编排层（L6，与前端同等重要）
第6层 编排服务：默认拒绝的下单前风控 → 晋升门禁（live 意图必须携带已授权策略身份 + 资金帽）→ execution-gateway（
握手门/幂等/回报去重/出站闸/撤单风暴）→ VenueAdapter（沙盒 / CEX testnet）。
配套：追加写事件账本 + SHA-256 审计哈希链（可定位篡改断点）、SQLite WAL 持久化、90 天保留归档、
真实 SLO 度量（ACK 分位/拒绝归因/行情新鲜度）、市场操纵自监控、Autopilot 自治状态机、LLM 提案器（只提案不下单）。

## 硬性安全红线（不可协商）
1. 三档交易模式 SIM / PAPER / LIVE，只有 LIVE 模式才允许发起链上签名交易。
2. LIVE 模式禁止跨会话静默恢复——每次启动必须降级为 PAPER，需用户二次确认。
3. 所有"执行"按钮在非 LIVE 模式必须显式锁定并提示原因。
4. 提供"模拟执行"（eth_call / simulateContract）通道，让用户在零资金风险下验证交易。
5. 模拟引擎产生的数字必须在 UI 上明确标注为虚拟资金，不得与真实余额混排。
6. 风控默认拒绝：任何一次下单前检查失败即拒单，不允许"放行后再补校验"。
7. killswitch 必须同步冻结三处：本地撤全单 + venue 撤单风暴 + gateway 出站闸，缺一不可。
8. 给 LLM 的任何能力都不得包含直接下单通路（结构性隔离，永不因功能需求松动）。

## 交付要求
- 每个模块都要有清晰的中文注释说明"为什么这么做"。
- 所有外部依赖（RPC、行情源、交易所）必须配置 fallback，失败时优雅降级而非白屏。
- 前端构建必须通过 `tsc && vite build`（strict 模式零错误）；服务端必须通过 `npx tsc --noEmit`。
- 必须提供 `npm run ci` 一键门禁（lint + typecheck + 全部 smoke + 黄金回归 + build + audit）。

## 工程纪律（合并自原 SYSTEM_PROMPT.md，违反即回滚，无例外）
1. **诚实性**：不确定就说不确定，不编造数字。实测值与推测值必须区分标注。
   做不到的事要说"做不到"，而不是给一个看起来能跑的实现。
2. **可复现性与审计**：任何影响资金或策略行为的改动都要落事件流。
   配置类文件必须原子写盘（临时文件 + fsync + rename），禁止裸 writeFileSync。
3. **代码 > 文档**：文档与代码冲突时以代码为准，并**当场更新文档**，
   不允许只记录冲突而放着不改——那是把漂移留给下一个人。
4. **默认拒绝**：所有风控开关默认关闭、所有实盘开关默认关闭。
   任何"默认开着"的危险能力都是缺陷（本项目 F-15 即此例）。
5. **禁止静默失败**：可选的旁路能力（缓存、遥测、镜像）失败时可以静默降级；
   但**风控、账本、预留、拦截**四条路径的任何异常都必须留痕。
   静默失败比越界更危险——它让你以为自己还在风控之内。
6. **不猜、不冒充**：无法解析的结构诚实记空，不要用一个看似合理的默认值填上。
   把未知标成已知是风控里最危险的操作。
7. **结论必须可核对**：说"已完成"之前先看实测输出；
   说"已修复"之前先看那道断言现在过不过。
```

---

# Part B · 架构梳理

## B1 · 定位与能力边界

EVOLVE 是一个**全栈**自进化量化交易系统（浏览器控制面 + 独立编排服务）。它的核心价值不在于"真的赚钱"，而在于**完整展示一个自进化交易系统的闭环，并且把每一环的安全闸门都真正实现出来**：

```
真实行情 → 策略进化 → 回测验证 → 晋升门控 → 纸交易观察 → 受控实盘
                                    ↑
                    risk(default-deny) → promotion gate → gateway → venue
```

**已实现（真实能力）**：
- ✅ 真实 Binance 行情（REST + WebSocket，免 API Key；秒级 miniTicker 驱动权益曲线）
- ✅ 真实多链钱包连接与余额读取
- ✅ 真实 Uniswap V3 链上报价（eth_call，只读，零风险）
- ✅ 真实链上交易签名（LIVE 模式下，SwapRouter02）
- ✅ 确定性回测引擎 + 适应度函数（fitness-v2）+ Walk-Forward 校验 + 组合净化
- ✅ 晋升流水线状态机（candidate → full_live 全链路门控，可持久化恢复、可回滚）
- ✅ **编排服务在本仓库内**（`server/`，35 个文件 / 8873 行）：
  默认拒绝风控、execution-gateway、VenueAdapter 多场所、SQLite WAL 账本、
  SHA-256 审计哈希链、SLO 真实度量、操纵自监控、Autopilot 自治循环、LLM 提案器、进程级变异沙箱
- ✅ 28 道 CI 门禁（`npm run ci`；清单与实跑断言数以 **Part I** 为唯一出处）

**未实现 / 边界（不要对 AI 或用户夸大）**：
- ⚠️ 进化层的"变异"是**参数网格搜索**，不是真正的基因编码变异
- ⚠️ LLM 提案器**只提案不下单**（结构性隔离）。它接入的是 `proposalEngine`，产出结构化提案后必须走门禁；
  **不存在** "LLM 直接决定并执行交易" 的通路，这是刻意设计而非未完成
- ⚠️ BNB Chain 已接入钱包层，但**未配置 Uniswap V3 路由**，DEX 面板会提示不支持
- ⚠️ **HFT/高频永远不在本仓库范围**（`DEV_PROGRESS.md` 冻结 HFT 为独立项目）：
  本仓库执行路径为 React 主线程 + JSON WebSocket + 钱包弹窗，物理上到不了亚毫秒。
  对外文案**禁止使用"高频"**表述，除非另立项目达标
- ⚠️ 账本仍是**同进程 SQLite**（未拆独立服务），`server/ledgerServer.ts` 是拆分的第一步
- ⚠️ 当前仅单账户内部运行（paper/sandbox），**未对任何外部客户提供服务**；合规项 C8 ❌ 未启动

## B2 · 架构总览（六层）

```
┌────────────────────────────────────────────────────────────────────┐
│                 控制面 UI (React + CSS 令牌) · 只读+审批            │
│  Overview │ 决策大脑 │ Terminal │ Agents │ Evo │ Protocol │ Monitor │ Settings │
└────────────────────────────────────────────────────────────────────┘
        ▲                                 ▲
        │ 轮询 /state /events /metrics     │ wagmi 签名（仅 LIVE）
        │                                 ▼
┌───────┴────────┐                ┌──────────────────────┐
│ L1 行情层       │                │ L2 钱包层             │
│ data/market.ts │                │ wallet/config.ts     │
│ REST+WS+K线     │                │ 6 链 + EIP-6963      │
└───────┬────────┘                └──────────┬───────────┘
        │                                     │
        │        ┌────────────────────────────┴──────────────┐
        │        │ L3 DEX 层 dex/uniswap.ts                  │
        │        │ QuoterV2 三档询价 + Router02 + 授权/滑点    │
        │        └───────────────────────────────────────────┘
        │
┌───────┴─────────────────────────────────────────────────────────────┐
│ L6 编排服务 server/  ★ 前端不直接持有此能力                          │
│                                                                     │
│  index.ts      路由 + x-orch-token 鉴权 + CORS + 生产 fail-closed    │
│     ↓                                                               │
│  risk.ts       下单前风控（默认拒绝）                                │
│     ↓                                                               │
│  pipelineService.ts  晋升门禁（live 须带策略身份 + 资金帽）           │
│     ↓                                                               │
│  gateway/executor.ts 握手门/幂等/回报去重/出站闸/撤单风暴            │
│     ↓                                                               │
│  venue/        sandbox │ cex-testnet │ okx-testnet (VenueAdapter)   │
│                                                                     │
│  横切：ledger+audit(哈希链) · persistence(SQLite WAL) · metrics/SLO  │
│        surveillance(操纵监控) · reconciliation/mirrorCheck(对账)     │
│        feed(WS行情) · retention(90天归档) · sandbox(进程隔离)        │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ 复用同一份纯函数内核
┌──────────────────────────┴──────────────────────────────────────────┐
│ L4 进化引擎 src/engine/（纯 TS，零 UI 依赖，前端与后端共用）          │
│  strategies(6族/20候选) · fitness-v2 · walkforward · promotion-v1    │
│  backtest · matching · broker · report · history · rng · indicators  │
└─────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ L5 Store (Context + useReducer) · sim/paper/live 模式机 + 持久化偏好  │
└─────────────────────────────────────────────────────────────────────┘
```

> **设计要点**：L4 引擎是**前后端共用的纯函数内核**——前端用于进化实验室的即时预览，
> 后端用于 Autopilot 的实盘选优。这保证了"界面上算出来的"和"实际执行的"是同一套逻辑，
> 不会出现两套实现漂移（这正是 v1 文档里 F-1 踩的坑的根因）。

## B3 · 技术栈与版本

| 类别 | 选型 | 版本 | 说明 |
|---|---|---|---|
| 框架 | React | ^18.3.1 | 不用 19（wagmi 3 生态兼容性） |
| 语言 | TypeScript | ^5.5.3 | **strict: true**，`noEmit` |
| 构建 | Vite | **^8.2.2** | ⚠️ 不是 Vite 5！已是 rolldown 内核，行为与 v5 有差异（见 F-13） |
| 链交互 | wagmi | ^3.7.6 | 注意 v3 与 v2 API 差异较大 |
| 链工具 | viem | ^2.55.18 | `parseUnits` / `formatUnits` / `encodeFunctionData` |
| 数据请求 | @tanstack/react-query | ^5.101.4 | 替代 wagmi `useReadContract` 做并行询价 |
| HTTP 客户端 | undici | ^6.28.0 | 服务端出站请求（交易所 HMAC、LLM 调用） |
| WebSocket | ws | ^8.21.3 | 服务端行情订阅 + 前端事件推送 |
| 代码检查 | eslint | ^10.9.0 | + typescript-eslint 8 + eslint-plugin-react-hooks 7 |
| 服务端存储 | `node:sqlite` | Node 内置 | WAL 模式，**零外部数据库依赖** |

> **服务端刻意不引入 Web 框架**：`server/index.ts` 用 `node:http` 手写路由（1139 行）。
> 这不是偷懒——编排服务的路由面很小（约 60 个端点），手写换来的是**零依赖、可审计、启动快**。

**package.json scripts（实测，2026-09-12）**：

```json
{
  "dev": "vite",
  "build": "tsc && vite build",
  "preview": "vite preview",
  "lint": "eslint src scripts server",
  "typecheck": "tsc --noEmit",
  "audit:sec": "npm audit --audit-level=high --registry=https://registry.npmjs.org",

  "orch": "node server/index.ts",
  "ledger": "node server/ledgerServer.ts",
  "stack": "node server/devStack.ts",

  "backtest:golden": "node scripts/golden-backtest.ts",
  "data:fetch": "node scripts/fetch-history.ts",

  "test:orch": "node scripts/orch-smoke.ts",
  "test:gateway": "node scripts/gateway-drill.ts",
  "test:promotion": "node scripts/promotion-smoke.ts",
  "test:recon": "node scripts/recon-smoke.ts",
  "test:mirror": "node scripts/mirror-smoke.ts",
  "test:proposal-slo": "node scripts/proposal-slo-smoke.ts",
  "test:surveillance": "node scripts/surveillance-smoke.ts",
  "test:sandbox": "node scripts/sandbox-smoke.ts",
  "test:autopilot": "node scripts/autopilot-smoke.ts",
  "test:llm-provider": "node scripts/llm-provider-smoke.ts",
  "test:commercial": "node scripts/commercial-smoke.ts",

  "ci": "npm run lint && npm run typecheck && … 共 28 道，详见 Part I"
}
```

> ⚠️ **Node 版本要求**：服务端用了 `node:sqlite` 与 Node Permission Model，**必须 Node ≥ 22**。
> 本机实测用 `C:/Program Files/nodejs/node.exe`（v25.x）与托管版 22.22.2 均可。

## B4 · 目录结构

```
evolve-app/
├── index.html                  # 中文 lang=zh-CN，Inter + JetBrains Mono
├── vite.config.ts              # 仅 react 插件 + server.host
├── tsconfig.json               # strict, noEmit, moduleResolution: bundler
├── eslint.config.js            # eslint 10 flat config
├── .env.example                # ★ 环境变量与密钥治理样例（勿提交真实密钥）
├── quote-check.cjs             # 主网询价冒烟（CI continue-on-error）
├── .github/workflows/ci.yml    # ⚠️ 仅 5 道门禁，与本地 npm run ci（27 道，见 Part I）不一致
├── data/history/*.json         # ETHUSDT/BTCUSDT 15m×30d（hist-v1，contentHash 锁定）
├── artifacts/                  # 黄金报告、行为基线、drill-latest.json 演练记录
│
├── src/                        # ── 前端控制面 ──
│   ├── main.tsx                # 挂载，外层包裹 WalletProvider
│   ├── App.tsx                 # 8 个页面路由 + 行情心跳
│   ├── store/Store.tsx         # ★ L5 全局状态机（sim/paper/live + 偏好持久化）
│   ├── data/market.ts          # ★ L1 行情：REST + WebSocket + K线
│   ├── wallet/
│   │   ├── config.ts           # ★ L2 wagmi 多链配置
│   │   └── WalletProvider.tsx  # QueryClient + WagmiProvider 嵌套
│   ├── dex/uniswap.ts          # ★ L3 合约地址单一来源 + ABI + 类型守卫
│   ├── engine/                 # ★ L4 确定性回测与进化内核（前后端共用纯函数）
│   │   ├── index.ts            #   统一导出
│   │   ├── types.ts            #   Candle / Order / ExecConfig
│   │   ├── rng.ts              #   mulberry32 确定性随机
│   │   ├── data.ts             #   genSynthCandles 合成数据（可复现）
│   │   ├── indicators.ts       #   sma / ema / rsi / stddev / macd
│   │   ├── matching.ts         #   撮合引擎（限价单/市价单）
│   │   ├── backtest.ts         #   回测主循环
│   │   ├── report.ts           #   绩效指标计算
│   │   ├── fitness.ts          # ★ 适应度函数（FITNESS_VERSION = 'fitness-v2'）
│   │   ├── strategies.ts       # ★ 6 策略族 + 20 候选网格
│   │   ├── walkforward.ts      # ★ WF 稳健性 + 同质化纯度
│   │   ├── promotion.ts        # ★ 晋升状态机 promotion-v1（引用 FITNESS_VERSION）
│   │   ├── history.ts          #   历史数据校验 + 缺口检测
│   │   └── broker.ts           #   纸交易 broker
│   ├── orch/
│   │   ├── client.ts           # ★ 编排服务 HTTP 客户端（约 40 端点）
│   │   └── explain.ts          # ★ 决策理由翻译层（原始码 → 一句话人话）
│   ├── trading/paperEngine.ts  #   行情→合成K线→PaperBroker→reducer 回填
│   ├── components/             #   29 个组件（含 3 个仪表盘容器 + 11 个叶子图表）
│   ├── pages/                  #   8 个页面（见 B2 图）
│   └── styles/
│       ├── tokens.css          # ★ 设计令牌
│       └── global.css
│
├── server/                     # ── L6 编排服务（35 文件 / 8873 行）──
│   ├── index.ts                # 1139 行：路由 + 令牌鉴权 + CORS + 生产 fail-closed
│   ├── core.ts                 # 订单意图管道：风控→晋升闸→gateway；killswitch 统一通道
│   ├── risk.ts                 # ★ 下单前风控（默认拒绝，64 行）
│   ├── orchEngine.ts           # 撮合/建仓/标记价
│   ├── pipelineService.ts      # ★ 晋升内禁：持久化状态机(v2)/authorizeLive/资金帽
│   ├── gateway/executor.ts     # ★ execution-gateway：握手门/幂等/去重/出站闸/撤单风暴
│   ├── venue/
│   │   ├── types.ts            # ★ VenueAdapter 契约（place/cancel/onFill/reconcile）
│   │   ├── sandbox.ts          # 故障注入沙盒（默认，无外部副作用）
│   │   ├── cexTestnet.ts       # Binance 现货测试网（HMAC，凭证缺失 fail-closed）
│   │   └── okxTestnet.ts       # OKX 测试网（含杠杆/全仓保证金路径）
│   ├── ledger.ts               # 追加写事件账本（seq 单调 + 哈希链接入）
│   ├── audit.ts                # ★ 审计哈希链：SHA-256 创世锚定 + 篡改定位
│   ├── persistence.ts          # ★ SQLite(WAL)：events/snapshots/audit_chain/… + 实例租约
│   ├── ledgerServer.ts         # 独立账本服务（C-11 拆分第一步，:8791）
│   ├── retention.ts            # 保留策略（默认 90 天，先归档 JSONL 再清理）
│   ├── metrics.ts              # ★ SLO 度量：ACK 分位/拒绝归因/成交/熔断/行情新鲜度
│   ├── slo.ts                  # SLO 目标评估 + 告警通道（webhook + 冷却去重）
│   ├── surveillance.ts         # ★ 操纵自监控：SELF_TRADE / ORDER_CHURN / SMALL_NOTIONAL_BURST
│   ├── reconciliation.ts       # 外部对账
│   ├── mirrorCheck.ts          # 镜像互查（内存链 vs 持久链）
│   ├── feed.ts                 # WebSocket miniTicker 秒级行情 + 指数退避重连
│   ├── autopilot.ts            # ★ 自治循环状态机（accumulating→optimizing→trading）
│   ├── proposalEngine.ts       # ★ LLM 提案生成（无 LLM 时确定性降级）
│   ├── proposals.ts            # ★ 提案校验/去重/唯一出口=candidate（无下单通路）
│   ├── llmProviders.ts         # 多模型适配器（openai/anthropic flavor + probe）
│   ├── sandbox/
│   │   ├── index.ts            # Node Permission Model 隔离子进程
│   │   └── worker.ts           # 变异体评估工人（受限FS+脱敏env+超时SIGKILL；⚠️网络未隔离，见 §3.6.1）
│   ├── devStack.ts             # 三进程一键栈（ledger:8791 + orch:8790 + vite）
│   ├── loadEnv.ts              # .env 加载（零依赖）
│   └── types.ts                # OrchState / RiskConfig
│
├── scripts/                    # ── 验证层 ──
│   ├── golden-backtest.ts      # 黄金回归：复现性/hash/WF/broker/基线比对（255 行）
│   ├── orch-smoke.ts           # 风控/熔断/晋升闸/资金帽/握手门/killswitch 同步断言
│   ├── commercial-smoke.ts     # 商用加固：哈希链+篡改定位/指标聚合/提案安全边界
│   ├── gateway-drill.ts        # killswitch/故障 9 场景演练（artifacts 归档）
│   ├── promotion-smoke.ts      # 引擎晋升状态机回归
│   ├── recon-smoke.ts / mirror-smoke.ts / proposal-slo-smoke.ts
│   ├── surveillance-smoke.ts / sandbox-smoke.ts / autopilot-smoke.ts
│   ├── llm-provider-smoke.ts
│   ├── fetch-history.ts        # 真实 K 线抓取落盘
│   └── okx-*.ts / binance-probe.ts / inspect-mirror-db.ts / rebuild-audit-chain.ts
│                               #   运维排查工具（非门禁，手动跑）
└── docs/                       # 5 份文档，治理见 Part J
```

> ⚠️ **注意 `server/` 的规模**：35 个文件、8873 行，与前端 `src/`（61 文件 / 10004 行）相当。
> v1 文档曾误称"编排器不在本仓库"——**这是错的**，复现时不可省略这一层。

## B5 · 设计令牌（`src/styles/tokens.css`）

```css
:root {
  --bg-base: #04050A;    --bg-surface: #0B0D16;
  --bg-card: #0E1120;    --bg-elevated: #131729;
  --border: #1C2233;     --border-strong: #2A3348;
  --primary: #22D3EE;    --accent: #E879F9;
  --warning: #FFB020;    --signal: #FF8700;
  --up: #FF4D6D;         --down: #00D68F;      /* ★ 中国习惯：涨红跌绿 */
  --text-main: #E8EDF5;  --text-sub: #97A0B5;  --text-weak: #5C6478;
  --font-ui: 'Inter', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
}
```

> **涨红跌绿**是中国用户约定，与欧美相反。做金融类界面时务必确认这一条。

---

# Part C · 分层复现提示词

## L0 · 工程骨架

```text
用 Vite 5 + React 18 + TypeScript(strict) 搭建工程骨架，要求：
1. tsconfig 开启 strict / noEmit / moduleResolution: bundler / jsx: react-jsx。
2. index.html 设 lang="zh-CN"，引入 Inter + JetBrains Mono 字体。
3. 建立 src/styles/tokens.css 定义 CSS 变量设计令牌（深色底 #04050A、
   主色青 #22D3EE、涨 #FF4D6D、跌 #00D68F —— 注意中国习惯涨红跌绿）。
4. 状态管理用 React Context + useReducer，禁止引入 Redux/Zustand。
5. 不要引入 Tailwind 或任何 UI 组件库，样式用原生 CSS + 组件内 <style> 标签。
6. .gitignore 排除 node_modules / dist。
```

## L1 · 真实行情层

```text
实现 Binance 公开行情接入（免 API Key），文件 src/data/market.ts：
1. 符号映射：内部用 ETH-USDC 等，映射到 Binance 的 ETHUSDC。
   关键决策：统一用 USDC 计价而非 USDT，因为 DEX 层也是 USDC，
   避免 USDT/USDC 隐性基差误导用户。
2. fetchSnapshot()：REST /api/v3/ticker/24hr?symbols=[...] 一次性拉全量快照。
3. connectTicker(onTick, onStatus)：WebSocket 组合流
   wss://data-stream.binance.vision/stream?streams=ethusdc@miniTicker/...
   - 断线 5s 后自动重连；返回 stop() 清理函数。
   - onclose 时 onStatus(false)，onopen 时 onStatus(true)。
   - 坏帧静默忽略，不要抛异常中断流。
4. fetchKlines(symbol, interval, limit)：REST K线，字段映射
   [t,o,h,l,c,v] → {t,o,h,l,c,v}。
5. 环境变量可覆盖：VITE_BINANCE_REST / VITE_FEED_WS。

集成要求：
- App 启动时先 fetchSnapshot 对齐，再 connectTicker 持续推送。
- 失败时 dispatch SET_LIVE(false) 并 toast 提示"已降级为模拟引擎"。
- ★ 关键：state.live === true 时，模拟心跳 TICK 只累加 uptimeSec，
  绝对不要用随机数覆盖真实价格。
```

**核心数据结构**：

```ts
export interface TickerUpdate {
  symbol: string      // 内部符号，如 'ETH-USDC'
  price: number
  change24h: number
  high24h: number
  low24h: number
  volume24h: number   // 百万 USD
}
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
```

## L2 · 多链钱包层

```text
用 wagmi 3.7 + viem 2.55 实现多链钱包，文件 src/wallet/：
1. config.ts：createConfig 配置 6 条链
   [mainnet, base, arbitrum, optimism, polygon, bsc]
   - ★ 数组必须加 `as const`，否则 TypeScript 类型推断会失败。
   - connectors: [injected()]
   - transports：每条链用 fallback([http(publicnode), http(llamarpc), http()])
     公共 RPC 不稳定，必须多源兜底。
2. WalletProvider.tsx：QueryClientProvider 包裹 WagmiProvider（顺序不能反）。
3. WalletModal.tsx：
   - 用 useConnectors() 展示 EIP-6963 发现到的钱包（而非硬编码 MetaMask）。
   - 余额查询：★ wagmi v3 的 useBalance 不支持 token 参数且无 formatted 字段，
     必须用 useReadContract + erc20Abi 读 balanceOf，再用 viem formatUnits 换算。
   - 提供 6 链切换网格、复制地址、区块浏览器跳转、断开连接。
4. USDC 地址以 src/dex/uniswap.ts 的 USDC_BY_CHAIN 为唯一来源，禁止另存副本。
```

**RPC fallback 配置**：

```ts
transports: {
  [mainnet.id]: fallback([http('https://ethereum-rpc.publicnode.com'), http('https://eth.llamarpc.com'), http()]),
  [base.id]:     fallback([http('https://base-rpc.publicnode.com'), http()]),
  [arbitrum.id]: fallback([http('https://arbitrum-one-rpc.publicnode.com'), http()]),
  [optimism.id]: fallback([http('https://optimism-rpc.publicnode.com'), http()]),
  [polygon.id]:  fallback([http('https://polygon-bor-rpc.publicnode.com'), http()]),
  [bsc.id]:      fallback([http('https://bnb-rpc.publicnode.com'), http()]),
}
```

## L3 · DEX 执行层

```text
实现 Uniswap V3 链上执行，文件 src/dex/uniswap.ts + src/components/DexSwapPanel.tsx：

1. 合约常量（Uniswap V3 官方通用部署，所有 EVM 链地址一致）：
   QuoterV2     = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e
   SwapRouter02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
   ★ 注意：Base 链上部分"非官方 Quoter"地址会返回错误报价，必须用官方地址。

2. 各链 WETH / USDC 地址（实测值，勿改）：
   1     mainnet:  WETH 0xC02aaA39...756Cc2  USDC 0xA0b86991...06eB48
   8453  base:     WETH 0x4200...0006        USDC 0x833589fC...02913
   42161 arbitrum: WETH 0x82aF4944...fBab1   USDC 0xaf88d065...e5831
   10    optimism: WETH 0x4200...0006        USDC 0x0b2C639c...7Ff85
   137   polygon:  WETH 0x7ceB23fD...9f619   USDC 0x3c499c54...c3359
   ★ 历史坑：OP 链的 WETH 和原生代币地址都是 0x4200...0006，
     曾误把 USDC 也填成这个地址，导致报价完全错误。务必逐个链核对。
   ★ BNB Chain(56) 不配置 Uniswap V3，用 dexSupported() 类型守卫拦截。

3. 报价：三档费率 [100, 500, 3000] 并行询价取最优
   - ★ 不要用 wagmi 的 useReadContract（v3 泛型推断会失败）。
     改用 @tanstack/react-query 的 useQuery + publicClient.readContract。
   - 调用 quoteExactInputSingle({tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n})
   - refetchInterval: 15000，retry: 1

4. ★ 精度处理（历史上出过严重 bug）：
   - 卖出 ETH（decimals 18）用 parseEther(amount)
   - 花费 USDC（decimals 6）用 parseUnits(amount, 6)
   - 曾把 USDC 误用 parseEther，导致金额放大 10^12 倍，界面显示 $5.7M。

5. 执行流程三态：
   a) 模拟执行：publicClient.simulateContract（eth_call，零风险，任何模式可用）
   b) ERC20 授权：仅 USDC→ETH 方向需要，approve(router, maxUint256)
      用 allowance 查询判断是否需要授权，native ETH 输入不需要授权。
   c) 真实执行：sendTransactionAsync —— ★ 仅 LIVE 模式允许，
      非 LIVE 模式按钮必须 disabled 并提示"🔒 LIVE 才可签名"。

6. 滑点保护：amountOutMinimum = best.out * (10000 - slippage*100) / 10000
   提供 0.1% / 0.5% / 1% 三档选择。

7. 价格影响：与 Binance 实时价对比计算 impact%，超过 0.3% 高亮警示。
```

**关键类型守卫**：

```ts
export function dexSupported(chainId: number | undefined): chainId is DexChainId {
  return chainId !== undefined && chainId in contractsByChain
}
```

## L4 · 进化引擎层

```text
实现确定性自进化引擎，文件 src/engine/（纯函数，零副作用，可测试）：

1. 确定性随机 rng.ts：mulberry32(seed) —— 同一 seed 必须产出同一结果，
   这是"回测可复现"的前提。
2. 合成数据 data.ts：genSynthCandles({seed, bars, startPrice, volDaily,
   driftDaily, barMinutes})，K线不足时作为回退数据源。
3. 指标 indicators.ts：sma / ema / rsi / stddev / macd（全部返回数组，
   索引对齐 candles，未就绪位置填 NaN）。
4. 撮合 matching.ts + 回测 backtest.ts：支持 market/limit，
   含 makerFeeBps 2 / takerFeeBps 5 / slippageBps 3 / latencyBars 1。
5. 绩效 report.ts：annReturnPct / sharpe / maxDrawdownPct / tradesPerDay / winRatePct。

6. ★ 策略族 strategies.ts —— 6 个因子族，buildCandidateSet() 产出 20 个候选：
   - maCross(fast, slow)                  4 组：5/20, 10/30, 20/60, 12/48
   - rsiReversion(period, lower, upper)   4 组：14/30/70, 9/25/65, 7/20/60, 21/35/75
   - breakout(period)                     2 组：20, 55
   - bollingerReversion(period, numStd)   4 组：20/2, 20/2.5, 14/2, 30/2
   - macdTrend(fast, slow, signal)        3 组：12/26/9, 8/21/5, 5/35/5
   - emaRsiCombo(ema, rsi, lower, upper)  3 组：50/14/30/70, 100/9/25/65, 20/14/35/75
   统一接口：decide(ctx) => {side, type, price?, frac} | null
   evaluateCandidateGrid() 按 fitness 降序返回。

7. ★ 适应度 fitness.ts（FITNESS_VERSION = 'fitness-v2'）：
     ddAbs = max(|maxDrawdownPct|, 5)
     calmarAdj = annReturnPct / ddAbs
     churnPenalty = 0.05 * sqrt(max(0, tradesPerDay))
     if calmarAdj <= 0: return clamp(calmarAdj - churnPenalty, -100, 0)
     compressed = 25 * log1p(calmarAdj)
     return clamp(compressed - churnPenalty, -100, 200)
   设计意图：用 Calmar 比率而非纯收益，惩罚回撤；用 sqrt 弱化换手惩罚，
   让高频策略也有机会胜出；log1p 压缩极端值避免单只怪物策略垄断。

8. ★ Walk-Forward 稳健性 walkforward.ts（2026-09-14 重建，见 `DEV_PROGRESS.md` §3.10）：
   - 滚动训练/测试窗口，每折记录 isFitness / oosFitness
   - ★ 关键改动：**对整块候选场**做样本外评估，而不是只评赢家一个。
     只评赢家 = 多重性未校正（从 20 个候选里取样本内最大，本就被选择偏差抬高），
     这正是 F-34③ 的真因。
   - 每折输出：oosFieldMean（候选场均值）/ winnerAscRank / winnerW（归一化分位）
     / selectionEdge = oosFitness − oosFieldMean / candidates
   - 聚合出 CSCV-PBO（组合对称交叉验证的过拟合概率）+ avgWinnerW + avgSelectionEdge
   - ★ 判据**不再是** `folds>=3 && positiveOosShare>=0.5` ——
     后者在普涨行情里恒真，等于没有判据。改由 `overfit.ts` 的三态裁定负责：
     `judgeOverfit(receipt)` 比对 maxPbo / minAvgWinnerW（阈值住消费方 config）；
     凭据不可用或样本不足 → `UNVERIFIABLE` 且**不放行**（缺证据 ≠ 无风险）。
   - combinationPurity(): 候选相关性矩阵，
     homogeneous = avgCorr > 0.8（同质化候选应被拒绝，避免伪多样化）

9. ★ 晋升流水线 promotion.ts（`PROMOTION_PIPELINE_VERSION = 'promotion-v4'`）—— **9 状态机**：
   candidate → (backtest 门) → paper_observing → ready_for_small_cap
             → testnet_verifying → testnet_verified → small_cap_live → full_live
   旁路：rejected / rolled_back（rollback 后可 restoreFromRollback）

   ★ 顺序要点：**测试网实测排在人工审批之前**。`approveSmallCap` 的前置条件是
   `testnet_verified` 而**不是** `ready_for_small_cap` ——
   「观察期通过」只证明它在纸面成立，不证明它在真实撮合下能跑
   （纸交易没有对手方拒单、没有滑点、没有资金费、没有最小下单量、没有非同步成交，
   而这些正是小资金实盘最先踩到的东西）。所以人工只能审批**已经过测试网检验**的策略。

   backtest 门三条拒绝条件（顺序即优先级）：
     - fitness < minFitness(30)
     - requireOverfit && judgeOverfit(receipt).pass !== true
       // 结构校验在前、数值裁定在后：凭据不可用时报 UNVERIFIABLE，而不是拿残缺数字比阈值
     - forbidHomogeneousPurity && purityHomogeneous
   paper 观察期：trades >= 20 且 maxDrawdownPct <= 10 才能进 ready（否则直接 rejected）
   testnet 实测：fills >= 10、hours >= 6、maxDrawdownPct <= 10、CVaR <= 4% 才能 verified
                （触犯即 testnet_violation 退回，不是放行）
   人工审批 approveSmallCap(approver, ts) 才能进 small_cap_live（资金帽 500 USDC）
   promoteFull() 解除资金帽进 full_live
   ★ 所有非法状态转移抛 INVALID_TRANSITION:{current}→{target}

   ★ 持久化格式 StoredV3：v3 起增加 `liveMargin` —— 资金帽按**自有资金（保证金）**计量，
   不是名义本金（F-37：按名义本金校验会把合规的小资金策略结构性锁死）。
   ★ `restore()` 把旧记录的 `wfRobust` 归一化为 null 而**不回填** —— 回填等于编造证据。
   ★ 对象字段 `overfit: OverfitStamp | null` **取代**了 `wfRobust: boolean | null`。

10. 变异沙箱（EvoPage 调用 orch 的 /sandbox/evaluate）：
    用户提交的 makeStrategy(E) 代码在隔离子进程中回测
    （受限 FS + 脱敏 env + 超时击杀 + **网络出口封锁** ——
    `server/sandbox/network-lockdown.ts` 经 `--import` 在用户代码加载前改写
    `fetch` / `net.connect` / `https.get` / `dns.lookup` 四条通道，实测全部 BLOCKED 并进 CI），
    ⚠️ 残留：`--allow-fs-read` 仍指向项目根 ⇒ 沙箱**能读到 `.env`**，
    但网络已断，「读密钥→外发」链已断。收窄到 `src/engine` + `server/sandbox` 仍待办（见 `DEV_PROGRESS.md` §3.6.1）。
    结果仅入 candidate 观察流程，
    ★ 绝不允许直接进入 live。
```

**晋升流水线状态图**：

```
                    ┌──────────────┐
                    │  candidate   │
                    └──────┬───────┘
              backtest 门（fitness≥30 / WF稳健 / 非同质）
                    ┌──────┴───────┐
             通过 → │              │ ← 拒绝
                    ▼              ▼
        ┌───────────────────┐  ┌──────────┐
        │ paper_observing   │  │ rejected │
        │ (≥20笔, dd≤10%)   │  └──────────┘
        └─────────┬─────────┘
                  ▼
        ┌───────────────────┐
        │ready_for_small_cap│
        └─────────┬─────────┘
          人工审批(approver)
                  ▼
        ┌───────────────────┐
        │ small_cap_live    │  资金帽 500 USDC
        └─────────┬─────────┘
             达标解除资金帽
                  ▼
        ┌───────────────────┐
        │    full_live      │
        └───────────────────┘
              ↕ rollback / restoreFromRollback
        ┌───────────────────┐
        │   rolled_back     │
        └───────────────────┘
```

## L5 · 状态机与页面

```text
Store (src/store/Store.tsx) 关键设计：
1. TradeMode 三档：sim(灰) / paper(琥珀) / live(红)
   ★ live 不跨会话恢复：init 时 prefs.mode === 'live' → 强制降级为 'paper'
2. 行情相关 action：MARKET_SNAPSHOT / MARKET_TICK / SET_LIVE / SET_KLINES
   ★ TICK 在 live 时只 +uptimeSec，不生成随机价格
3. K线缓存 key 格式：`${symbol}:${interval}`
4. 订单：PLACE_ORDER → 市价单立即 applyFill；限价单锁定资金
   CANCEL_ORDER 退还锁定；FILL_ORDER 释放锁定并按真实成交价+手续费结算
5. 偏好持久化 localStorage key = 'evolve.prefs.v1'
   ★ orchUrl 兼容旧版 8787 → 实际 8790，避免已存错误地址导致 Failed to fetch
6. 页面路由：overview / terminal / agents / evo / protocol / monitor / settings
```

**页面清单**：

| 页面 | 职责 | 依赖层 |
|---|---|---|
| OverviewPage | KPI 总览、权益曲线、事件流 | L1 |
| TerminalPage | 交易终端：K线 + 下单 + **DEX 面板** | L1 + L3 |
| AgentsPage | 6 个策略 Agent 的启停与绩效 | L4 |
| EvoPage | 进化种群、精英榜、**变异沙箱**、推理日志 | L4 |
| ProtocolPage | x402 / ERC-8004 / MCP 协议说明 | — |
| MonitorPage | 编排器状态、SLO、场所状态 | orch |
| SettingsPage | 模式切换、风控参数、编排器连接 | — |

---

# Part D · 关键契约（复制时保持一字不差）

## D1 · 合约地址速查

| 链 | ChainId | WETH | USDC |
|---|---|---|---|
| Ethereum | 1 | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Base | 8453 | `0x4200000000000000000000000000000000000006` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Arbitrum | 42161 | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Optimism | 10 | `0x4200000000000000000000000000000000000006` | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |
| Polygon | 137 | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |

> QuoterV2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`
> SwapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`

## D2 · 晋升流水线默认配置

```ts
import { FITNESS_VERSION } from './fitness.ts'
import { CVAR_DEFAULT_ALPHA } from './riskMetrics.ts'
import { DEFAULT_OVERFIT_THRESHOLDS } from './overfit.ts'

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  minFitness: 30,
  fitnessVersion: FITNESS_VERSION,        // 引用常量，勿硬编码（见 F-1）
  requireOverfit: true,                   // ★ 取代旧的自报布尔 requireWfRobust（F-34①）
  overfit: DEFAULT_OVERFIT_THRESHOLDS,    // 阈值住消费方 config；单一出处是 overfit.ts 的零假设校准表
  forbidHomogeneousPurity: true,
  paperMinTrades: 20,
  paperMaxDrawdownPct: 10,
  testnetMinFills: 10,
  testnetMinHours: 6,
  testnetMaxDrawdownPct: 10,
  testnetMaxCvarPct: 4,
  testnetTailAlpha: CVAR_DEFAULT_ALPHA,
  smallCapUsd: 500,
}

// src/engine/overfit.ts —— 阈值的单一出处（按零假设分布定价，勿在别处写第二份）
export const DEFAULT_OVERFIT_THRESHOLDS: OverfitThresholds = {
  maxPbo: 0.25,            // 0.5 在纯噪声上 53% 会通过，等于没有门
  minAvgWinnerW: 0.6,      // 赢家在样本外候选场里的平均分位
  minFolds: 4,             // 3 折偏松：rolling 窗口下相邻折训练集重叠，折间不独立
  minCandidates: 8,
  minPboCombinations: 70,  // 组合数太少时 PBO 只能取少数离散值，不构成统计量
}
```

**回测门的三条拒绝条件（2026-09-14 起，顺序即优先级）**：

```text
1. fitness < minFitness(30)
2. requireOverfit && judgeOverfit(receipt).pass !== true
      —— 凭据结构校验在前，数值裁定在后。
         顺序是刻意的：结构不可用时应报 UNVERIFIABLE，而不是拿残缺数字去比阈值。
3. forbidHomogeneousPurity && purityHomogeneous
```

> ★ `requireOverfit` 是**部署配置**，不是每次调用可传的参数 —— 前者要改部署才能放宽，
> 后者调用方随手就能绕过。**改造前的漏洞正是后者**（前端硬编码 `wfRobust: true`，服务端 `Boolean(body.wfRobust)`）。

## D3 · 编排服务 API 契约（实测 89 个路径）

> ★ **2026-09-17 第七轮复核（现算，非沿用）**：对 `server/index.ts` 与 `server/ledgerServer.ts` 同时匹配
> `url.pathname === '…'` 与 `url.pathname.startsWith('…')`（后者覆盖 3 个前缀路由
> `/orders/` `/promotions/` `/llm/providers/`），**去重后 89 个唯一路径**。
> ★ 本次复核**发现上一版写的 84 已经漂了 2** —— 第六轮新增的 `/voice/engine`、`/voice/tts`
> 从未被记进本行（`DEV_PROGRESS §3.17` 写着 86，两处不一致）。**同一事实存了两份，最早过期的总是后写的那份。**
> 本轮 = 86（上一版真实值）+ 3（`/mission`、`/mission/plan`、`/mission/start`）= **89**，已实测相符。
> 数端点要数**真实路由**（`pathname ===` + `pathname.startsWith`），不要数文档里的注释文字
> —— 注释本身是最先过期的副本。

所有**写操作**（POST/DELETE）必须带 `x-orch-token` 头；GET 视端点而定（`/healthz` `/state` 免鉴权）。

**端口的三重来源（⚠️ 见 F-14）**：
- `server/index.ts` 默认 `PORT=8787`
- `server/devStack.ts` 默认 `ORCH_PORT=8790`、`LEDGER_PORT=8791`
- `.env.example` 写的是 `8787`
- 前端 `Store.tsx` 默认连 **8790**（并对旧的 8787 做了兼容替换）

| 分类 | 端点 | 方法 | 用途 |
|---|---|---|---|
| **基础** | `/healthz` | GET | uptime / killswitch / mode（免鉴权，用于探活） |
| | `/state` | GET | 全量状态：余额/权益/峰值/持仓/订单/风控参数/最新价 |
| | `/events?since=N` | GET | 增量事件流（seq 游标；持久模式下读 SQLite） |
| **交易** | `/orders` | POST | 提交订单意图（经风控→晋升闸→gateway） |
| | `/orders/{clientOrderId}` | DELETE | 撤单 |
| | `/killswitch` | POST | 紧急开关（激活/解除） |
| | `/risk/config` | GET/POST | ★ 运行时风控参数读写（免重启；`RISK_MAX_NOTIONAL_USD` 仅启动时生效） |
| **晋升** | `/promotions` | GET | 晋升记录列表（含 liveNotional 累计） |
| | `/promotions/{id}/{action}` | POST | 晋升流转（submit/approve/rollback/restore…） |
| **提案** | `/proposals` | POST | 提交一条提案（body 即提案对象，**不是**生成入口） |
| | `/proposals/generate` | POST | ★ **真正的提案生成入口**（`source:'llm'` 走 LLM，否则确定性降级） |
| | `/proposals/call` | POST | 裸调模型（callModel），不落提案 |
| **LLM** | `/llm/providers` | GET/POST | 多模型适配器清单/新增 |
| | `/llm/providers/{id}` | DELETE | 删除 provider |
| | `/llm/providers/{id}/probe` | POST | 连通性 + API key 校验（返回可用模型列表） |
| | `/llm/providers/{id}/select-model` | POST | 切换 activeModel |
| **自治** | `/autopilot` | GET | 状态：running/stage/cycles/pnlPct/winner/barsAccumulated/**gateRefusal**（F-47 过拟合门拒绝详情） |
| | `/autopilot/start` | POST | 启动（body: `{targetPct}`，范围 (0, 50]） |
| | `/autopilot/stop` | POST | 停止 |
| **运维** | `/metrics` | GET | ACK 分位/拒绝归因 Top5/成交/撤单/熔断/行情新鲜度/gateway 状态 |
| | `/slo` | GET | 三项目标达标评估 |
| | `/slo/check` | POST | 触发一次 SLO 检查与告警 |
| | `/audit/verify` | GET | ★ 审计哈希链校验（返回篡改断点 seq） |
| | `/gateway/status` | GET | 网关状态（握手/出站闸/队列/去重计数） |
| | `/gateway/cancel-all` | POST | 撤单风暴 |
| | `/venues/status` | GET | 各场所状态（含 venueOutboundDisabledReason） |
| | `/reconciliation` | GET | 最近一次对账结果 |
| | `/reconciliation/run` | POST | 触发对账 |
| | `/reconciliation/sync-venue` | POST | ★ 把本地账本同步为 venue 真实余额并**解除出站闸**（账本失配的唯一解法） |
| | `/reconciliation/clear-stop` | POST | 人工清除 venue 出站禁用 |
| | `/mirror/status` | GET | 镜像互查状态 |
| | `/mirror/check` | POST | 触发镜像互查 |
| | `/surveillance` | GET | 操纵自监控快照（SELF_TRADE / ORDER_CHURN / SMALL_NOTIONAL_BURST 标记 + 小额窗口笔数与合计） |
| | `/sandbox/evaluate` | POST | 隔离沙箱评估用户策略代码，返回 fitness |
| **语音** | `/voice/config` | GET/POST | 音色目录（**14 档 = 云端 7 + 本机 7**）+ 播报档位 + 下单确认强度。★ `confirmPolicy` **只有 `graded`/`always`，没有 `off`** |
| | `/voice/state` | GET | 会话快照：turn / generation / pending / 各类计数 / 最近播报（免鉴权） |
| | `/voice/daily` | GET | 日报：结构化数字 + 可直接朗读的 `narration`；`partialDay` 标明"统计从进程启动算起" |
| | `/voice/utterance` | POST | ★ **唯一的话入口**：解析 →（必要时）确认 → **转交既有的 `processOrderIntent` / `processLiveIntent`** |
| | `/voice/interrupt` | POST | 打断：`generation += 1` 且清掉待确认凭证 ⇒ 在途答复全部作废 |
| | `/voice/stream` | GET | 播报 SSE（`event: status` / `event: narration`）。**刻意不用 WebSocket**，理由见 §L6.11 |
| | `/voice/engine` | GET | 云端神经音色健康度 + 14 档目录（含每档 `engine`）。★ 与 `/voice/config` 吃**同一份目录**（§L6.15.5）|
| | `/voice/tts` | POST | 预合成音频（**零密钥**端点）。失败**返回 `{ok:false,kind,message}` 而不抛**，5 类原因各有独立文案（§L6.15.7）|
| **任务层** | `/mission` | GET | 当前裁定输入（场所 / 权益 / 止损垫 / 安全杠杆 / **账本还原的过拟合门结论**）+ 自动驾驶状态 + 已裁定份数 |
| | `/mission/plan` | POST | ★ **只裁定不启动**：把一句自然语言目标拆到能被既有约束逐条检验，返回三态结论 + **每条理由的数** + 替代方案 + `planId`（空/超 300 字 → 422）|
| | `/mission/start` | POST | 按 `planId` 启动（**二次裁定**：重新算出的 id 不一致 ⇒ `PLAN_STALE` 拒绝）。**语音没有这条近路**（§L6.16.8）|

> ★ **`/voice/utterance` 的返回体必须读 `dropped`**：`true` 表示这一轮已被更晚的打断作废。
> 前端照着念，用户就会先听到新问题的答复、再被旧问题的答复打断一次 ——
> 表现为"这个助手抢话、答非所问"，而服务端日志一切正常。这是本层最难查的一类失效。

> **易踩的接口误区**（实测踩过）：生成提案是 `POST /proposals/generate`，不是 `/proposals`（后者是"提交一条已构造的提案"），
> 也不是 `/proposals/call`（后者只裸调模型）。调错会得到 `INVALID_PROPOSAL_ID` 或 `INVALID_KIND`，
> 容易被误判成"LLM 坏了"。

## D4 · 环境变量契约（`.env.example` 为准）

| 变量 | 默认 | 作用 |
|---|---|---|
| `ORCH_TOKEN` | `dev-insecure-token` | 写操作令牌。**`NODE_ENV=production` 未设置则拒绝启动**（fail-closed） |
| `ORCH_ALLOWED_ORIGIN` | `*` | CORS 白名单（生产必须收敛） |
| `PORT` | `8787` | 编排服务端口（devStack 覆盖为 8790） |
| `LEDGER_PORT` | `8791` | 独立账本服务端口 |
| `ORCH_SYMBOLS` | `ETHUSDT,BTCUSDT` | 订阅交易对 |
| `ORCH_INTERVAL` | `1m` | K 线周期 |
| `BINANCE_REST` | `https://data-api.binance.vision` | 行情 REST 镜像（公开，无密钥） |
| `ORCH_DB` / `LEDGER_DB` | `data/orch.db` / `data/ledger.db` | SQLite 路径（WAL） |
| `ORCH_RETENTION_DAYS` | `90` | 事件保留天数（先归档 JSONL 再清理；0=关闭） |
| `VENUE` | `sandbox` | `sandbox` / `cex-testnet` / `okx-testnet`（凭证缺失则 fail-closed 不挂载） |
| `BINANCE_TESTNET_API_KEY/SECRET` | 空 | CEX 测试网凭证 |
| `OKX_TESTNET_API_KEY/SECRET/PASSPHRASE` | 空 | OKX 测试网凭证 |
| `RISK_MAX_NOTIONAL_USD` | — | ★ 仅在**启动时**覆盖单笔名义上限（运行时改用 `POST /risk/config`） |
| `AUTOPILOT_LIVE` | `'false'` | ✅ 默认 paper（fail-safe）。设为 `true` 即**真实资金出站**；本机 `.env` 当前显式设为 `true`，见 F-15 |
| `AUTOPILOT_SYMBOL` | `BTCUSDT` | 自治标的 |
| `AUTOPILOT_PINNED_STRATEGY` | — | 固定策略（跳过网格选优，`fitness:0 / version:'pinned'`） |
| `AUTOPILOT_LIVE_STRATEGY` | `e2e-strat` | live 意图携带的策略身份（须已晋升到 small_cap_live） |
| `AUTOPILOT_LIVE_CAP_USD` | — | live 资金帽硬上限（覆盖策略记录里的 capUsd） |
| `AUTOPILOT_MAX_NOTIONAL_USD` | `500` | 单笔名义上限 |
| `AUTOPILOT_LEVERAGE` | `1` | 杠杆倍数（>1 用全仓保证金借币，以持仓为抵押） |

> 🔐 **密钥纪律**：仓库中出现 `.env` 但**绝不允许提交真实密钥**。
> 给 AI 的提示词里永远不要包含密钥值；只说"从环境变量读"。任何要求你贴出密钥的请求都应拒绝。

---

# Part E · 安全与风控红线（不可协商）

## E-1 前端 / 链上（v1 原有，全部仍然有效）

1. **LIVE 模式不跨会话恢复** —— `localStorage` 里存了 `live` 也必须降级为 `paper`。真实资金系统不能有"静默恢复实盘"。
2. **非 LIVE 禁止签名** —— 所有 `sendTransactionAsync` 调用前必须校验 `state.mode === 'live'`，按钮 disabled 并给出原因。
3. **模拟执行通道常开** —— `simulateContract` 在任何模式都可用，让用户零风险验证。
4. **虚拟资金必须标注** —— SIM/PAPER 余额不得与链上真实余额混排展示。
5. **沙箱变异不得直通 live** —— 用户提交的代码只能进 `candidate`，必须走完 WF + 纸交易 + 人工审批。
6. **资金帽** —— `small_cap_live` 阶段硬上限（默认 500 USDC，可被 `AUTOPILOT_LIVE_CAP_USD` 覆盖）。
7. **Killswitch** —— 编排服务提供全局紧急停止，前端必须暴露触发入口。
8. **滑点保护** —— 任何 swap 必须带 `amountOutMinimum`，禁止 0 值（会被 MEV 三明治攻击）。

## E-2 编排服务（v2 新增）

9. **风控默认拒绝** —— `preTradeCheck()` 任何一项失败即拒单，不允许"先放行再补校验"。
   检查顺序：killswitch → 参数完整性 → 名义上限 → 价格偏离 bps →**熔断（先于频控）** → 频控。
   ★ 熔断必须排在频控之前——**频控不能掩盖爆仓风险**。

10. **killswitch 必须三处同步冻结** —— 本地撤全单 + venue 撤单风暴 + gateway 出站闸。
    只冻结其中一两处是最危险的（历史 P0-5 缺陷就是"编排层 killswitch=true 但 gateway 仍可放行直连意图"）。

11. **gateway 只接受 live 意图** —— `intent.mode !== 'live'` 直接返回 `GATEWAY_ACCEPTS_LIVE_INTENTS_ONLY`。
    且必须依次过：**握手门** → 适配器已挂载 → killswitch → 出站闸 → clientOrderId 幂等。

12. **live 意图必须携带已授权策略身份** —— `authorizeLive()` 只放行 `small_cap_live` / `full_live`；
    单笔（`STRATEGY_CAP_ORDER_EXCEEDS`）与累计（`STRATEGY_CAP_EXCEEDED`）双重受资金帽约束。
    `full_live` 的自动放量**未开放**，必须人工走 approve。

13. **对账失配即停出站** —— 账本与 venue 不一致时置 `venueOutboundDisabledReason`，
    该闸**只能人工清除**（`POST /reconciliation/clear-stop`），不允许自动恢复。

14. **生产 fail-closed** —— `NODE_ENV=production` 未显式设置 `ORCH_TOKEN`（或仍为 `dev-insecure-token`）
    则**拒绝启动**；venue 凭证缺失则**不挂载适配器**，而不是降级成"假装能下单"。

15. **LLM 结构性无下单通路** —— 提案器只能产出结构化提案，唯一出口是 `candidate` 阶段。
    这条隔离在模块边界上实现，**永不因功能需求松动**。

16. **沙箱约束（以实测为准，勿照抄旧声称）** —— 用户代码在隔离子进程中运行：
    已生效的是 **受限 FS + 脱敏环境变量 + 超时 SIGKILL**。
    ⚠️ **"默认断网"曾写在本文档，但 2026-09-12 实测不成立**：
    Node 22 的权限模型不含网络控制（`--allow-net` 需 Node 24+），
    且 `--allow-fs-read=<项目根>` 使 `.env` 可读。
    ★ 教训：**安全属性必须实测，不能凭"用了某个机制"就推定它覆盖了某个维度。**
    处置见 `DEV_PROGRESS.md` §3.6.1。

17. **审计链不可断** —— 事件追加写且 `hash = H(prev|seq|ts|kind|payload)`，创世锚定；
    任何参数变更与下单都必须留痕，并能通过 `/audit/verify` 定位篡改断点。

## E-3 两条"静默陷阱"警戒线（v2 新增，来自实测）

18. **安全开关的默认值必须在安全侧** —— 参照 `AUTOPILOT_LIVE`（F-15）：
    它**曾**默认 `'true'`，裸启动即走实盘路径（已于 2026-09-12 修正为 `'false'`）。
    凡 `*_ENABLE` / `*_LIVE` / `*_ALLOW` 型开关，默认值必须是 `false`。
    ★ 标注这条不是怀旧：**已修的缺陷仍是最好的教材**——它会以别的变量名再犯一次。
19. **审计事件的字段必须反映真实上下文** —— 参照 `stopAutopilot` 把 `scope` 硬编码为 `'paper'`（F-16）。
    审计链的全部价值在于事后还原真相；一个写错的 scope 就会让复盘结论失真。

---

# Part F · 已知问题与避坑清单

> 这一节是本文档**复用价值最高**的部分。每个坑都是实测踩出来的。

### 🐛 F-1 · Fitness 版本号不一致（已修复，勿再犯）

`src/engine/fitness.ts` 导出 `FITNESS_VERSION = 'fitness-v2'`，
但 `src/engine/promotion.ts` 的 `DEFAULT_PIPELINE_CONFIG.fitnessVersion` 曾硬编码 `'fitness-v1'`。

**后果**：`evaluateBacktestGate()` 会调用 `assertFitnessVersion()` 并抛出
`FITNESS_VERSION_MISMATCH:fitness-v2 != fitness-v1`，导致**所有策略都无法通过 backtest 门**。

**修复**：`promotion.ts` 顶部 `import { FITNESS_VERSION } from './fitness.ts'`，
配置改为 `fitnessVersion: FITNESS_VERSION`；`pages/EvoPage.tsx` 两处 UI 文案同样改引用常量。
★ 原则：**版本号这类常量永远引用，不要硬编码**。

**影响面澄清**：grep 确认前端从未调用 `PromotionPipeline`（仅在 `engine/index.ts` 导出），
晋升实际由编排服务执行**同一份** `src/engine/promotion.ts`（`pipelineService` 引用 `DEFAULT_PIPELINE_CONFIG`），
所以修复后**前后端已统一在 `fitness-v2`**——原先"后端仍是 fitness-v1"的判断**已不再成立**（2026-09-12 复检更新）。

**留存的元问题**：`DEV_PROGRESS.md` 的 E1 / B5 / 源码图仍写着 `fitness-v1`，属文档漂移而非代码问题（见 F-21）。
★ 原则：**版本号这类常量永远引用，不要硬编码**；文档里也不要复述版本号，用引用。

### 🐛 F-2 · USDC 精度错误（已修复，勿再犯）

曾把 USDC 金额用 `parseEther()` 解析（18 位），实际 USDC 是 **6 位小数**。
后果：3000 USDC 被当成 3000×10¹² 处理，界面显示 $5.7M / ≈2980 ETH。

**正确写法**：
```ts
const amountIn = sellEth ? parseEther(amount) : parseUnits(amount, 6)
```

### 🐛 F-3 · Optimism 链 USDC 地址填错（已修复）

OP 链的 WETH 是 `0x4200...0006`，曾误把 `usdc` 也填成同一地址。
**后果**：报价完全错误。每条链的 token 地址必须单独核对，不要用"套路"推断。

### 🐛 F-4 · Base 链非官方 Quoter（已修复）

Base 上存在非官方 Quoter 合约会返回离谱报价。**只用官方通用地址**
`0x61fFE014bA17989E743c5F6cB21bF9697530B21e`。

### 🐛 F-5 · wagmi v3 `useReadContract` 泛型推断失败

在 DEX 三费率并行询价场景下，wagmi v3 的 `useReadContract` 类型推断会失败。
**替代方案**：`@tanstack/react-query` 的 `useQuery` + `publicClient.readContract()`。

### 🐛 F-6 · wagmi v3 `useBalance` 不支持 token 参数

v3 的 `useBalance` 没有 `token` 参数，返回值也没有 `formatted` 字段。
查 ERC20 余额请用 `useReadContract` + `erc20Abi` + viem `formatUnits`。

### 🐛 F-7 · `chains` 数组缺 `as const`

`createConfig({ chains: [...] })` 若不加 `as const`，TypeScript 会报类型不匹配。
```ts
export const chains = [mainnet, base, ...] as const
```

### 🐛 F-8 · npm 官方源安装卡死

安装 wagmi/viem 依赖树时 npmjs 源可能卡死十几分钟。
**解决**：`npm install --registry=https://registry.npmmirror.com`

### 🐛 F-9 · `dist` 被预览进程锁定导致 build 失败

Windows 上 `vite preview` 运行时 `vite build` 会因文件占用失败。
**解决**：先 `netstat -ano | findstr :4173` 找 PID → `taskkill /F /PID <pid>` → 再删 `dist` 重建。

### 🐛 F-10 · 端口 5173 被系统进程占用

本机 5173 被 `svchost.exe` 占用，dev server 无法绑定。
**规避**：使用 `vite preview --port 4173`（或自定义端口）。

### 🐛 F-11 · 链上报价与 Binance 价格差异大

实测出现过链上 ETH/USDC 报价折合 $1,913 而 Binance $3,741 的情况。
**排查结论**：不是代码 bug。用 viem 直连 `ethereum-rpc.publicnode.com` 复核，
结果与 UI 一致；而 `llamarpc` 返回 521 错误。
**教训**：① 公共 RPC 数据质量参差，必须 fallback 多源；
② 报价面板应显示"价格影响 vs Binance"让用户自行判断，不要静默取信单一来源。

### 🐛 F-12 · 编排器默认端口变更

旧版默认 `8787`，实际 devStack 跑在 `8790`。已存 localStorage 的旧地址会导致
`Failed to fetch`。Store 初始化时做了兼容替换：
```ts
orchUrl: prefs.orchUrl && prefs.orchUrl !== 'http://localhost:8787'
  ? prefs.orchUrl : 'http://localhost:8790'
```

### 🐛 F-13 · vite 8 清空 dist 时 safe-delete 失败（环境坑）

本机 `node_modules` 已是 **vite 8**（rolldown 内核，不再是 v5）。`vite build` 在
`vite:prepare-out-dir` 阶段清空 `dist` 时会经过本机 genie 的 `safe-delete` shim，可能报：

```
[plugin vite:prepare-out-dir]
Error: [safe-delete] 操作失败: ...dist/index.html: Error during a `trash` operation:
Unknown { description: "Some operations were aborted" }
```

**关键判断**：此时 `tsc` 其实**已经通过**（因为 `build` = `tsc && vite build`，
能走到 vite 就说明类型没问题）。失败纯粹发生在"删旧 dist"这一步，**不是代码问题**。

**解决**（按成功率排序）：
1. **先停预览进程**再构建（`dist` 被占用是主因）：
   ```bash
   PID=$(netstat -ano | grep ":4173" | grep -i LISTENING | awk '{print $NF}' | head -1)
   [ -n "$PID" ] && taskkill /F /PID $PID
   rm -rf dist && npm run build
   ```
2. Git Bash 的 `rm -rf dist` 不经过 node shim，通常可直接绕过；
3. 若仍失败，用 PowerShell：`Remove-Item -Recurse -Force dist`。

> 相关：预览端口固定用 **4173**（5173 被 `svchost.exe` 占用，见 F-10）。

---

> **以下 F-14 ~ F-21 为 2026-09-12 复检新增**（v1 只有 F-1 ~ F-13）。
> 这批坑的共同特点：**它们不会让程序报错崩溃，只会让系统"看起来在正常工作"**。
> 对量化系统而言，静默错误比崩溃危险得多。

### 🐛 F-14 · 端口有三重来源，互不一致（用户可见症状已修，根因待决）

| 来源 | 端口 |
|---|---|
| `server/index.ts` 默认值 | `8787` |
| `server/devStack.ts` 默认值 | **`8790`**（`ORCH_PORT`），账本 `8791` |
| `.env.example` | `8787` |
| 前端 `Store.tsx` 默认连接 | **`8790`** |

**后果**：用 `npm run orch` 直接起服务会监听 8787，而前端连 8790 → 全站 `offline`。
或用 `npm run stack` 起在 8790，但你以为按 `.env.example` 应该是 8787。

**✅ 已修的部分（2026-09-12，纯文案）**：`MonitorPage.tsx` 的离线引导面板原先写着
「在仓库根目录另开一个终端启动：`npm run orch`」+「默认地址 `http://localhost:8787`」，
而 `Store.tsx` 的默认 `orchUrl` 是 **8790** —— **照着面板做必然连不上**。
现已改为并列展示两种启动方式及其不同端口（`stack`→8790 / `orch`→8787），
并使输入框 placeholder 与真实默认值（8790）一致。**只改了文案，未改任何行为。**

**⏳ 仍待决的根因**：三处默认值仍各写各的，没有单一常量来源。
建议统一为「默认 8787，可用 `PORT` 覆盖，前端从同一常量读」。
改代码前请先看 `Part J4`；**前端连不上时第一件事是确认端口，不要急着怀疑代码。**

### ✅ F-15 · `AUTOPILOT_LIVE` 默认值曾为 `'true'`（已于 2026-09-12 修正为 fail-safe）

**历史缺陷**（修正前）：
```ts
// server/autopilot.ts（旧）
function isAutopilotLive(): boolean {
  return (process.env.AUTOPILOT_LIVE ?? 'true').toLowerCase() === 'true'
}
```

**风险**：新克隆的仓库、或 `.env` 缺这一行时，Autopilot **默认走 live 路径**——
即 `processLiveIntent` → `authorizeLive` → gateway 出站。而"安全默认"应当是 paper。

**当前代码**（`server/autopilot.ts:144`）：
```ts
function isAutopilotLive(): boolean {
  // ⚠️ 安全默认值必须是 false。历史版本写作 `?? 'true'`，
  // 意味着新克隆的仓库、或 .env 漏了这一行时，自动驾驶**默认走实盘路径**。
  return (process.env.AUTOPILOT_LIVE ?? 'false').toLowerCase() === 'true'
}
```
★ `ACCOUNT_KEY.environment`（`autopilot.ts:98`）用**同一判据**推导 `paper`/`live`，
两处口径一致——不会出现「按 paper 记账、按 live 出站」的分裂。

**验证方式**（运行时实测，非读代码推断）：
```bash
node -e "delete process.env.AUTOPILOT_LIVE; console.log((process.env.AUTOPILOT_LIVE ?? 'false') === 'true')"
# → false，即 PAPER
```

**⚠️ 剩余风险（这才是真正要盯的）**：
本机 `.env` **显式**写了 `AUTOPILOT_LIVE=true`。这**不是**默认值缺陷，而是显式配置——
默认值已兜住"新环境裸启动"，但**改不到你本机的 `.env`**。
本机跑起来仍是 live 语义、真实资金出站。
**结论区分**：代码层的 fail-safe ✅ 已达成；部署层的意图确认 ⏳ 由使用者负责。

★ 原则：**凡是"开/关"型安全开关，默认值必须是安全的那一侧（fail-safe）**，
与本仓库 `risk.ts` 的"默认拒绝"、`venv` 凭证的"fail-closed"保持同一哲学。

### ✅ F-16 · `stopAutopilot` 的 scope 曾被硬编码成 `'paper'`（已修）

**历史缺陷**（修正前）：
```ts
// server/autopilot.ts（旧）
appendEvent('AUTOPILOT_STOPPED', { scope: 'paper', reason })
```

即使自治跑在 live 模式，停止事件也会被记成 `scope: 'paper'`。
**后果**：审计链里的"停止"记录与实际模式不符——而审计链的价值就在于**事后不可抵赖地还原发生了什么**。

**当前代码**（`server/autopilot.ts:240`）：
```ts
appendEvent('AUTOPILOT_STOPPED', { scope: isAutopilotLive() ? 'live' : 'paper', reason })
```
（对比：`AUTOPILOT_STARTED` / `AUTOPILOT_FLATTEN` 一直是动态 scope，只有 STOPPED 漏过。）
★ 保留此条的意义：**审计事件里写死的字段，会让"事后还原"这件事悄悄失真**——
这类错不会报错、不会有测试抓到，只会在某次复盘时给出错误结论。

### 🐛 F-17 · pinned 策略跳过适应度门（设计如此，但必须知道）

```ts
// server/autopilot.ts:232 —— AUTOPILOT_PINNED_STRATEGY 命中时
return { ok: true, id: `…`, strategy: s, fitness: 0, fitnessVersion: 'pinned' }
```

**这是刻意的**：live 实测时需要"锁定一条已验证策略"，不让网格选优中途换策略。
但要注意两点联动风险：
1. `fitnessVersion: 'pinned'` 会让 `assertFitnessVersion()` 无法比对——晋升门禁对 pinned 策略**形同虚设**；
2. 与 F-15 叠加时风险仍在：`AUTOPILOT_LIVE` 的**代码默认值**已修正为 paper（fail-safe），
   但**本机 `.env` 显式开了 live** —— 于是"未经适应度验证的策略 + 实盘路径"这个组合依然成立。
   （注意区分：修好的是默认值，没修的是你这台机器的显式配置。）

**纪律**：pinned 只能用于**已人工走完晋升链**的策略；不要用它来绕过门禁。

### ✅ F-18 · `npm run lint` 曾经是全红的（14 errors，同日已清零）

**历史缺陷**（2026-09-12 上午复检时）`npm run lint` 失败，**14 个 error**，分布在 9 个文件：

| 文件 | 错误 |
|---|---|
| `src/pages/MonitorPage.tsx` | 3 个未使用导入 + **`react-hooks/refs` 违规**（即 F-19）|
| `server/autopilot.ts` | `prefer-const`、`no-useless-assignment` |
| `server/persistence.ts` | `no-useless-assignment` |
| `server/proposals.ts` | 2 个未使用变量 |
| `server/llmProviders.ts` / `loadEnv.ts` | `prefer-const` |
| `src/components/KpiDrilldown.tsx` | 未使用 `useState` |
| `src/components/LiquidityHeatmap.tsx` | 未使用 `max` |
| `scripts/okx-buy-test.ts` | 未使用 `rawBal` |

**现状（同日已清零）**：`npm run lint` 退出码 0。

★ **保留此条的意义不在"当时红了"，而在它的两个结构性教训**：

1. **lint 是 `npm run ci` 的第一道门**——它一红，后面 17 道**根本跑不到**。
   一个"排在最前面的门坏了"，等于整套门禁形同虚设。
2. **`npm run typecheck` 当实测是绿的**。所以这类问题**开发时不会暴露**：
   `npm run build` 里 `tsc` 先过，`eslint` 是独立一步。
   **推论：lint 与 typecheck 必须都进 CI，不能只留一个。**

### ✅ F-19 · `useInterval` 曾在 render 期间写 ref（已修）

**历史缺陷**（违规写法）：
```tsx
// src/pages/MonitorPage.tsx（旧）
function useInterval(cb: () => void, ms: number) {
  const ref = React.useRef(cb)
  ref.current = cb              // ← 在 render 期写 ref，react-hooks/refs 报错
  React.useEffect(() => {
    const id = setInterval(() => ref.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}
```

**当前代码**（`src/pages/MonitorPage.tsx:16-24`，已与 `DecisionBrainPage.tsx` 的写法对齐）：
```tsx
function useInterval(cb: () => void, ms: number) {
  const ref = React.useRef(cb)
  React.useEffect(() => { ref.current = cb }, [cb])   // ← 放进 effect
  React.useEffect(() => {
    const id = setInterval(() => ref.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}
```
★ 这是本仓库的**复发型坑**：换页写轮询 hook 时，很容易把旧写法复制粘贴回去。
`react-hooks/refs` 规则能抓到它——**所以这条 lint 规则不要关**。

### 🐛 F-20 · 三仪表盘整链不可达（实测 **11 文件 / 526 行**，非「3 个容器约 500 行」）

**实测（2026-09-12 复检）**：以 `grep -rl <组件名> src/` 统计引用数，结论是**两层**的：

| 层 | 文件 | 行数 | 状态 |
|---|---|---|---|
| **根容器（零引用）** | `FlowDashboard` / `StyleDashboard` / `VerdictDashboard` | 31 + 30 + 22 = **83** | **没有任何 `import`，也没有任何 JSX 使用** |
| **叶子（仅被上述死容器引用）** | `CapitalFlow` / `RiskMeter` / `LiquidityHeatmap` / `FactorTable` / `DecayChart` / `PurityHeatmap` / `RiskHeader` / `EvidencePanel` | **443** | 自身有引用，但引用者不可达 → **不可达** |
| **合计** | **11 个文件** | **526** | 整体不可达 |

⚠️ **本条曾有两处失准**（复检时一并纠正）：
1. 旧描述写「**被导入**但从未渲染」——实测**连 import 都没有**（`MonitorPage.tsx:5-7` 早已不再导入）。
2. 旧描述写「三仪表盘容器（约 500 行）」——3 个容器只有 **83 行**；
   约 500 行这个量级其实来自**连带叶子**（443 行）。数字对上了，**归因错了**。

★ **不要一起删的两个组件**：`KpiTrend` / `KpiDrilldown` 被 **live** 的 `KpiRow` 引用
（`KpiRow` ← `MonitorPage`），**它们是活的**。旧版本把这两个也列进了"无法到达"名单，是错的。

**为什么会这样**：这些是纯展示组件（props 驱动），骨架搭好了但没接数据源。
**判断**：属**半成品而非死代码**。复现时可跳过，或按 B2 的数据契约接线。
若确定不做，删除单位是**整个 11 文件子图**——只删 3 个容器会留下一堆悬挂叶子。

**正确的组件层次**（`✅` 可达 / `❌` 不可达）：
```
MonitorPage
 └─ ✅ KpiRow → KpiTrend / KpiDrilldown            (指标卡 + 迷你走势 + 下钻)
 └─ ❌ FlowDashboard  → CapitalFlow / RiskMeter / LiquidityHeatmap   (资金流/风险/流动性)
 └─ ❌ StyleDashboard → FactorTable / DecayChart / PurityHeatmap     (因子/衰减/相关性)
 └─ ❌ VerdictDashboard → RiskHeader / EvidencePanel                (风险等级/证据链)
```

### 🐛 F-21 · 文档与代码的漂移（元问题，两轮复检累计）

这是**元问题**：同一事实在多份文档中被分别陈述，必然漂移。

**第一轮（2026-09-12 上午，收敛前）** —— 当时仓库有 **9 份**文档：

| 事实 | 文档说法 | 代码实测 | 出处 |
|---|---|---|---|
| 编排服务位置 | "不在本仓库，只含 HTTP 客户端" | **在仓库内** `server/`（8873 行） | v1 B1 / D3 |
| Vite 版本 | `^5.3.4` | **`^8.2.2`**（rolldown 内核） | v1 B3 |
| CI 门禁数 | "十三道" / "14 道" | **18 道**（当时值；2026-09-17 已增至 **28 道**，以 Part I 为准） | DEV_PROGRESS |
| fitness 版本 | `fitness-v1`（DEV_PROGRESS E1/B5/源码图） | **`fitness-v2`** | DEV_PROGRESS |
| 后端 fitness 版本 | "仍是 fitness-v1，前后端漂移" | **已随共享常量修好**（`pipelineService` 引用 `DEFAULT_PIPELINE_CONFIG`，后者 = `FITNESS_VERSION`） | v1 F-1 |
| 编排服务端口 | `8787` | devStack 与前端实际用 **8790** | PROD_PROMPT_KIT |
| GitHub CI | — | **只跑 5 道**，与本地 `npm run ci`（现 28 道）不一致 | `.github/workflows/ci.yml` |

**第一轮对策**：文档从 **9 份收敛到 5 份**，每个事实只保留一个权威出处（见 Part J）。

**⚠️ 第二轮（2026-09-12 收尾复检）—— 收敛动作本身又产生了 5 类漂移**：

| 类型 | 实情 | 处置 |
|---|---|---|
| **状态过期（最严重）** | 文档把**当轮已修**的 F-15 / F-16 / F-18 / F-19 继续记为「待修 / 待决」，跨 3 份文档多处 | 全部改为「已修 + 保留历史原文」，并**分开记代码层 / 部署层** |
| **结构性重复** | `DEV_PROGRESS.md` 的 §4~§7 **整块出现两次**（412 行 → 293 行）| 删重复块；旧块中唯一未被覆盖的待办**先并入再删** |
| **规模过期** | `server/` 写 30 文件 / 4623 行、`index.ts` 670 行 | 实为 **35 / 8873**、**1139** |
| **端点数过期** | 写 32 个端点 | 实为 **59**（55 精确匹配 + 4 前缀路由）|
| **归因错误** | 「三仪表盘容器（约 500 行）」 | 3 容器仅 **83 行**；真正的不可达集合是 **11 文件 / 526 行**（含 8 个叶子）。**数字对、归因错** |

★ **两轮合并后的教训（比第一轮更狠）**：

1. 多文档并行维护时，"同一事实多处陈述"必然漂移 → **收敛是必要的**。
2. 但**收敛动作本身也会产生漂移**——因为写新文档时，很容易沿用旧清单的结论。
   **所以每次「梳理项目 / 完善文档」的收尾，都必须留一道独立的漂移审计**；
   判据是**运行时行为**，不是任何一份清单，也不是"我刚读过"。
3. **「已修」与「未修」必须分开、且都要写全**：只写「✅ 已修」会漏掉残留的部署层风险
   （见 F-15：代码默认值已 fail-safe，但本机 `.env` 仍显式开着实盘）。

### 🐛 F-22 · `.env` 用裸 `writeFileSync` 写盘（已修复）

**现象**：`server/loadEnv.ts` 的 `updateDotEnv` 直接 `writeFileSync(path, ...)`。
它是「先截断、再写入」，中间存在**文件已清空但新内容未落盘**的窗口。
两种现实情况会命中：进程被 kill（热重启 / CI 超时 / 容器 OOM）；磁盘写满返回 `ENOSPC`。

**后果的严重性被低估**：被写坏的若是 `.env`，不是「丢一次配置」，
而是**全部风控参数回落到代码默认值**——引擎将以用户从未批准过的敞口运行，
而面板显示的仍是上一次成功读取的值。**这类「配置静默降级」比崩溃更难排查。**

**正确写法**（`server/atomicWrite.ts`）：同目录临时文件 → `write` → `fsync` → `rename` 覆盖。
- `fsync` 不可省略：只 rename 不 fsync，操作系统可能把 rename 元数据**先于**文件内容刷盘，断电后得到长度为 0 的文件。
- 临时文件名带 `pid + 时间戳 + 随机后缀`：同进程并发写、多进程共存都不互踩。
- **失败路径必须清理临时文件**，否则崩溃循环会留下一地 `.xxx.tmp`。

★ **原则**：**所有配置类文件与账本类文件一律原子写盘。** 没有任何例外——
这类文件的特殊性在于「写坏」比「写不上」后果更严重。

### 🐛 F-23 · 「本地追踪器丢了」被当作「场所也没有」（已修复）

这是 `LEDGER_MISMATCH` 的**成因 A**，也是最容易凭直觉搞反的一条。

**错误直觉**：「下单都失败了，当然没建仓，赶紧把额度还回去。」
**真实情况**：额度被还回去、下一轮又开一次，而第一次的订单**可能已经在场所侧成交了**。

**两类失败必须区分对待**：

| 失败类型 | 场所侧状态 | 正确处理 |
|---|---|---|
| 明确拒绝（`BROKER_REJECTED` / `INSUFFICIENT_BALANCE` / `NOTIONAL_EXCEEDS_LIMIT` / 参数非法）| 确定未成立 | 释放预算（`rejected`）|
| 基础设施失败（`NO_ADAPTER` / `HANDSHAKE_INCOMPLETE` / 超时 / 限流）| **未知** | **继续占用**（`unknown`），绝不释放 |

**落地形态**：`server/riskReservation.ts`。四条不可动摇的语义：
1. `confirmed` **仍占用**——确认成交到平仓之间风险依然真实，提前释放会让后续开仓重复计入；
2. `unknown` **全额占用，绝不释放**；`recoverOrphans()` **只标记 `pending_cleanup` 不自动释放**，
   等对账器拿到场所侧确定结论再显式释放；
3. 终态**幂等不可复活**——已释放的意图再提交，原样返回不改写；
4. 越界**整体回滚，绝不部分占用**。

**接线顺序必须是「预留先行 → 发单 → 按回执推进」**：发单前落账，
崩溃重启后 `recoverOrphans()` 仍能找到这笔未知敞口。
反过来（先发单后落账）会出现一个**既没有场所回执、也没有本地记录的敞口**——那才是真正无法对账的黑洞。

★ **顺带发现的同类问题（成因 B）**：`flatten()` 曾把单笔数量截断后无条件把 `apPosQty` 置 0，
造成「本地以为空了、账上还有货」。已改为按单笔上限切片多次提交，只有全部成交才清零。
**部分平仓时预留不释放**——剩余那一截依然是真实敞口。

★ **反直觉但必须记住**：**风控层自身的异常必须留痕，不能静默吞掉。**
`AUTOPILOT_RESERVATION_ERROR` 这个事件类型的存在意义就是——
宁可让日志里多一条错误，也不要让一个「预留没写进去」被当作「预留通过」。
**静默失败比越界更危险，因为它让你以为自己还在风控之内。**

---

### 🐛 F-24 · `map.get(key) ?? 0` 把「从没出现过」读成「上次是 epoch 0」（已修复，**同型错误连犯两次**）

语音层落地时被烟测抓出的**真实生产缺陷**，出现在两个独立模块里，代码形状完全一样。

**错误写法**：
```ts
const prev = dedupeAt.get(key) ?? 0
if (now - prev < COOLDOWN_MS) return null   // 压制
```
**后果**：一个**从未出现过的键**被读成"上次播报发生在 epoch 0"。
于是冷却判定变成 `now - 0 < COOLDOWN_MS`，即 `now < COOLDOWN_MS` ——
**只要时间基准小于冷却窗长，新键的首次播报就被吃掉**。
两个受害点：
- `server/voice/narrator.ts` 的 `dedupeAt`（冷却窗 30s）⇒ 新播报首播被误压制；
- `server/voice/anomaly.ts` 的 `lastHitAt`（冷却窗 180s）⇒ 异动首报被误压制。

**为什么它在生产里几乎看不见**：`Date.now()` ≈ 1.7e12，远大于冷却窗，
`now - 0 < COOLDOWN_MS` 恒为假 —— **缺陷只在"时间基准较小"的输入下暴露**。
而恰好只有能喂小时间戳的烟测会走到那一支。
这与 F-41（"在产品路径上永不触发的检查"）是同一枚硬币的两面：
**一边是检查永远不响，另一边是缺陷永远不显形。**

**正确写法（用 `has()` 把"缺席"与"值为 0"分开）**：
```ts
const prev = dedupeAt.get(key)
if (prev !== undefined && now - prev < COOLDOWN_MS) return null
```
两处修复处都留了注释，写明"这个坑在本模块和 narrator 里各出现了一次"。

★ **可复用的教训（建议写进所有审查）**：
1. **凡是拿数值当"没有值"的哨兵，都要问一句"这个数值在本语义域里合法吗"。**
   时间戳、价格、数量这三类值域里，`0` 全都合法 ⇒ 一律改用 `has()` / `undefined`。
2. **烟测要能喂小时间戳，不要只用 `Date.now()`。** 用真实墙上时钟会把这类缺陷
   推进一个"看起来只是偶发"的区间（这里干脆是永不发生）；参数化的时间基准
   是让它现形的唯一办法。
3. **同一形状的代码要跨模块搜一遍。** 发现一处 `?? 0` 冷却判定后，
   应在全仓搜同类模式 —— 本轮就是这么找到第二处的（两处同在语音层，
   但没有任何机制保证它不会在别处再犯）。

**同一轮被 lint 拦下的三处"渲染期写 ref"**（`react-hooks/refs`）：
`src/voice/client.ts` 的 `handlersRef` / `linesRef` / `statusRef` 都写成
`useRef(x)` + `ref.current = x`。这不是风格问题：并发渲染下渲染期写入会被丢弃或重放，
拿到的回调可能是上一轮的。统一改为 `useEffect(() => { ref.current = x })`。
（F-19 已在 `useInterval` 上踩过一次 —— **这是同型问题的第二次**，说明"新代码里也容易再犯"。）

---

# Part G · 验收清单

复现完成后，逐项打勾：

**构建与启动**
- [ ] `npm run build`（`tsc && vite build`）零错误通过
- [ ] `npm run preview -- --port 4173` 可访问，标题为「EVOLVE · Web4.0 自进化高频量化交易系统」

**L1 行情**
- [ ] 顶栏出现「LIVE」徽章，toast 提示"已接入 Binance 实时行情"
- [ ] 价格每 1~2 秒跳动（非随机数），与 Binance 官网一致
- [ ] 断网后自动降级为模拟引擎并 toast 提示，恢复后自动重连

**L2 钱包**
- [ ] 连接钱包后显示地址 `0xf39F…2266` 格式与链标识
- [ ] ETH 主网余额正确显示
- [ ] 切换到 Base/Arbitrum 等链，USDC 余额正确（注意 6 位小数）
- [ ] 断开连接后 UI 回到未连接态

**L3 DEX**
- [ ] DEX 面板显示 Uniswap V3 路由与费率档位
- [ ] 买入 3000 USDC → 报价约 0.8 ETH（数量级正确，**不是** 2980 ETH）
- [ ] 切换到 BNB Chain 时提示"当前链暂不支持 DEX 路由"
- [ ] 「模拟执行」在 SIM 模式下也能返回"✅ 模拟通过"
- [ ] 「执行」按钮在非 LIVE 模式 disabled，提示"🔒 LIVE 才可签名"
- [ ] 切换到 LIVE 后按钮解锁（但不要真的签名，除非你愿意花 gas）

**L4 进化**
- [ ] Evo 页面可跑 `evaluateCandidateGrid`，返回 20 个候选按 fitness 降序
- [ ] 精英榜 fitness 数值在合理区间（-100 ~ 200）
- [ ] 变异沙箱提交模板代码能返回结果（需编排服务在线）
- [ ] ✅ 晋升流水线 backtest 门不再抛 `FITNESS_VERSION_MISMATCH`（F-1 已修，前后端统一 `fitness-v2`）

**L6 编排服务**
- [ ] `npm run stack` 三进程起来：ledger:8791 + orch:8790 + vite
- [ ] `GET /healthz` 返回 `{ok:true, uptimeSec, killswitch, mode}`
- [ ] `GET /state` 返回余额/权益/持仓/风控参数
- [ ] `GET /events?since=0` 有事件且 seq 单调
- [ ] 下单触发风控拒单时，`ORDER_REJECT` 事件的 reason 是**可读的具名原因**（不是裸 500）
- [ ] `POST /killswitch` 激活后：本地订单被撤 + `gateway.status().killswitch === true`
- [ ] `GET /audit/verify` 校验通过；**注入一条篡改后能报出断点 seq**
- [ ] `GET /metrics` 有 ACK 分位与拒绝原因 Top5
- [ ] `POST /autopilot/start {"targetPct":2}` 后 `stage` 依次经过 accumulating → optimizing → trading
- [ ] `GET /llm/providers` 能列出 provider；未启用时提案器降级为确定性且 `llmUsed:false`
- [ ] 沙箱三场景：良性通过 / 网络探针 BLOCKED / 死循环被击杀
- [ ] 重启进程后事件流能续、审计链仍可校验（验证持久化）

**验证层**
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过（F-18 的 14 errors 已于 2026-09-12 清零）
- [ ] `npm run ci` 全绿 —— ⚠️ **必须逐道实跑**：CI 是 `&&` 短路链，
      所以「跑一次 ci 看有没有报错」**不足以**证明门禁全绿——它会在第一道红处就停。
      本项不是假想风险：2026-09-12~09-13 曾长期存在 `test:sandbox` / `test:autopilot` /
      `backtest:golden` **三道红**，`ci` 每次都在第一道红处停下，后面十几道从未被执行，
      而"跑 ci 没报错"的观感与全绿**完全一样**（见 `DEV_PROGRESS.md` §3.6）。
      当前（2026-09-16 建立 · 2026-09-17 复跑）**28 道逐道实跑全绿**。
- [ ] 涉及执行/风控/账本的改动，对应 smoke 已跑

**安全**
- [ ] 刷新页面后 LIVE 模式降级为 PAPER
- [ ] SIM/PAPER 余额旁有明确的虚拟资金标注
- [ ] `NODE_ENV=production` 且无 `ORCH_TOKEN` 时服务**拒绝启动**
- [ ] `VENUE` 凭证缺失时适配器**不挂载**（而不是挂载一个必然失败的假适配器）
- [ ] 确认 `.env` 中 `AUTOPILOT_LIVE` 的值**就是你要的**（默认 `false`=paper；`true`=真实资金出站，见 F-15）

---

# Part H · 编排服务层复现提示词（L6）

> 这是 v1 完全缺失的一层，也是**本系统真正区别于"交易演示页面"的地方**。
> 合计 35 个文件 / 8873 行。实现顺序建议：L6.1 → L6.2 → L6.3 → L6.4 → L6.6 → L6.5 → L6.7 → L6.8 → L6.9。

## L6.0 · 为什么必须独立成服务（先想清楚再动手）

```text
在写代码之前，先理解为什么这些能力不能放在浏览器里：

1. 浏览器不可信：用户可改内存、可改 localStorage、可劫持 fetch。风控若在浏览器执行，等于没有风控。
2. 密钥不能进浏览器：交易所 API secret 一旦下发到前端，等同于泄漏。
3. 账本必须单一权威：多个客户端各自维护状态必然分叉，必须有服务端权威账本 + 事件溯源。
4. 审计必须不可抵赖：留痕若在客户端产生，用户可以删改。
5. 降级必须 fail-closed：前端可以白屏降级，资金路径不能"降级放行"。

结论：控制面只做「只读订阅 + 审批操作」，一切资金路径都在编排服务内，且经过 风控 → 晋升闸 → 网关 三道。
```

## L6.1 · 骨架、鉴权与生产 fail-closed

```text
用 node:http 手写编排服务骨架（不引入 Express/Fastify），要求：

1. 路由：`new URL(req.url, base)` 解析路径，用 if 链分发（约 60 个端点）。
   统一 `json(res, code, body)` helper，显式设置 content-type 与 content-length。
2. 鉴权：`authorized(req) => req.headers['x-orch-token'] === TOKEN`。
   所有写操作（POST/DELETE）前置校验，失败返回 401。GET 里 /healthz /state 可免鉴权。
3. CORS：`ORCH_ALLOWED_ORIGIN` 可配（默认 `*` 仅限本地），允许头必须含 content-type 与 x-orch-token，
   并正确响应 OPTIONS 204。
4. ★ 生产 fail-closed：NODE_ENV=production 且未设置 ORCH_TOKEN（或仍为 dev-insecure-token）时
   `console.error` + `process.exit(1)`，拒绝启动。密钥缺失绝不允许"以默认值凑合跑"。
5. 顶部 loadDotEnv() 加载 .env；启动时打印 port/mode/venue 概要。
6. 全局 try/catch 包住整个 handler，异常返回 500 JSON 而不是让进程崩溃。
7. 起两个服务：HTTP + WebSocketServer（同端口），WS 用于向前端推送事件。
```

## L6.2 · 风控闸（默认拒绝）

```text
实现 server/risk.ts 的 preTradeCheck(state, intent, markPrice): RiskDecision。

★ 核心哲学：默认拒绝。函数返回 {ok:true, notional} 或 {ok:false, reason}，绝无"放行"的隐含默认。

检查顺序（顺序本身就是安全设计，不可调换）：
1. killswitch 已激活 → KILLSWITCH_ACTIVE
2. clientOrderId 为空 → MISSING_CLIENT_ORDER_ID
3. qty 非法（非有限数或 ≤0）→ INVALID_QTY
4. 限价单缺有效 price → LIMIT_REQUIRES_PRICE
5. 名义金额超单笔上限 → `NOTIONAL_EXCEEDS_LIMIT (实际 > 上限)`   ← 报错串要带两个数字，便于 UI 解释
6. 价格偏离 bps 超限 → `PRICE_DEVIATION_TOO_WIDE (Nbps)`
7. ★ 回撤熔断（必须在频控之前）：ddPct ≥ maxDrawdownPct → 置 killswitch 并返回
   `DRAWDOWN_BREAKER (x% >= y%) · KILLSWITCH ENGAGED`
8. 频控：60 秒窗口内订单数超上限 → ORDER_RATE_EXCEEDED

另外实现：
- `currentEquity(state)` = 现金 + Σ(持仓数量 × 最新价)
- `updateRiskConfig(state, patch)` 浅合并风控参数（供运行时端点调用）

★ 为什么熔断要在频控前：频控拒绝是"限流"，熔断拒绝是"止血"。若顺序颠倒，
  高频下单场景下会一直返回 ORDER_RATE_EXCEEDED，把爆仓信号掩盖掉。
```

## L6.3 · 执行网关（live 出站唯一通道）

```text
实现 server/gateway/executor.ts 的 ExecutionGateway 单例。

状态字段：adapter / handshake / killswitchActive / venueStopReason /
          seenClientIds / seenEconomicFills / processedFills / drainedDuplicates / queueDepth

submit(intent) 的检查链（顺序不可换，每一步都是独立防线）：
1. intent.mode !== 'live' → GATEWAY_ACCEPTS_LIVE_INTENTS_ONLY
2. !handshake → HANDSHAKE_INCOMPLETE      （风控握手未完成，禁止出站）
3. !adapter → NO_ADAPTER_ATTACHED
4. killswitchActive → KILLSWITCH_ACTIVE
5. venueStopReason !== null → `VENUE_OUTBOUND_DISABLED:${reason}`
6. seenClientIds 已含该 id → DUPLICATE_CLIENT_ID   （幂等，防重复下单）
通过后：登记 id → queueDepth++ → adapter.place() → finally queueDepth--

关键方法：
- attachAdapter(a)：挂载时注册 a.onFill 回调
- completeRiskHandshake()：由启动流程在风控就绪后调用
- setVenueOutboundDisabled(reason|null)：★ 区别于全局 killswitch 的"venue 级闸"，
  对账失配自动触发，需人工清除
- handleVenueFill(f)：★ 经济性去重——key = `${venueOrderId}|${side}|${price}|${qty}`，
  重复则 drainedDuplicates++ 并丢弃（交易所回报可能重复推送同一笔成交）
- cancelAllAtVenue()：撤单风暴，最多 20 轮循环直到 openOrderIds 为空；
  仍有残留则返回 -1 表示"未撤干净"，这个 -1 必须有调用方处理
- reconcileAgainstVenue() / venueSnapshot() / venueCash()

★ 设计要点：网关是"最后一道物理闸"。任何绕过它的直连下单都是架构违规。
```

## L6.4 · 场所适配器（VenueAdapter 契约）

```text
定义统一契约 server/venue/types.ts：

export interface VenueAdapter {
  readonly name: string
  place(intent: VenueIntent): Promise<{ venueOrderId: string }>
  cancel(venueOrderId: string): Promise<boolean>
  onFill(cb: (f: VenueFill) => void): void
  reconcile(): Promise<BalanceSnapshot>
  openOrderIds(): string[] | Promise<string[]>
}
// VenueFill: { fillId, venueOrderId, clientOrderId, symbol, side, price, qty, ts }
// BalanceSnapshot: { cash, positions[], totalFills }

实现三个适配器：
1. sandbox（默认）：故障注入沙盒，无外部副作用。用于 CI 与开发。
2. cex-testnet：Binance 现货测试网。HMAC-SHA256 签名，凭证缺失则 ★ fail-closed 不挂载
   （而不是挂载一个"下单必然失败"的假适配器）。
3. okx-testnet：OKX 测试网，含杠杆/全仓保证金路径（cross + lever + ccy 下单格式）。

★ 复现顺序建议：先 sandbox 跑通全链路，再接 testnet。不要一上手就接真实交易所。
```

## L6.5 · 晋升内禁（live 的资金闸）

```text
实现 server/pipelineService.ts，把 src/engine/promotion.ts 的状态机接到执行路径上。

★ 核心不变量：live 订单意图必须携带「已晋升到 small_cap_live 或 full_live 阶段的策略身份」。

authorizeLive(strategyId, notional): LiveAuth
  1. 缺 strategyId → LIVE_REQUIRES_STRATEGY_ID
  2. 查不到记录 → `STRATEGY_UNKNOWN:${id}`
  3. stage 不是 small_cap_live/full_live → `STRATEGY_NOT_AUTHORIZED_FOR_LIVE:${stage}`
  4. 单笔超帽 → `STRATEGY_CAP_ORDER_EXCEEDS (x > cap)`
  5. 累计 + 本笔超帽 → `STRATEGY_CAP_EXCEEDED (a+b > cap)`
  cap 取值优先级：AUTOPILOT_LIVE_CAP_USD > 策略记录 capUsd > DEFAULT_PIPELINE_CONFIG.smallCapUsd

持久化要求：
- 存储格式 v2：{ v: 2, record: StrategyRecord, liveNotional: number }
- ★ 必须兼容 v1（裸 StrategyRecord），否则升级后历史记录全丢
- 启动时 restore() 全部记录，并打印恢复条数与流水线版本
- 每次状态变更 → persist() → 同时 appendEvent('PROMOTION_STAGE', …)
- recordLiveSubmitted() 只在 gateway 接受意图后调用（否则会把被拒的单也计入额度）

★ 注意：full_live 的自动放量刻意未开放，必须人工 approve。这是产品决策不是 bug。
```

## L6.6 · 账本、审计哈希链与持久化

```text
三层递进实现：

【第一层】追加写事件账本 server/ledger.ts
- 内存事件数组，seq 单调递增
- appendEvent(kind, payload) → 记录 { seq, ts, kind, payload }
- getEvents(since) 支持游标增量查询

【第二层】SHA-256 审计哈希链 server/audit.ts
- 每个事件 hash = H(prevHash | seq | ts | kind | payload)
- 创世事件锚定（prevHash 为固定初值）
- ★ 内存链与 SQLite 链独立校验（双链互查），篡改要能精确报告断点 seq
- 提供 GET /audit/verify 返回校验结果
- 烟测必须包含"注入篡改后能定位断点"的用例

【第三层】持久化 server/persistence.ts
- node:sqlite 开 WAL 模式，表：events / snapshots / audit_chain / proposals / promotions
- ★ 单实例租约：claimInstance() / heartbeatInstance() / releaseInstance()
  防止两个进程同时写同一个 DB 造成账本分叉
- queryEvents(since) 从 SQLite 读，实现事件流的重启可续
- 非持久模式（未配 DB）要能优雅退化到纯内存

【保留策略】server/retention.ts
- 默认 90 天；★ 先归档成 JSONL 再清理（先归档后删除，顺序不能反）
- ORCH_RETENTION_DAYS=0 时关闭清理

★ 复现时的验收：杀掉进程重启后，事件流能接着上次的 seq 继续，且审计链校验通过。
```

## L6.7 · 自治循环与 LLM 提案器

```text
【Autopilot】server/autopilot.ts —— 状态机
状态：idle → accumulating → optimizing → trading → (target_reached | drawdown_stopped)
1. startAutopilot(targetPct)：校验 0 < target ≤ 50、防重入、killswitch 拒绝；
   记录 baselineEquity；★ 预热历史 K 线（拉 200 根 1m，越过 MIN_BARS=120，
   否则要等两小时才能开始交易——这个"预热"极大改善首次体验）
2. onAutopilotBar(candle)：每根收盘 K 线驱动一次
   - ★ 硬性回撤保护先于一切目标逻辑：pnlPct ≤ -10% → flatten + 停机
   - 达标止盈：stage=trading 且 pnlPct ≥ targetPct → flatten + target_reached
   - 累积够 MIN_BARS → optimize() 选优 → trading
   - trading 中 → tradeBar()
3. optimize()：★ F-47 起样本内选优必须过过拟合门，否则拒绝并留在 accumulating
   a. evaluateCandidateGrid() 取第一（纯样本内选择，天然偏乐观）
   b. rebuildStrategy() 重建实例
   c. ★ runOverfitGate()：对**同一批 candles**跑 walkForward()（CSCV-PBO + 冠军
      样本外分位 + 选择净收益），再交 judgeOverfit(DEFAULT_OVERFIT_THRESHOLDS)
      —— 关键是"选优与检验用同一数据集"，绝不可换成读 data/history 的另一套口径
   d. PASS → 写 AUTOPILOT_OVERFIT_GATE 放行；非 PASS → 写 AUTOPILOT_OPTIMIZE_REFUSED
      + AUTOPILOT_OVERFIT_GATE，回 accumulating，gateRetryAtBars = 当前根数 + 60
      （★ 拒绝不关机：UNVERIFIABLE 是"证据不足"而非"永不可行"，每 60 根重试一次，
        避免每根都跑一遍 walkForward 的秒级同步开销）
   e. gateRefusal 暴露到 GET /autopilot 供前端展示；pin 路径显式旁路并记
      overfitGate='bypassed-by-pin'（人工钉住的策略不参与自动门）
   ★ 再在全部数据上重跑一次复核 fitness 仍为有限值（防过拟合快照漂移）
4. tradeBar()：买卖数量计算要区分——
   卖出只平机器人自己的持仓（apPosQty），★ 绝不卖整仓（会误伤用户持仓且被风控拦）
5. flatten(reason)：平仓并向账本记 AUTOPILOT_FLATTEN

【LLM 提案器】server/proposalEngine.ts + proposals.ts
- ★ 结构性隔离：提案器没有任何下单通路，唯一出口是 candidate 阶段
- 无 LLM 时确定性降级（网格搜索），有 LLM 时产出结构化提案
- callLlm() 必须做输出兜底：模型返回的 proposalId / targetStrategyId 可能含中文或非法字符，
  ★ 不信任模型输出——由引擎强制 sanitize 成 [A-Za-z0-9._:-]{8,80}
- validateProposal() 做边界校验，畸形提案四类拒绝用例要进 CI
- getActiveLlm() 返回 enabled 且配置了 activeModel 的 provider，否则 null → 降级

【多模型适配器】server/llmProviders.ts
- provider 字段：name / baseUrl / flavor(openai|anthropic) / models[] / activeModel / enabled
- 支持 probe（连通性 + key 校验，返回可用模型列表）
★ 实测坑：chatComplete 超时若设得太短（如 15s），免费模型会超时后**静默降级成确定性引擎**，
  表现为"LLM 配好了却不参与"。建议 ≥90s，且失败必须留痕（console.warn 打印 HTTP 状态与响应体），
  否则你永远不知道它为什么没工作。
```

## L6.8 · 可观测、对账与合规监控

```text
【SLO 度量】server/metrics.ts + slo.ts
- 记录：ACK 延迟（算 P50/P95/P99/max）、拒绝原因计数（取 Top5 归因）、
  paper/live 成交数、撤单数、熔断次数、行情新鲜度（最后一个 bar 距今多久）
- GET /metrics 返回全量；GET /slo 返回三项目标达标评估
- 告警通道：webhook + ★ 冷却去重（同一告警在冷却窗口内只发一次，否则会告警风暴）

【对账】server/reconciliation.ts + mirrorCheck.ts
- runReconciliation()：比对本地账本与 venue 快照（现金 + 逐币持仓）
- 不一致 → ★ 置 venueOutboundDisabledReason='LEDGER_MISMATCH'，冻结出站
- GET /reconciliation 看最近结果；POST /reconciliation/run 手动触发
- ★ POST /reconciliation/sync-venue：把本地账本重写为 venue 真实余额并解除闸门
  （这是账本失配的唯一正解；实测对账差异是"零成交"的常见根因）
- 镜像互查：内存链 vs 持久链事件对比，确认无丢失

【操纵自监控】server/surveillance.ts（合规 C8）
- SELF_TRADE：同账户对向成交价差 ≤5bps / 60s 窗口 → 标记
- ORDER_CHURN：5 分钟窗口内撤单率 ≥0.8 且提交 ≥20 → 标记
- 全部标记落审计账本
★ 注意：这是"对客前"的合规能力，当前单账户内部运行用不上，但必须提前具备。
```

## L6.9 · 变异沙箱（进程级隔离）

```text
实现 server/sandbox/{index,worker}.ts：在隔离子进程中评估用户策略代码（⚠️ 网络隔离曾声称已做，**实测未生效**，见 `DEV_PROGRESS.md` §3.6.1）。

- 用 Node Permission Model 启动子进程：受限文件系统（⚠️ 当前 `--allow-fs-read=<项目根>` **过宽**，应收窄到具体子目录）、脱敏环境变量
- ⚠️ **不要以为 `--permission` 会顺带断网**：Node 22 的权限模型不含网络维度
- 超时 SIGKILL（实测：死循环 3s 内被杀）
- 返回值携带 fitness 与 fitnessVersion（**从引擎动态取，不要硬编码版本**）
- POST /sandbox/evaluate 暴露

★ 冒烟必须覆盖三个场景（缺一不可）：
  ① 良性回测代码 → 正常返回结果
  ② 网络探针代码 → 被 BLOCKED
  ③ 死循环代码 → 超时被杀
★ 残留说明：容器级隔离与资源配额（内存/CPU 限额）属后续加固，
  进程级隔离能挡住"拿密钥/联网外传"，但挡不住"吃满内存"。
```

---

## L6.10 · 延迟预算、阶段边界与非目标

> 合并自原 `PHASE_C_ARCHITECTURE.md` §8/§9.6（该文档其余内容已被 L6.1–L6.9 完整覆盖）。

### 延迟预算（明确不是 HFT 目标）

| 路径 | 目标 | 处理 |
|---|---|---|
| CEX REST ACK | P99 < 500ms | 超预算即告警 |
| DEX 出站（签名 + 广播）| P99 < 5s（链上确认另计）| 超预算即告警 |

★ **超预算即告警，不做微优化。** 微秒级路径属 HFT 独立项目（见 `DEV_PROGRESS.md` 主线三）。
把「性能没达标」当成缺陷去优化，是把工程资源投在错误的目标上——
**本阶段的瓶颈在风控正确性，不在延迟。**

### 本阶段的明确不做（写进提示词，防跑偏）

```text
1. HFT 微秒级路径 —— 独立项目，不在本仓库范围。
2. 多租户 / 计费 / 合规牌照流程 —— 属阶段 D，非当前焦点。
3. 在浏览器进程内增加任何 live 签名能力
   （LIVE 模式的 DEX 手动签名除外，已有门禁隔离）。
```

★ **为什么要把「不做什么」写进提示词**：AI 在长会话中会倾向于「把能做的都做了」。
显式列出非目标，比事后回滚一堆不需要的功能便宜得多。
这三条不是能力限制，是**范围声明**。

---

## L6.11 · 实时语音交互层（V1，2026-09-15）

> 用户诉求：能说话交流的 AI 交易员；多音色可选（默认甜美中文女声）；随时打断；
> 说话就能查仓下单；持续播报"在做什么、下一步做什么"；会读日报、会对重点事件与盘面异动报警。

### L6.11.1 一句话定位（这一节的全部内容都由它推出）

```text
语音不是一条新的交易通道，它是既有编排层的一个新入口。
    麦克风 → ASR → 意图解析 → [既有风控门] → 既有执行路径 → 回话 + 播报
                                  ↑
                    这一格子里不允许出现任何"语音专用的下单实现"
```

**为什么必须先写这句**：语音天然带三个危险属性 ——
① 没有确认对话框，张嘴就是动作；② 识别会错（「两百」与「两千」声学极近）；
③ 用户看不见自己刚才说的到底是什么。
任何一条配上"语音专用的捷径"，它就变成绕过风控的后门 —— 而它偏偏是最好用的那条。

**判据（写代码时反复自问）**：本层只做四件事 —— **解析、确认、转交、播报**，绝不自己碰订单。
若发现需要在本层"自己构造"点什么，说明该动作在既有系统里没有对应实现，
应当先去补那边的实现，而不是在语音层就地造一个。

### L6.11.2 六条必须照抄的设计决定

| # | 决定 | 反例（这样写就是 bug） |
|---|---|---|
| 1 | **意图解析用确定性规则，不用 LLM** | 让 LLM 判断"这句话是不是下单"。温度一变行为就变，CI 无法断言，且无法解释"为什么这句话被听成 200" |
| 2 | **两段式确认按风险分档**（见下表） | 一律要复述 → 用户嫌烦弃用语音，风险被逼回不设防的手动按钮；一律不要 → 实盘上一句含糊的"确认"就放行 |
| 3 | **打断用世代号（generation）作废在途答复** | 只把音箱关掉。用户插完话会先听到**新问题**的答复，中间又被**旧问题**的答复打断一次 |
| 4 | **每条播报带 `sourceSeq` 溯源** | 让自然语言播报无法被机器核验 → "秘书自己编了个状态"这类失效永远查不出来 |
| 5 | **P0 报警不参与任何压制**（静音/档位/去重/限流都不拦它） | 把"静音"实现成 `return` —— 用户以为静音只管闲聊，结果把熔断也一起静了 |
| 6 | **确认强度只能调严，不能调松** | 提供 `confirmPolicy: 'off'`。一个能关掉确认的开关，在压力下（"太烦了"）一定会被关掉，而关掉的那天恰好是出事的那天 |

**两段式确认的分档**（阈值 `CONFIRM_ECHO_NOTIONAL = 50`，取默认 `maxNotionalPerOrder`(500) 的 1/10，
与 surveillance 的 `burstMaxNotionalUsdt` 同值同理由 —— "多少算小额"在本系统里只应有一个数量级直觉）：

| 场景 | 要求 | 理由 |
|---|---|---|
| 仿真 + 名义额 ≤ 50U | 说「确认」即可 | 复述的意义是校验 ASR 有没有听错**数字**，小额仿真听错也不可逆性低 |
| 仿真 + 名义额 > 50U | 必须复述金额（「确认 200」） | 复述同时完成两件事：授权 + 校验识别 |
| **实盘（不论金额）** | 必须复述金额 | 听错数字在实盘上才是不可逆的 |

★ **确认凭证必须由服务端构造，不能采信调用方自报的布尔量。**
`confirmPending(parsedAmount)` **不接受**任何形如 `needsEcho` 的参数 ——
"要不要复述"由服务端从 `slots.live` 与 `expectedNotional` 现推（`echoRequiredFor(p)`）。
本仓库已有 6 次同类翻车（F-33 / F-40 / F-41 / F-44 / F-42 / F-45），全是自报布尔量。

★ **风险分档必须量「钱」，不能量「用户嘴里那个数」。**
`expectedAmount` 是用户念的数，`expectedNotional` 是服务端按实时标记价折算的名义额，
分档只看后者。「买一个比特币」里 `qty=1` 看着无害，实际名义额十万量级 ——
只按 `qty` 分档的话这笔会被判成小额单而免去复核。

### L6.11.3 打断的契约（可断言的性质）

```text
每个轮次开始时记下当时的 generation；
打断时 generation += 1；
答复回来时若 generation 已变 → 丢弃（commitReply 返回 false）。
```

于是「旧答复永不上屏」从一个设计意图变成**一条可断言的性质**：
`test:voice` 的打断用例就是拿这个判据写的 —— **丢弃必须真的发生**，
不能只是"我们打算这么做"（`sessionStatus().droppedReplies` 必须前进）。

打断同时清掉待确认凭证：用户插话通常意味着"等一下，我改主意了"，
留着一个还能用的凭证等于留了一个超时 60 秒的后门。

### L6.11.4 播报优先级与压制顺序

| 级别 | 语义 | 例子 |
|---|---|---|
| `P0_ALARM` | 必须打断一切，**静音也照说** | 熔断、拒单、对账不一致、强异动 |
| `P1_IMPORTANT` | 重要但可排队 | 成交、策略切换、门禁结论、日报 |
| `P2_STATUS` | 工作状态与下一步 | "我在收集样本，下一步等攒够 K 线过门" |
| `P3_MARKET` | 参考信息 | 盘面异动 |

压制链（顺序固定，**P0 全程豁免**）：
`mute → verbosity → dedupe(30s 同键) → rate(每分钟 18 条)`

★ **`dedupe` 与 `anomaly` 的冷却判定曾双双写错**：`map.get(key) ?? 0` 会把
"这个键从没出现过"读成"上次播报时间是 epoch 0" ⇒ 时间差巨大 ⇒ **本次被压制**。
即：**新键第一次出现反而播不出来**。生产环境用 `Date.now()`（~1.7e12）当时间戳时差值巨大，
症状被掩盖；烟测用小时间戳立刻暴露。详见 F-24。

### L6.11.5 播报通道的选择：SSE，不是 WebSocket

`/ws` 已被 2 秒一次的状态广播占用。`ws` 库在**同端口**挂两个带 `path` 的
`WebSocketServer` 会在 `upgrade` 事件上互相摘掉对方的连接（谁先拿到 upgrade 谁处理）。
播报是纯单向的，SSE 语义正好，且不必处理重连升级。

### L6.11.6 采集与合成发生在浏览器（一条必须承认的现实约束）

- **合成**用 `speechSynthesis`。可用音色取决于**操作系统装了哪些语音包** ——
  所以 `VOICE_CATALOG` 里的 `matchNames` 只是**匹配候选**，不是保证。
  真正可用的音色要在运行时用 `getVoices()` 交叉一次，面板上如实显示
  「系统装了 N 个中文音色」，而不是假装目录里 7 个都在。
- 候选全不命中时退到同语种音色，靠 `pitch`/`rate` 拉开区分度 ——
  但那是**同一副嗓子的变形，不是换了一个人**。面板文案必须照实说。
- **识别**用 `SpeechRecognition`（`continuous` + `interimResults`）。
  该接口的 TypeScript 类型至今不在 `lib.dom` 里，需自行声明最小形状；
  **不要图省事写 `any`** —— 一旦写成 `any`，之后所有调用点的字段名写错都不会报错。

★ **回声陷阱**：麦克风会把系统自己的声音收进去。
若"看到中间结果就打断"，助手念长句时会被自己念断（表现为"说了半句突然哑掉"）。
正确做法是让**调用方**做判定（只有它知道合成器正在念哪一句）：
`VoiceSpeaker.currentText` 与中间结果做包含关系判别，且**短指令（<4 字）一律当真** ——
「确认」这类词几乎必然出现在正在念的句子里（"说确认我就执行"），
靠包含关系判别会把真插话一起吃掉。

### L6.11.7 前端接入的三条硬纪律

1. **`dropped` 必须被尊重**（见 D3 的注）。
2. **不在渲染期写 ref**。`handlersRef.current = handlers` 这类写法会被 `react-hooks/refs`
   判为错误，且并发渲染下会丢更新。一律改成 `useEffect(() => { ref.current = x })`。
   （F-19 已在 `useInterval` 上踩过一次，这是第二次。）
3. **波动的配置不要由轮询回写**。播报流与状态轮询每几秒来一次，
   若拿它们回写配置，会把用户正在拖的滑杆拽回去。配置只在显式拉取与写入成功后更新。

### L6.11.8 模块树与规模（实测）

```text
server/voice/
  types.ts       225 行   共享契约（含"语音不是新通道"的文件头声明）
  numerals.ts    240 行   中文数字归一（"一千五"=1500 vs "一千零五"=1005）
  voices.ts      163 行   7 档音色档案 + 自然语言别名（"换个男声"→calm-male-zh）
  intents.ts     300 行   23 个意图的确定性解析；危险动作集合
  session.ts     241 行   generation 打断 + 两段式确认凭证（不接受自报）
  anomaly.ts     219 行   ATR 自适应异动检测（涨幅 / 幅度 / 区间三选二）
  narrator.ts    695 行   播报引擎：分类 → 优先级 → 压制链 → 队列
  service.ts     912 行   转交层：dispatchDangerous → processOrderIntent / processLiveIntent

src/voice/client.ts      757 行   HTTP 契约 + 浏览器 ASR/TTS + SSE
src/pages/VoicePage.tsx  868 行   语音控制台页
scripts/voice-smoke.ts   633 行   11 个场景，全部可失败
```

### L6.11.9 复现这一层时的提示词（可直接粘贴）

```text
为系统加一层实时语音交互，实现「说话就能查仓、下单」，要求：

1. 语音只做四件事：解析、确认、转交、播报。**不得**出现任何"语音专用的下单实现"；
   所有订单必须转交给既有入口（仿真 / 纸面 → processOrderIntent；实盘 → processLiveIntent）。
2. 意图解析用确定性规则，不用 LLM。温度会变的东西不能当门禁。
3. 两段式确认按风险分档：仿真小额说「确认」即可；仿真大额与**所有实盘**必须复述金额。
   确认凭证由服务端构造，"要不要复述"由服务端从 live 与名义额现推，
   绝不接受调用方传入的布尔量。confirmationPolicy 只提供 graded / always，不提供 off。
4. 风险分档量「钱」不量「用户嘴里那个数」：按实时标记价折算名义额后再分档。
5. 打断用世代号：轮次开始记 generation，打断时 +1，答复回来若已变则丢弃。
   丢弃必须是可断言的（计数器要前进），不能只是"设计上如此"。
6. 播报分四档 P0/P1/P2/P3；P0 不参与静音、档位、去重、限流任何一类压制。
   每条播报带账本 sourceSeq，使"每条播报都能在审计链里找到出处"可自动断言。
7. 播报通道用 SSE，不复用已有的 WebSocket 端口。
8. 音色：给出多档目录（默认甜美中文女声），但必须承认可用音色取决于系统语音包 ——
   运行时用 getVoices() 交叉，候选未命中时如实说明"退到同语种音色，是同一副嗓子的变形"。
9. 前端必须尊重 returned.dropped；不得在渲染期写 ref；配置不得由轮询回写。
10. 写一组可失败的烟测（含负向对照），并接进 npm run ci。
```

### L6.11.10 本层的明确不做（V1）

```text
1. 唤醒词（"小助手"）—— 需要常驻监听的功耗与隐私设计，V1 用手动开始/停止聆听。
2. 语音生物识别（声纹/说话人验证）—— 不做"听声音就知道是本人"，那是另一条安全边界。
3. 语音专用风控口径 —— 一切沿用既有风控，不新增阈值。
4. 端到端流式 ASR（本地模型）—— V1 依赖浏览器厂商的在线识别服务，
   离线环境下会失败，面板如实提示并保留文字输入兜底。
```

---

## L6.12 · 悬浮桌宠（桌面外壳层，2026-09-15）

### L6.12.1 一句话定位（这一节的全部内容都由它推出）

```text
桌宠是语音层的**新外壳**，不是新的一层。
    /voice 语音管家页  ─┐
                         ├─→ 既有编排层 /voice/*（一条新 API 都不加）
    /?pet=1 Electron 小窗 ┘

3,704 行新代码，0 条新业务通道。
```

**为什么这条必须写死**：桌宠有一个语音页没有的危险属性 —— **它长得像人**。
头像一开口，人本能地把屏幕上那个数字当作"真实状态"。所以只要它自己开一条
"顺手查个持仓"的近路，就等于给系统加了一个**最容易被信任、又没有任何测试覆盖**的
数据源。判据很直接：**「谁在读它的输出？」** 若桌宠页面里出现自己拼的接口路径，
这层就已经破了。

### L6.12.2 必须照抄的设计决定

```text
1. 窗口参数抽成纯函数（src/pet/petWindow.ts），能被烟测断言而不启动 Electron。
   理由：窗口标志位错一个的表现是"窗口看起来不对"，这是最难在 CI 里发现的一类；
   抽出来之后 P1/P2/P3/P4 全是静态断言。

2. 透明窗必须三处同向，缺一处变黑方块：
   ① BrowserWindow transparent:true
   ② CSS 抹掉 html / body / #root 的底色
   ③ 挂载前（不是挂载后）给 <html> 打 pet-standalone 标记
   ★ 这个 bug 在浏览器预览里**看不出来** —— 只有真起窗才发现。

3. 无边框 + 无标题 + skipTaskbar 三者叠加，必须恰好留一个找回入口：
   托盘建成 → 任务栏让位 + 关窗改为收进托盘；
   托盘失败 → 回任务栏 + 关窗即退出。
   且必须断言「入口有但关不掉」这种组合不存在（比没入口更难收场）。

4. 拖动走原生 IPC 通道（pet:drag-begin / pet:drag-by），不用 CSS -webkit-app-region: drag。
   无边框窗上后者有已知 bug（丢帧、松手后继续跟鼠标）。
   起点只在 begin 记一次，之后每次从固定起点叠加位移 ——
   用"当前位置 + 本次位移"会因 IPC 延迟逐步累积误差。
   ★ 零位移必须不动、NaN/Infinity 必须在 setBounds 之前挡住。

5. 不自我打断：桌宠没有耳机，念长句会被自己的麦克风收到。
   麦克风永不关，改用文本层纯函数 judgeBargeIn 判别（归一化后二元组重合度 ≥ 0.6）。
   ★ 必须留 'idle' 分支：合成静止时用户回话（如「确认」）**不是插话** ——
     判成插话会调服务端 interrupt()，把待确认凭证清掉，症状是"正要确认时被打掉"。
   ★ 判定结论必须上屏：这类失效的形态是"说了没反应"，不给结论就无法归因。

6. 口型：speechSynthesis 不暴露波形，只能靠 onboundary 词边界 + **确定性**兜底包络。
   ★ 兜底包络不得用 Math.random()（每帧不连续，看起来像抽搐）。
   ★ 词边界超过 600ms 未再收到 ⇒ 认定引擎不触发，回落兜底；
     且"当前用的是真词边界还是兜底"必须可见（这是引擎不触发时唯一线索）。

7. 真人头像走「照片 + 受控叠加层」，不走生成式数字人。
   照片：按短边居中裁 → 512×512 JPEG(0.86) → 只存 localStorage，不上传。
   嘴/眼睑位置可微调（任意照片的器官位置不可能靠猜）。
   ★ 肖像来源写在文件头：用自己的照片或已授权素材，不用他人（尤其公众人物）肖像。

8. 导航护栏：桌宠页持有编排令牌，所以
   setWindowOpenHandler 一律 deny + 交系统浏览器；will-navigate 只放行同 URL 重载
   （Vite 热更要用），其余同样交出。

9. 每帧只写一次样式：rAF 把 aperture / lid / breath / bob 写成根元素 CSS 变量，
   由 CSS 推算子元素表现。React 状态全程不参与（每秒 60 次 setState 会拖垮整页）。
   ★ 渲染期不得读/写 ref —— F-19 已在 useInterval 上踩过，本层用
     useState(createAvatarMotion) 拿到稳定实例。
```

### L6.12.3 ⚠️ 这一层有三个「本机环境事实」，不知道会白改半天

```text
① ELECTRON_RUN_AS_NODE=1 可能全局设着（装过 VS Code / 扩展宿主宿主的开发机常见）
   症状：require('electron') 拿到 npm 包壳的路径字符串；
        import { app } from 'electron' 报 "does not provide an export named 'app'"。
   两个报错都指向"导入写法不对"，真因在环境变量上。
   ⇒ 启动器必须显式 delete 掉它，并把"是否摘掉了"打印出来。

② GPU 进程起不来时 Electron 不是降级软件渲染，而是 FATAL 直接退出：
   GPU process isn't usable. Goodbye.
   表现："桌宠闪一下就没了"。且没法在崩之前探测（崩在启动阶段，还没有 app 对象）。
   ⇒ 默认带 --no-sandbox --disable-gpu（两者配套：只加 disable-gpu 没用）；
     有可用 GPU 的机器用 PET_GPU=1 恢复。

③ ★ child.on('exit') 对 Electron 子进程**不触发**（本机实测，最小 Electron 也能复现）：
   子进程确实终止了（process.kill(pid, 0) 探到不存在），
   但父进程的 exit/close 事件始终不来，child.exitCode 恒为 null。
   inherit 与 pipe 两种 stdio 表现完全一致；app.quit() / app.exit(0) / process.exit(0)
   三者都能让进程终止 —— 坏掉的只有"通知父进程"这一步。
   ⇒ 冒烟的判定权必须交给**协议行**（stdout 上的 PET_SMOKE_OK / PET_SMOKE_FAIL），
     再补存活轮询与超时兜底；**不要在退出事件上继续想办法**。
   ⇒ ★ 可复用的形态：「没收到事件」不等于「状态没变」。事件不可靠时换状态轮询或显式协议。
```

### L6.12.4 模块树与规模（实测，含注释与空行）

```text
src/pet/
  echoGuard.ts      217 行   插话判定纯函数（自回声 / 尾响 / 静止 / 短命令放行）
  petWindow.ts      275 行   窗口契约：标志位 · 置顶层级 · 越界钳制 · 找回方案 · 拖动位移
  lipsync.ts        107 行   口型：词边界峰值 · 确定性兜底包络 · 眨眼 · 呼吸
  avatarMotion.ts   158 行   动画状态机（onboundary 打点 → 每帧算 aperture/lid/breath/bob）
  PetAvatar.tsx     139 行   照片 + 嘴/眼睑叠加层；rAF 每帧只写一次 CSS 变量
  petBridge.ts       71 行   桌面外壳能力契约（8 个动作，无业务动作）
  petPhoto.ts       143 行   裁剪 → 压缩 → localStorage（含配额失败原因）
src/styles/pet.css          445 行   透明窗样式 · 头像/字幕/控制条玻璃态 · **P0 标签对比度（见 L6.12.5）**
src/pages/PetPage.tsx       712 行   主页面（standalone 形态与页面形态共用）
desktop/
  main.ts           464 行   主进程：窗口 · 托盘 · 置顶 · 位置记忆 · 找回 · 导航护栏
  launch.ts         253 行   启动器：摘环境变量 · 开关 · **协议行判定 + 存活轮询**
  preload.mjs        47 行   纯 JS（预加载不过类型擦除，写了注解就 SyntaxError）
scripts/pet-smoke.ts        754 行   71 断言 / 11 组（P1…P11）
```

**后缀与内容的对应关系是硬要求，取反任一侧都起不来**：

| 文件 | 后缀 | 为什么 |
|---|---|---|
| `main.ts` / `launch.ts` | `.ts` | 有类型注解；Electron 44（Node 24）默认开启类型擦除，能直接 import `.ts` |
| `preload.mjs` | `.mjs` | 预加载脚本**不过类型擦除**，写注解会 `Unexpected token ':'` |
| 被主进程 import 的 `src/pet/*.ts` | `.ts` | 同上；且 Node ESM 下 import 要带扩展名（`'./lipsync.ts'`，Vite 会容忍省略） |

### L6.12.5 一条 UI 层的坑：**P0 的颜色不能沿用通用弱色**

与桌宠的功能无关，但它是**界面上"看不见"的那类缺陷** —— 只有用算的才能发现，
`test:pet` 的 P11 就是为它开的门。

**症状**：P0 报警条目的**标签行**（"紧急报警 · 风险报警"和时间）几乎读不出来。

**为什么一直没人发现**：整条看起来"有边框、有底色"，扫一眼像"样式做过了"。
而且这件事**在浅色底上最严重、在深色底上不明显** —— 不把颜色真正合成起来算，看不出来。

**真因**：`.pet-cap-p0` 只覆盖了边框与底色，**没有覆盖标签行的文字色**，
于是那行退回到通用弱色 `--text-weak`（`#5C6478`）。而 P0 条的底色是
`rgba(46, 12, 20, 0.82)` —— **半透明**，会与身后的一切合成：

| 底色合成到哪 | 该行对比度 |
|---|---|
| 最暗处（等价纯 `rgb(46,12,20)`） | 约 3.0 : 1 |
| **纯白**（透明窗身后可能是任何东西） | **约 1.8 : 1** |

**判据（可复用）**：半透明底上的文字，必须按**与最亮可能底色合成**来算对比度 ——
那才是比值最低的一侧。透明窗、浮层、毛玻璃都属于这一类；
**按不透明底算会系统性高估**，而高估的那部分正好是"用户看不清"的那部分。

**修法与门禁**：改成 `#FF94A8`（叠纯白仍 5.0 : 1，达 WCAG AA 小字 4.5 : 1），
并由 P11 两条断言钉住：① 覆盖规则必须存在（缺了就是退回弱色，**这条直接对应真因**）；
② 合成后对比度 ≥ 4.5。**两条都验证过会变红**：
改回弱灰 → 实测 `1.76:1` 报红；删掉规则 → 两条同时报红。

### L6.12.6 复现这一层时的提示词（可直接粘贴）

```text
给系统加一个悬浮桌宠（桌面小窗），要求：

1. 桌面外壳与业务彻底分离：桌宠页面**不得**自己拼任何接口路径，
   只能调用语音层已有的客户端函数。窗口/托盘/置顶/位置记忆之外，一行业务都不写在主进程里。
2. 窗口参数与所有判定逻辑（插话、口型、拖动位移、越界钳制、找回方案）抽成**纯函数**，
   让烟测能不起 Electron 就断言它们。
3. 透明无边框窗三处必须同向：BrowserWindow transparent:true、CSS 抹掉 html/body/#root 底色、
   挂载前给 <html> 打标记。缺一处就是黑方块，而且**浏览器预览看不出来**。
4. 无边框 + skipTaskbar 组合下，必须恰好留**一个**找回入口（托盘优先，无托盘回任务栏），
   并断言"有入口但关不掉"这种组合不存在。
5. 拖动用原生 IPC（drag-begin 记起点、drag-by 从固定起点叠加位移），
   不用 CSS -webkit-app-region: drag。零位移不动、NaN 在 setBounds 前挡住。
6. 插话判定要防自回声：念长句会被自己麦克风收到。用文本层纯函数判别，
   并**单独处理"合成静止时用户回话"**——那不是插话，判错会清掉待确认凭证。
   判定结论必须上屏（否则失效形态是"说了没反应"，无法归因）。
7. 口型靠 onboundary 词边界 + **确定性**兜底包络（禁用 Math.random）；
   词边界过期要回落；"真词边界还是兜底"必须可见。
8. 头像走"用户自选照片 + 可微调的嘴/眼睑叠加层"，只存 localStorage 不上传；
   不引入任何带 GPU/PyTorch 的生成式数字人依赖。
9. 冒烟要真起窗、截图、报告 bounds/alwaysOnTop/visible 并退出；
   ★ 判定必须落在子进程 stdout 的协议行上，**不要依赖 child.on('exit')**
   （本机实测：Electron 子进程终止后父进程收不到该事件，进程其实已经退干净了）。
   再补存活轮询（process.kill(pid, 0)）与超时兜底。
10. 截图是内部验证产物，落系统临时目录，**不得写进项目目录**。
11. 写一组可失败的烟测（P1…P11 共 71 条），并接进 npm run ci；
    真起窗的 pet:smoke 单列，不进 CI（CI 不该弹窗）。
12. **P0 报警的可读性要用算的**：半透明底上的文字，按"与纯白合成"算对比度
    （最坏一侧），要求 ≥ 4.5:1；并且**必须有一条单独的覆盖规则**给 P0 的标签行 ——
    让它在 `.pet-cap-p0` 之外存活，否则会静默退回通用弱色。
    验收方式不是"看起来还行"，而是把颜色改坏一次，确认断言真的报红。
```

### L6.12.7 本层的明确不做

```text
1. 生成式数字人（SadTalker / LivePortrait / MuseTalk）——
   均需 PyTorch + GPU 的重型后端。投真钱尚未解锁，此刻不为一个不参与风控的
   桌宠引入新重型依赖。走「照片 + 叠加层」。
2. 唤醒词（常驻监听）—— 与语音层 V1 一致，保留手动开始/停止。
3. 桌宠专属数据接口 —— 一条都不开（见 L6.12.1）。
4. 托盘的开机自启 / 自动更新 —— 属打包分发阶段，现在做了也没人验。
5. 语音生物识别（声纹）—— 那是另一条安全边界，不是桌宠功能。
```

---

## L6.13 · 桌宠 ↔ 语音管家合并（2026-09-16 第五轮）

### L6.13.1 一句话定位（这一节的全部内容都由它推出）

> **两个页面长得不一样，不代表它们该有两份会话逻辑。**
> 合并不是"把 A 页塞进 B 页"，是**先把重复的抽成唯一一份，再合并外壳**。

判据只有一条：**同一个业务动作（发话 / 打断 / 读日报 / 拉报警）在仓库里有几条实现路径？**
两条就是隐患 —— 以后修风控口径只改一条，另一条静默保留旧行为。

### L6.13.2 必须照抄的设计决定

| 决定 | 做什么 | 为什么必须这样 |
|---|---|---|
| 抽出唯一会话内核 | `src/voice/useVoiceSession.ts`（~330 行） | 配置/画像/匹配/库存/日志/工作线/报警/SSE 流/播报/打断/日报 —— 两页共用同一份状态与动作 |
| 抽出唯一外壳逻辑 | `src/pet/usePetShell.ts`（~186 行） | Electron 桥 / 托盘 / 照片 / 对齐 / 拖动 / 点击穿透 |
| 单页双布局 | `src/pages/VoiceHubPage.tsx`，`standalone` 单 prop | `true` → 悬浮窗形态（头像+字幕+控制条）；`false` → 控制台形态（左对话右设置）。**两种形态共用同一个 hook 实例** |
| 旧页不删，改重定向桩 | `VoicePage.tsx` / `PetPage.tsx` 各一行 `export { default } from './VoiceHubPage.tsx'` | 本机 safe-delete 对仓库文件 fail-closed（拒删）。桩同样是"只有一份实现"——旧引用拿到的是同一个组件，不是复制品 |
| 派生列表不另写一遍 | `QUICK_SAY_COMPACT = QUICK_SAY.filter(...)` | 两份常量必然漂移 |
| 隐藏 input 留在页面层 | `fileRef` **不放进** hook 返回值 | 见 L6.13.4 第 ② 条 |

### L6.13.3 `test:pet` P12 组（7 条）：钉住"单一入口 / 单一通道 / 单一实现"

| 断言 | 钉住什么 |
|---|---|
| P12① | `postUtterance` **只**允许在 `src/voice/useVoiceSession.ts` 里被调用 |
| P12② | 回声闸门（`judgeBargeIn`）只有一个调用点 |
| P12③ | `VoicePage.tsx` / `PetPage.tsx` 必须是**纯重定向** |
| P12④ | 侧边栏与 `PageId` 只剩一个 voice 入口，无 `pet` 项 |
| P12⑤ | 路由无 `pet`，但 `?pet=1` 悬浮分支**仍在**（合并不能顺手删掉那条入口） |
| P12⑥ | 合并页同时提供两种布局 |
| P12⑦ | 合并页不得反向 import `Sidebar` / `TopBar` |

★ **写源码扫描类门禁的通用坑（本项目已踩）**：
第一版用 `/postUtterance\(/` 扫全 `src/**`，结果 `src/voice/client.ts` 被判成"第二个发起处"——
因为 `export function postUtterance(...)` 的**定义行也匹配**。
修法：加一层 `callSites()`，先用正则把函数定义行**剔掉**再匹配调用点。
**"扫源码"的门禁天生分不清定义与调用，必须显式处理。**

破坏验证（不做这一步就又是一道"不可能失败的检查"）：

| 故意改坏 | 结果 |
|---|---|
| 在 `VoicePage.tsx` 里恢复一段 `postUtterance` 调用 | P12③ 红 |
| `Sidebar` 里把 `pet` 项加回来 | P12④ 红 |
| 删掉合并页的 `standalone` 分支 | P12⑥ 红 |
| 还原后 | **79 passed / 0 failed**，exit 0 |

### L6.13.4 ⚠️ 本条最值钱的五个坑（都会让人误判成"代码写错了"）

**① `tsc` 绿 + lint 绿 + 单测全绿，`vite build` 红 —— 最容易自我欺骗的一类失败**

实测：`src/voice/useVoiceSession.ts` 里写 `import ... from '../store/Store.ts'`，
而真实文件是 **`Store.tsx`**（只差一个字母）。

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（`tsc --noEmit`） | **exit 0，一声不响**（实测复现过） |
| `npm run lint` | exit 0 |
| 各 smoke | 全绿 |
| `npm run build` | ✗ **Build failed · UNRESOLVED_IMPORT** |

⇒ **中途只跑 typecheck + lint + 单测，不能替代 `npm run build`。**
import 解析是打包器的职责，`tsc` 的口径与它不同。这条也正是 `build` 必须留在 CI 里的原因 ——
**它守的是一条别的门都守不住的不变量。**

**② `react-hooks/refs`：hook 返回对象里带 ref，会让 lint 把整个返回对象判为"渲染期读 ref"**

一次报 **32 个错，全指向返回值**，不指向 ref 本身，很容易误判成"hook 用错了"。
⇒ 修法：把 `fileRef` **移出 hook**，留在页面层 `useRef`。

**③ `react-hooks/immutability`：`useState(() => new VoiceSpeaker())` 之后不能再 `speaker.onWord = ...`**

⇒ 需要"渲染期外才改的实例"时，用 `useRef` 惰性建：
`const r = useRef<T|null>(null); if (r.current === null) r.current = new T()`。

**④ 嵌套模板串在本机 Node 类型擦除下直接报 `ERR_INVALID_TYPESCRIPT_SYNTAX`**

`${...${...}...}`（内层还是 `.map` 回调里的模板）配中文标点，解析器就崩。
它报的是**语法错误**，会让人去查括号是否配平 —— 实际不是语法问题。
⇒ 断言说明串**一律字符串拼接**（`String(n) + ' 个样本'`），别用嵌套模板。

**⑤ 预览时"界面好着、数据全空"：先查端口，别查后端**

`npm run orch` 默认监听 **8787**，而前端默认连 **8790**（`src/store/Store.tsx` 里 `orchUrl` 的兜底值）。
不显式 `PORT=8790` 的话，**页面渲染完全正常，但每个面板都是 `Failed to fetch`** ——
这类形态最容易被误判成"后端挂了"或"改的东西没生效"。
⇒ 三进程预览的命令固定为：
`npm run ledger`（8791）→ **`PORT=8790 VENUE=sandbox AUTOPILOT_LIVE=false npm run orch`**（8790）
→ `npm run preview -- --port 4173 --strictPort`。

---

## L6.14 · 密钥权限范围自检（`server/keyScope.ts`，2026-09-16 第五轮）

### L6.14.1 一句话定位

> **一把带提币权限的钥匙，和一把干净钥匙，在本系统里的行为逐字相同 —— 直到出事那天。**

它是"平时完全看不见"的一类风险，所以判据是：**能不能用一次只读调用，把"这钥匙能做什么"问清楚。**

### L6.14.2 三态判定（fail-closed，与 `claimValidator` 同一套口径）

| 状态 | 触发 | severity | 处置 |
|---|---|---|---|
| `ok` | 明确读到"有读 + 有交易 + 无提币" | `none` | 无 |
| `danger` | 明确读到提币权限 | **P0** | 去交易所后台关掉，重签 |
| `unverifiable` | 读不到 / 认不出 / 字段畸形 / **空集合** | **P1** | 按周期重查，**不放行** |

### L6.14.3 必须照抄的口径

1. **凭据只装可观测量，不装结论字段。** `classifyKeyScope(venue, raw)` 只吃交易所的**原始响应体**。
   P4① 专门断言：往 `raw` 里塞 `status:'ok'` / `safe:true` / `withdrawAllowed:false`，判定必须**一字不变**。
2. **两个刻意的不宽容（Binance）**：
   ① 缺 `canWithdraw` 字段 → `unverifiable`，**不是 ok**（"没看到"≠"没有"）；
   ② `canWithdraw:"false"`（字符串）→ **也** `unverifiable`（类型宽容会让畸形返回装成"已确认"）。
   `read` 权限不是推断的，是"刚才确实读到了"这件事本身。
3. **OKX 按逗号切分 `perm` 后逐项比对，不做子串匹配** ——
   子串匹配会把 `read_only_withdraw_disabled` 这类值误判成危险或安全。
   `perm: ''` → `unverifiable`：空字符串是"没有内容"，不是"没有权限"。
4. **未知交易所一律 `unverifiable`**：认不得的返回格式里可能正好藏着 `Withdraw ✓`。
5. **聚合器里唯一一处容易写反的地方**：**空集合 → `unverifiable` / exit 1，而不是 `ok` / exit 0**。
   写反之后它照样 exit 0、看起来一切正常。`danger` 优先于 `unverifiable`。
6. **`summary` 一律显式格式化拼接**，不许 `String(对象)` —— 这句话会被 narrator 念出来。

### L6.14.4 `npm run keys:audit` 刻意不进 CI

它真问 Binance `/api/v3/account`（HMAC 签名）与 OKX `/api/v5/account/config`，
落盘 `artifacts/key-scope.json`，退出码 0/1/2。**进 CI 只会制造随机红灯**
（联网 + 依赖真实密钥 + 结果非确定）。正确位置是"发布前人工跑一次 + 落盘"。

本机实跑结论：两个交易所均落到 `unverifiable`（OKX 超时、Binance 返回缺字段），**exit 1** ——
**这是 fail-closed 生效，不是脚本坏了。**

### L6.14.5 门禁与破坏验证

`test:keyscope` = **21 断言 / 5 组**（P1 Binance 三态 / P2 OKX 四形态 / P3 缺证据不放行 /
P4 调用方无从自报 / P5 聚合最坏优先）。

| 故意改坏 | 结果 |
|---|---|
| `summarizeAudit` 空集合分支改成 `ok` / exit 0 | P5① 红 → 20 passed / 1 failed |
| 还原后 | **21 passed / 0 failed**，exit 0 |

### L6.14.6 复现这一层的提示词（可直接粘贴）

```text
在 server/ 下新建 keyScope.ts，实现密钥权限范围自检，要求：

1. 只接收交易所返回的**原始响应体**，函数签名里不许出现任何"结论字段"
   （不许有 status / safe / allowed 这类入参）。塞进去也不影响判定。
2. 三态：ok / danger / unverifiable。缺证据、认不出、字段畸形、空集合 → 一律 unverifiable。
   danger = 明确读到提币权限；ok = 明确读到"有读 + 有交易 + 无提币"。
3. Binance 看 canTrade / canWithdraw：这两个字段缺失或不是真布尔值 → unverifiable（不做类型宽容）。
4. OKX 看 perm：按逗号切分后**逐项比对**，不许子串匹配；空字符串 → unverifiable。
5. 不认识的交易所 → unverifiable。
6. 聚合器：空集合 → unverifiable 且 exit 1（不是 ok / exit 0）；danger 优先于 unverifiable。
7. summary 必须显式格式化，禁止 String(对象) —— 它会被语音念出来。
8. 写 scripts/keyscope-smoke.ts，至少覆盖：三态各自的正例 + "缺字段不得当成安全" +
   "调用方塞结论字段不影响判定" + "聚合器最坏优先" + "空集合不返回 ok"。
9. 每条断言都要**故意改坏一次**确认会变红。
10. 联网探测脚本单独写（scripts/key-scope-audit.ts），**不要接进 CI**。
```

### L6.14.7 本层的明确不做

```text
1. 自动轮换密钥 —— 那是对交易所的写操作，不属于自检。
2. 代管密钥/KMS —— 属阶段 D。
3. 把 keys:audit 接进 CI —— 见 L6.14.4。
4. 为它新开 API 端点 —— 本轮 0 条新 API；自检结果走既有审计事件与 artifacts。
```

---

## L6.15 · 拟人音色与出声链路（`server/voice/tts.ts` + `src/voice/speechPath.ts`，2026-09-17）

### L6.15.1 一句话定位

> **"音色太生硬、一点都不拟人化"这句话，只能靠换引擎解决，不能靠调参数解决。**

用户原话是「音色太生硬一点都不拟人化，需要类似于豆包或是 ChatGPT 语音对话那种拟人化的声音」。
它的成因很具体：`speechSynthesis` 的声音来自**操作系统装的语音包**，
Windows 上能拿到的 Huihui / Yaoyao / Kangkang 全是 SAPI5 时代的**拼接式**合成 ——
字与字之间硬接，没有韵律建模。**这是管线质量的问题，换档位、调音高都救不了它。**

所以这一轮做的事是：**加一条真正拟人的出声路径（云端神经合成），并保留本机那条作为显式兜底。**

### L6.15.2 引擎能力矩阵（本机真实测出来的，不是猜的）

非官方端点（Edge 朗读接口，零密钥、中文质量高、延迟约 1.5 秒）上逐条量过：

| 参数 | 是否生效 | 证据 |
|---|---|---|
| 换 `voiceId` | ✅ | 晓晓 29520 / 云希 28512 / 晓伊 28080 字节（CBR，字节数 ∝ 时长） |
| `prosody rate` | ✅ | rate 2.0 → 24480 字节，rate 0.5 → 96624 字节（同文本减半/加倍） |
| `prosody pitch` | ❌ | pitch 2.0 与默认**逐字节相同** |
| `mstts:express-as style` | ❌ | 服务端直接 `1007 SSML is invalid` 关连接 |
| 同输入可复现 | ✅ | 同文本两次均 10944 字节 |

> ★ **矩阵之外的两条结论同样重要**：
> ① **目录与界面必须按矩阵来。** 既然 `pitch` 不生效，神经音色的 `pitch` 恒为 1，
> 且面板把它**禁用并写明原因** —— 留一个"看起来能调、实际不动"的滑块，
> 正是"僵硬"这件事的一部分（用户会以为是自己没拖对）。
> ② **`Sec-MS-GEC-Version` 会过期，表现是 403 而不是 404。**
> 本机实测 `1-130.0.2849.68` → 403，`1-133.0.3065.39` → 101 握手成功。
> 所以它做成 `EDGE_TTS_SEC_VERSION` 可覆盖，而不是写死在代码里。

### L6.15.3 零新依赖的手写 WebSocket

只需要发两个文本帧、收若干二进制帧，为此引入 `ws` 会连带一整套服务端实现。
`tts.ts` 手写握手 + 帧编解码（含分片/continuation）约 100 行，
换来的是一条**本项目零新依赖**的能力。立场是明确的：
**不为一个不参与风控的装饰性能力引入重型依赖。**

### L6.15.4 路径决策：报警允许赌一次，但只赌一次（`src/voice/speechPath.ts`）

出声只有两条路，走哪条**由一处决定**（`speechPathPlan`）：

```
priority 不是问题 → 云端能走就走云端 → 走不了走本机 → 两条都没有 = silent（并计数）
```

云端"能不能走"的规则（`neuralAllowed`）：

| 上次云端的结果 | P0 报警 | 非报警 |
|---|---|---|
| 还没试过（`null`） | **走云端**（否则永远没有第一次，音色永远是机器音） | 走云端 |
| 上次**成功** | 走云端 | 走云端 |
| 上次**失败** | **一律退回本机** | 等 `NEURAL_RETRY_MS`(60s) 冷却后再试 |

> **写在反面的那条更关键**：报警**不许**去重试一条刚失败过的路。
> 云端延迟约 1.5 秒，一次超时最长 12 秒 —— 拿报警的延迟去"自愈"是不能接受的。
> 反过来，**一次成功的合成就把云端请回报警这条路**（重启条件是"被证明能用"，不是时间）。

★ 这套逻辑被刻意放进**不碰 React、不碰 `window` 的纯模块**，
好让烟测逐条喂样例断言 —— 包括那些"必须走错就报红"的分支。
写在合成器类里的话，它在测试里根本够不着（`VoiceSpeaker` 至今零测试覆盖）。

### L6.15.5 目录只有一份（`server/voice/voices.ts`）

神经音色条目**从 `NEURAL_VOICES` 派生**，不另抄一份列表；两种引擎共用同一个 `voiceId` 寻址。

三条必须照抄的口径：
1. **`DEFAULT_VOICE_ID` 是神经音色。** 把它设成本机音色，等于用户第一次听到的永远是机器音，
   然后他得自己猜"是不是还有更好的、在哪儿选"。云端不可用时前端会自动降级，**且降级是显式可见的**，
   所以默认给云端不会让人"静默变差"。
2. **`engineOf` 由目录推出**（`Object.fromEntries`），不手写。手写的那份一定会与目录分岔，
   而分岔的后果是"面板说这条走云端、合成器却按本机处理"这种**不会报错**的错误。
3. **降级别名必须存在**（`用本机音色 / 离线音色 / 兜底音色`）。云端坏掉时用户得有一句话能主动切回去，
   而不是等面板上的说明告诉他去点哪个按钮。

### L6.15.6 两道前置闸必须在**计数之前**（`synthesizeForVoice`）

`neuralStats` 要拿到面板上显示"云端链路健康度"。所以：

- **选了本机音色** → 在 `attempts += 1` **之前**返回 `kind:'local-engine'`；
- **未知音色** → 同样在计数之前返回 `kind:'unknown-voice'`（不做静默替换成默认嗓子）。

> 把一个**正常状态**记成故障，比不报更糟：面板会长期挂着一个来自正常选择的失败数，
> 然后用户学会忽略这个指标。S13③ 就是钉这一条的（实测：把闸挪到计数之后 → 立刻报红）。

### L6.15.7 降级必须被说出来（前端）

`src/voice/client.ts` 的 `VoiceSpeaker` 变成双引擎：`synth` 注入点 + `Audio` 播放，
失败时**就地**退回 `speechSynthesis`，并把「这次用的是哪条引擎 + 为什么降级」暴露给界面。

三条实现级要点：
1. **`synthesizeSpeech` 不能复用 JSON 版 `voiceFetch`** —— 那个接口成功时回的是**二进制 MP3**，
   走 `voiceFetch` 会把音频当文本读然后 `JSON.parse` 失败，表现成"每次合成都说失败"，
   而服务端账本里全是成功的记录。
2. **失败不抛，返回 `{ok:false, kind, message}`** —— 抛异常会让降级路径变成 catch 里的隐形分支，
   而隐形分支不会有人测。
3. **`announce(true)` 必须带 `this.speaking` 判断**：某些环境 `speak()` 会**同步**触发 `onerror`
   → `finish()` 已把 speaking 置回 false。此时再点亮"正在说话"，
   会留下一个**永远不会被清掉**的说话态（桌宠的嘴一直张着、尾响窗再也不开）。

### L6.15.8 云端音频没有词边界，口型靠算（`neuralWordTicks`）

`speechSynthesis` 那条路有 `onboundary`（带 `charIndex`）；云端音频只是一段 MP3，
拿不到任何边界事件。所以按"字数均摊到时长"造一条时间轴：
**2 字一档**，均匀铺满 `duration`（拿不到 `duration` 时用 `bytes / 6` 估算 ——
格式声明是 `audio-24khz-48kbitrate-mono-mp3`，即 6000 字节/秒 = **6 字节/毫秒**）。

### L6.15.9 门禁与破坏验证

`test:voice` 由 **12 → 13 场景**，新增 `S13 出声链路`（⑧ 组断言）。
**S13 全部不联网**：断言的要么是目录/映射这类纯数据关系，要么是"任何网络请求之前就返回"的前置闸，
要么是纯函数。

> ★ 为什么不测真实合成：它需要外网 + 那个**随时会过期的握手版本号**，
> 一次抖动就会把 CI 变红，然后所有人学会忽略它。真实合成由人工联网跑覆盖。

| 故意改坏 | 结果 |
|---|---|
| `speechPath.ts`：取消"报警不许重试刚失败过的云端" | S13 红（期望 local，实际 neural） |
| `service.ts`：把"本机音色"的前置闸挪到计数之后 | S13 红（attempts 期望 0，实际 1） |
| `configShape.ts`：缺 `engine` 时默认成 `neural` | S13 红 |
| `configShape.ts`：`withCatalog` 不再逐条收口 | S13 红（"收口后仍有非数组 matchNames"） |
| `configShape.ts`：分组顺序反过来 | S13 红 |
| `voices.ts`：`engineOf` 只覆盖一部分 id | S13 红 |
| `voices.ts`：默认音色退回本机语音包 | **S10 红**（"默认音色必须走云端神经合成"） |
| `voices.ts`：别名"换个男声"指回本机男声 | S10 红 |
| `speechPath.ts`：口型粒度 2 字 → 3 字 | S13 红（**第一轮漏网**：只断言总字数时照样绿，见 §L6.15.10） |
| `speechPath.ts`：口型全部排在开头 | S13 红 |
| 还原后 | **13/13 passed**；`test:pet` **89 项 / 0 failed**；`npm run ci` 27 道全绿 |

**联网实测（人工，`_v7_tts_live.ts`）**：默认/云希/晓伊三档全部 `ok`，
29520 / 28512 / 28080 字节，1518 / 1523 / 1352 ms，音频头 `fff3`（MP3 同步字），
同输入两次 10944 vs 10944 一致。

### L6.15.10 ⚠️ 本轮自己的"不可能失败的检查"（值得单独记）

第一轮破坏验证里，「口型粒度 2 字 → 3 字」**改坏了也不报红** ——
因为当时的断言只查"覆盖字数总和"，而 6 个字无论按 2 字还是 3 字分，总和都是 6。

> **教训：断言的对象必须是"会随错误变化的量"，不是那个错误**守恒**的量。**
> 修法是补一条粒度断言（6 字 → 恰好 3 个 tick，每个 2 字），并加"口型不许全挤在前半段"。

### L6.15.11 复现这一层的提示词（可直接粘贴）

```text
给已有语音系统换一条"拟人"的音色路径，保留原路径作为显式兜底：

1. 先量清楚引擎能力，再写目录。对目标端点逐条测：换音色、调语速、调音高、
   加风格标签，各自用「输出字节数」或「逐字节 diff」判是否生效。
   **不生效的参数一律从配置里删掉，并把对应的 UI 控件禁用并写明原因** ——
   留一个能拖但没反应的滑块，用户会以为是自己没拖对。
2. 目录只允许有一份。新引擎的音色条目从引擎侧的列表**派生**，不另抄。
   两种引擎共用同一个 voiceId 寻址，用 engine 字段标出走哪条路。
3. 默认音色设成新引擎的。降级路径必须是**显式可见**的（面板写出原因）。
   同时提供一句"切回旧引擎"的自然语言别名。
4. 出声路径的决策只允许有一处（纯函数，不碰框架），规则写死为：
   新引擎能走就走新引擎 → 走不了走旧引擎 → 两条都没有 = 静默**且必须计数**。
   ★ 报警（P0）在"上次失败过"时**一律退回旧引擎**，绝不去重试
     —— 拿报警的延迟去自愈是不能接受的；重启条件是"一次成功"，不是时间。
5. 合成失败**不抛**，返回结构化的 {ok:false, kind, message}；前端据此就地退回旧引擎，
   并把"这次用的是哪条引擎 + 为什么降级"显示在面板上。静默降级的后果是
   用户以为新音色选项失效 —— 那正是要修的抱怨。
6. "用户选的是旧引擎"这类**正常状态**，必须在计数之前返回 ——
   不许被记成"新引擎失败了一次"。把一个正常状态报成故障，比不报更糟：
   它会训练用户忽略这个指标。
7. 新引擎的音频拿不到词边界，按字数均摊造一条口型时间轴（本地音色那条路语义要一致）。
   时长优先取 audio.duration，取不到时按**格式声明**换算（如 48kbps → 6 字节/毫秒），
   不要凭感觉猜。
8. 服务端按路由再加两道前置闸：未知音色 / 本就不该走新引擎的音色，
   都在任何网络请求之前返回，**且不计入健康度**。
9. 烟测**全部离线**：断言目录与映射的一致性、前置闸的返回码、失败文案的完备性、
   路径决策的每一个分支（含"报警不许重试"与"两条路都没有→静默"）、纯函数的口型时间轴。
   真实合成写成人工联网脚本，**不进 CI**（会过期的握手参数 + 外网 = 随机红灯）。
10. 每一条断言都要**故意改坏一次**确认会变红。特别注意那些"错误会守恒"的量
    （总字数、总条数）：改坏了也不变，等于没测。
```

### L6.15.12 本层的明确不做

```text
1. 不做流式合成（首字延迟）—— 当前播报多为短句，1.5 秒整段返回足够；
   要做需要改成分块解码，属另一件事。
2. 不做音频缓存 —— 播报文本几乎不重复，缓存只占内存。
3. 不引入 ws 依赖 —— 见 L6.15.3。
4. 不把 pitch/style 放进配置 —— 见 L6.15.2，那是假选项。
5. 不为它新开业务通道 —— 合成走 /voice/tts，是既有语音层的新端点，不是新决策路径。
```

---

## L6.16 · 任务层：先裁定，再执行（`server/mission/`，2026-09-17 第七轮）

### L6.16.1 一句话定位

**把「一个目标」接成一次受控执行 —— 但顺序必须是"先裁定、再启动"。**
它不是新交易通道，也不是新的决策来源；它是「目标」这种输入的**唯一入口**。

要接的那句话长这样：

```text
「帮我使用该系统策略做okx测试网实测，10U做到100U,1天内，可以使用高倍合约杠杆」
```

补这一层之前，它既不是下单命令（没有方向与数量），也不是目标百分比
（`startAutopilot` 收的是一个数字），只能被丢进「听不懂」。

### L6.16.2 复现这一层必须先想清楚的三件事

```text
① 裁定必须排在启动之前。
   反过来做的症状不是报错，而是"一台看起来很忙、实际一步也走不动的机器"：
   循环停在 accumulating、门禁在拒绝、日志写着"正常"。
   而真相是这个目标**在第一笔就被物理否掉了**。
   ⇒ 先把目标拆到能被既有约束逐条检验，再决定放不放行。

② 缺槽位就说缺，**绝不用默认值补**。
   最容易写出的"贴心"实现是 `parseDeadline(t) ?? 24 * 3600e3` ——
   它把"用户没说"变成了"用户说了 24 小时"，上层从此再也分不清这两件事。
   ⇒ 槽位缺失一律进显式的 `missing` 数组，由上层转澄清。

③ 不可行的结论**必须带数**。
   「做不到」是判断（可被无视）；「需要 119 笔盈利、只剩 5 笔亏损额度」是事实（可被核对）。
   这条要写成断言，防止后来者把理由改成一句漂亮话。
```

### L6.16.3 三态裁定的档位是**结构**，不是文案

裁定是三态：`feasible` / `infeasible` / `unverifiable`（缺证据一律不放行，fail-closed）。

★ **第一版实现里 `unverifiable` 是死代码。** 「缺槽位」也产生一条理由，
那条理由记成 `severity: 'block'`，于是判定**永远落在 `infeasible`** ——
用户收到"这个目标做不成"，而事实是"你少说了一个数"。

⇒ 档位由三档扩到**四档**，把「我不知道」与「它不行」在结构上分开：

| 档位 | 含义 | 用户该做什么 |
|---|---|---|
| `block` | 硬矛盾，做不成 | 改目标或放弃 |
| **`hold`** | **证据不足，不是不行** | **补一句话就能重来** |
| `warn` | 可以做，但有风险 | 知情后继续 |
| `info` | 只是说明（如杠杆不放大仓位）| — |

具体判：`MISSING_SLOTS` / `OVERFIT_NEVER_RUN` / `OVERFIT_EVIDENCE_INSUFFICIENT` → **`hold`**；
`OVERFIT_REFUSED`（PBO 超限）→ **`block`**。
理由不是随意的：**"样本不够"补样本就能过，"PBO 超限"补样本也不一定过** ——
把前者记成 block，会让用户以为策略被判死刑而放弃一条本来能走的路。

★ 这是本项目第 8 次同类 P0，且**失效方向相反**：
不是"不可能失败的检查"，而是**不可能被命中的状态**。
它比前者更难发现 —— 类型里有这个取值、文档里有这段说明、接口上一切正常，**没有任何东西会报红**。

⇒ **硬要求**：判定里只数 `block`，并保留 `spec.missing.length` 作为**独立**条件
（判定不该依赖理由列表被填满：将来有人重构掉 `MISSING_SLOTS`，
"缺了就说不清"仍必须是 `unverifiable`）。

### L6.16.4 尺子全部来自既有模块（本层不新立任何阈值）

| 尺子 | 出处 | 挡什么 |
|---|---|---|
| 1R 风险预算 `EV_RISK_PER_TRADE_RATIO` | `server/riskConstants.ts` | 单笔亏多少、由此定仓位 |
| 当日亏损熔断 `EV_DAILY_LOSS_EQUITY_RATIO` | 同上 | **一天只有 `floor(5%÷1%)=5` 笔试错额度** |
| 止损垫下限 `EV_STOP_SAFETY_PCT_MIN` | 同上 | 首笔能开多大 → 反推所需最小本金 |
| 安全杠杆 `maxSafeLeverageDetail(stopPct)` | `server/positionGuard.ts`（**现算后注入**）| 强平必须先于止损 |
| 成本地板 `EV_MIN_VIABLE_NOTIONAL_CEX_USDT` / `EV_MIN_MARGIN_USDT` | `riskConstants.ts` | 首笔能不能真的成交 |
| 目标硬界 `AUTOPILOT_TARGET_MAX_PCT` | `server/autopilot.ts`（本轮**导出为唯一出处**）| 目标越界（0 < t ≤ 50）|
| 过拟合门结论 | **倒扫账本**，不读任何自报字段 | 连交易阶段都进不去 |

★ 两条不许违反：
1. **不重写公式。** `maxSafeLeverageDetail` 是「止损必须先于强平」这条物理约束的载体，
   抄第二份就一定会在某次调参后与真身分岔。
2. **不读自报字段。** 门禁结论一律从 `AUTOPILOT_OVERFIT_GATE` /
   `AUTOPILOT_OPTIMIZE_REFUSED` / `AUTOPILOT_STRATEGY_SELECTED` 的 payload 还原，
   且 **`bypassed-by-pin` 不算通过**（账本写着"绕过了"，读成 `pass:true`
   就等于给 pin 开了一条绕过整条自进化线的后门）。

### L6.16.5 那句话的真实裁定结果（可直接复算）

结论 `infeasible`：

| 结论 | 数从哪来 |
|---|---|
| 目标 **+900%** 超出自动驾驶范围（0 ~ **+50%**）| `AUTOPILOT_TARGET_MAX_PCT` |
| **10U 第一笔就开不出来**：按 1R=1%、1.8% 止损垫只能开出 **5.56** 名义本金，低于 CEX 地板 **10**；要让第一笔刚好开得出来，**本金至少 18** | `planSizing` |
| 即使全部放行，还需 **119 笔盈利**，而一天最多允许亏 **5 笔** ⇒ 隐含胜率 **96.0%**，等于**每小时 5.0 笔盈利** | `requiredTradesOf` |
| 过拟合门**还没有结论**（这批数据从未跑过门）| `overfitState()` 倒扫账本 |

达标数学的推导（**每一步都可复算，不许简化成一句"胜率要很高"**）：

```text
① 单笔盈利 = 盈亏比 × 1R = 2 × 权益 × 1%
② 单笔亏损 = 1R = 权益 × 1%
③ 当日亏损熔断只给 5% 的亏损预算 ⇒ **一整天最多亏 5 笔**，第 6 笔连开都开不出来
④ (1+2%)^W × (1-1%)^5 ≥ 10  ⇒  W ≥ 118.8  ⇒  W = 119
⑤ 隐含胜率下界 = 119 / (119 + 5) = 96.0%
```

★ 第 ③ 步最关键、最容易被忽略：**亏损是有额度的，盈利没有。**
所以"多试几次总能成"在这里不成立 —— 一天的试错预算只有 5 次。

★ 浮点噪声也要处理：`Math.ceil(119.00000000000001)` 会变成 120，
而这个数会被念给用户听，**多 1 笔就是一次误报** ⇒ 取上界前减一个极小量。

### L6.16.6 杠杆不放大仓位（必须如实说成 `info`）

**仓位 = 1R 风险预算 ÷ 止损距离**；杠杆只决定"同样大的仓位要压多少保证金"。
所以"可以用高倍杠杆"对"10U 赚到 100U"这个目标**在数学上没有贡献**。

不写出来，用户会以为阻力在"杠杆没给够"，于是反复抬 `EV_MAX_LEVERAGE` ——
而那只会让**止损先于强平失效**。硬要求：

```text
1. allowHighLeverage 为真 ⇒ 必须产出一条 info（断言钉住 code = LEVERAGE_DOES_NOT_SCALE_POSITION）
2. 文案必须区分两种成因：
   · geometry 卡住 —— 与配置无关，是这一笔的止损太宽（调 EV_MAX_LEVERAGE **完全无效**）
   · config  卡住 —— 几何还能给更高，是配置只给到这么多（可调，但对目标无贡献）
   混成一句"杠杆不够"，用户会去调一个一半情况下完全无效的参数。
3. 用户明说了倍数且超过配置 ⇒ 再给一条 warn（EXPLICIT_LEVERAGE_CLAMPED）
4. 真正放大盈亏的是**更紧的止损**（同样 1R，0.4% 止损能开的仓位是 1.8% 的 4.5 倍）
   —— 但止损越紧越容易被噪声打掉。这句话也要说出来，否则用户会去压止损。
```

### L6.16.7 内化 AgentGit 的四处（全部落在 `server/mission/asset.ts`）

| 内化的设计 | AgentGit 里的形态 | 本项目的落地 |
|---|---|---|
| **身份 = 内容地址** | 快照 id 就是 commit SHA，且 **id 不写进 meta.json**（自指会引入第二层哈希）| `planId = m- + sha256(规范 JSON)[:40]`；**只哈希影响结论的字段，显式排除原文 `raw`** |
| **边缘脱敏** | supervisor 在交给 journal/WSS **之前**就地脱敏，原文永不先到 hub | 脱敏发生在**资产构造时**，不是导出时 —— 导出出口会不断增加，进账口只有这一个 |
| **不做"高熵即密钥"的猜测** | 明确拒绝把短口令当密钥（误报风暴），改为**显式登记** | 已知格式规则 + **环境变量名**登记表；短于 4 字节**拒绝登记并披露** |
| **一分支一会话，永不换手** | `Once a session occupies a branch, that branch never changes hands.` | **一份裁定书只能绑定一条执行线**；换 run 拒绝并给稳定标识 |

★ 排除 `raw` 的理由：不排除的话，**同一件事换个说法就会得到两个 id**，
引用碎成一堆语义相同、id 不同的副本 —— 等于没有引用。

★ **但"换说法"必须是逐条同义的。** 少说一个从句（例如这一版没提"可以用高倍杠杆"）
就是**另一件事**，id 理应不同。夹具写错会让断言变成"凡换词必换 id"的**反向**证据，
而它看起来只是在测同一件事（本轮第一次跑就栽在这里）。三条成对断言：

```text
逐条同义的换说法 → 同一个 id
少一个从句       → 必须换 id（否则"引用不可被静默替换"没有可判定的含义）
环境（权益）变了 → 必须换 id（这是"条件过期"能被识别的唯一依据）
```

★ **脱敏的反例断言比正例更值钱**：本项目资产里到处是 40 位十六进制内容地址
（含本模块自己的 id），任何基于**熵值**的判据都会把它们全标成密钥，
**在完全正确的资产上疯狂报红** —— 与"文档表格列数校验器把转义竖线当分隔符"是同一类错误。
所以断言必须两条都写：真密钥被抹掉（正例）+ 内容地址零误报（反例）。

### L6.16.8 启动腿：二次裁定 + 一任务一执行线 + 失败分类

```text
1. 二次裁定（不是相信传进来的 planId）。
   planId 是内容地址 ⇒ 重新裁定后 id 不一致 ⇔ 环境已变 ⇔ 当初那份"可行"**已经过期**。
   此时照旧启动 = "引用的是 A 时点的评估、实际跑在 B 时点"，而引用者无法察觉。
   ⇒ 不一致一律 PLAN_STALE 拒绝，并写事件。

2. 占用执行线**排在启动之前**（与 autopilot 的"预留先行"同一条理由）：
   先落账再动手 ⇒ 崩溃时留下一个**可见的**占用，而不是一次无记录的执行。

3. 失败分类沿用既有口径：
   · 明确没启动（ALREADY_RUNNING / KILLSWITCH_ACTIVE / AUTOPILOT_NOT_CONFIGURED）→ **释放占用**，可重来
   · 其余失败 → **继续占用**（我们不知道启动到底有没有发生），要重来请重新裁定
   宁可让用户多走一步，也不要留下一次无法对账的启动。
```

★ **语音层只裁定、不启动**：`start_mission` 在 `DANGEROUS` 名单里（它启动的是会自己反复下单的循环，
破坏力比单笔下单**更大**），但处理分支**排在 `isDangerous` 那块之前**，
只调 `planMission` 并回话 —— **不构造确认凭证、不调 `startAutopilot`**。
理由是启动许可需要一个**不会被认错的口令**，而两段式确认是"复述金额"口径：
拿它顶启动许可，界面上会把 `+50%` 显示成 50 美元，用户按字面理解为"投入 50 美元"。

### L6.16.9 门禁与破坏验证

| 项 | 值 |
|---|---|
| `test:mission` | **16 组（S-M1 ~ S-M16）**，全离线，归档 `artifacts/mission-latest.json` |
| `npm run ci` | **28 道**（27 → 28，`test:mission` 已进 `ci` 链）|
| 端点数 | **86 → 89**（`GET /mission`、`POST /mission/plan`、`POST /mission/start`）|

**两处破坏验证（先跑红、再修绿，都是真的做了）**：

```text
① 把 MISSING_SLOTS 的档位改回 block ⇒ S-M3 精确报红：
   「S-M3 缺槽位 → 证据不足 - 期望 "unverifiable"，实际 "infeasible"」
   这条证据同时证明：那个死代码 bug 真的存在，且这条断言真的能红。

② 去掉 parseGoal 里"金额前有连接词"的判定 ⇒ S-M2 报红：
   「S-M2 只说目标 → 本金为 null - 期望 null，实际 100」
   顺带抓出 P1-8：系统会回一句"你没说目标金额" —— 而这句话是**假的**。
```

★ 每条断言都要**成对写**：既要有"错了会红"的正例，也要有"对了不会误报"的反例。
只写一半的断言，要么漏报，要么会训练人去忽略它的红。

### L6.16.10 复现这一层的提示词（可直接粘贴）

```text
给这个系统加一层"接目标"的能力，验收标准是这一句能被执行：
「帮我使用该系统策略做okx测试网实测，10U做到100U,1天内，可以使用高倍合约杠杆」

硬要求：
1. 顺序必须是**先裁定、再启动**。启动之前要用系统**自己已有的**约束把目标逐条量一遍：
   1R 风险预算、当日亏损熔断、止损几何、成本地板、自动驾驶目标硬界、过拟合门。
   **不要新立任何"目标合理性阈值"** —— 那会造出第二份口径。
2. 裁定必须是**三态**：可行 / 不可行 / **证据不足**（缺证据一律不放行，fail-closed）。
   三态里每一态都要能被构造出来并通过测试 ——
   如果某一态在实现上**不可达**，那它不是三态，是两态加一个名字。
3. 不可行的理由**必须带数**：把"做不到"讲成"需要 119 笔盈利、只剩 5 笔亏损额度"。
4. 缺槽位**不许补默认值**：不说截止时间就是没说，进显式 missing 数组。
   反过来，**说过的槽位不许被报成没说** —— 缺证据的结论必须只针对真的缺。
5. 目标解析用**确定性规则**，不调 LLM（温度会变的东西不能当门禁）。
   措辞才允许交给 LLM。
6. 结论要落账（每次裁定、每次拒绝都写事件），因为"能报告进度"的前提是**每一步都能被核对**。
7. 启动腿必须**二次裁定**：传入的 planId 与重新裁定的 id 不一致 = 条件过期 = 拒绝，
   并说明"引用的是当时那份评估、实际跑在现在的条件上"这件事为什么无法被察觉。
8. 一份裁定书**只能绑定一条执行线**（换 run 拒绝），因为静默替换是不可被发现的。
9. 资产 id 用**内容寻址**，且只哈希影响结论的字段（排除原文），并显式排除 undefined 与键序。
10. 脱敏放在**资产构造时**，不做熵值猜测（只做已知格式 + 环境变量名登记，短值拒绝登记并披露），
    并写一条"内容地址不被误伤"的反例断言。
11. 每条断言都要**先把值改坏一次**看它真的报红；只写正例的断言等于没有断言。
12. 语音入口只**裁定并回话**，不启动循环 —— 启动许可需要一个不会被认错的口令，
    在口令定下来之前宁可让用户多点一次面板。
```

### L6.16.11 本层的明确不做

```text
1. 不做"语音直接启动任务" —— 缺一个不会被认错的口令（见 L6.16.8）。
   → **已于 L6.17 解除**：口令已落地，语音与面板走同一条校验。解除方式不是"把闸门打开"，
     而是"补上那把原本缺的钥匙"。
2. 不新立任何目标合理性阈值 —— 尺子全部来自既有常量（L6.16.4）。
3. 不让 LLM 参与槽位解析 —— 同 L6.11 的理由。
4. 不在缺槽位时补默认值 —— 「没说」与「说了 24 小时」是两件事。
5. 不把任务挪到别的场所去跑 —— 那会让"在做 OKX 实测"这句话变成假的。
6. 不把"高杠杆"当助力 —— 它对达成目标没有数学贡献，只能如实说成 info。
```

---

## L6.17 启动口令与双击启动（2026-09-17 · 第八轮）

> 对应进度文档 §3.19。这一节的重点不是"做了个口令"，而是**四个只有真的跑起来才会露出来的缺陷**。

### L6.17.1 口令 = 固定词 + 服务端一次性四位码

```text
「确认启动」+ 4821        （口令词写死，码由服务端签发，一次一签、10 分钟、用一次、错 3 次作废）
```

**固定词单独不够**（说一次就永久有效，等于拆掉闸门）；**四位码单独也不够**（没有语义，
用户不知道自己在授权什么）。分工要写清楚：

| 选择 | 挡的是 | 不是 |
| --- | --- | --- |
| 四位数字而非字母 | 语音识别把字母念串 | 抗暴力破解 |
| 不做前导零（1000~9999） | 「0042」被念成「42」 | 密码学长度 |
| 逐位留空格（`4 8 2 1`） | 合成语音把 `4821` 读成「四千八百二十一」 | 排版偏好 |
| 只对 `feasible` 签发 | **给不成立的目标配钥匙** | "目标成立"的证明 |

★ 长度与字符集由**"人能不能念对、机器能不能听对"**决定，不由"熵够不够"决定。
按后者设计会做出一个用户永远念不对的口令 —— 而它会以"安全"的名义通过评审。

### L6.17.2 ★ 门站错位置：过拟合门曾被当成启动门（与 L6.16.3 同型，方向相反）

```text
门拦在启动 → 启动被拒 → 累积阶段永不开始 → 证据永不累积 → 门永远给不出结论
           → feasible 成为一条永远走不到的分支
```

修法：档位 `block`/`hold` → `warn`，但**必须把后果念出来**（"启动后循环会停在累积阶段，
到不了交易阶段"）。只改档位不说后果，等于把一条重要事实降级成静默。

★ 通用提问：**"这个状态/分支在这个系统上真的可能发生吗？"**
配一句可执行的检查：能用真实数据构造出来吗？构造不出来，它就不是功能，是装饰。

### L6.17.3 ★ 「每一条拒绝配一条放行」——否则你证明的是"它很严格"

口令的 8 条拒绝路径（口令词不全 / 码错 / 码有多组 / 中文数字 / 过期 / 连错作废 / 已消费 / 被新码覆盖）
**每条都要有一条配对的"正确输入必须通过"**。

理由：**一个把任何输入都拒掉的实现能通过全部拒绝断言。** 反过来说也一样 ——
只写"对正确输入不报错"，一个永远返回 `true` 的实现能全绿。

★ 这条与本项目第 2 条判据（"它会不会对正确的输入报错？"）是同一枚硬币的两面：
**先修检查器，再相信它的红。**

### L6.17.4 ★ 读路径静默陈旧，会让下游所有结论一起静默失效

实测：`GET <ledger>/events` 是 `ORDER BY seq ASC LIMIT 500` 且端点从不传 `since`。
症状 —— 账本已到 **seq 32384**，端点稳定返回 **seq 1..500**（几周前的事件），
**条数一直是满的、也没有任何截断提示**。

它比直接报错危险，因为任何人（或任何 agent）用它回答"最近发生了什么"，
都会拿到一份**看起来完整**的旧证据，并据此得出**看起来正确**的结论。

修法：`since` 不传 = 取最新一段；返回 `order` / `total` / `truncated` 自报"这是窗口，不是全部"。

★ **门禁必须成对**，否则它抓不到这个 bug：

```text
只断言"返回了 3 条"          —— 旧的错误实现也返回 3 条，永远绿；
必须再断言"不传 since 与传 since=0 取到的是不同两段" —— 这样"取错了一段"才会报红。
```

★ 附带教训（我自己犯的）：本轮我先写了一条"口令明文没落账 ✓ 没有"，
它扫的正是这个陈旧窗口，而我要检查的事件在 seq 32371 之后 ——
**结论是对的，但当时的证据是无效的**；若真落了账，它照样打勾。

### L6.17.5 ★ 4xx 是业务结果，不是连通故障

界面点错口令时显示的是：`编排服务没有回应（HTTP 422 …）。先确认它在 8790 上跑着。`
服务端明明回了话，而且回的是可以直接照做的一句（"口令不对，还有 2 次机会"）。

根因：共用的取数函数在 4xx 上抛异常，调用方只剩一个字符串，于是只能猜。
后果：把用户引去排查一个**不存在**的问题，而真正该做的（重念口令）他不会做。

修法：给这类端点一个**不在 4xx 上抛**的取数函数，把 HTTP 状态码**交给调用方判别** ——
有状态码 = 业务结果（原样显示服务端的理由）；fetch 自己抛了 = 才是连通问题。

★ 通用提问：**"这个错误信息会把用户引向哪个动作？那个动作有用吗？"**

### L6.17.6 ★ `...Pct` 后缀同时表示两种单位（这次真的算错了）

| 字段 | 实际单位 | 错当成 | 界面上的错值 |
| --- | --- | --- | --- |
| `required.winPct` | **分数** 0.02 | 百分数 | `+0.02%`（应 `+2.00%`） |
| `required.lossPct` | **分数** 0.01 | 百分数 | `-0.01%`（应 `-1.00%`） |
| `required.impliedWinRate` | **分数** 0.643 | — | `+64.3%`（胜率不该带正号） |
| `plan.targetPct` | **已是百分数** 12 | — | 恰好对 |

★ 错值 `0.02%` **看起来完全像个正常数字**，所以它不是"一眼可见的 bug"。
修法有两层：
1. **把单位写进函数名**（`pctFromFraction` / `pctPlain` / `rate`）—— 让看错单位在调用点上是看得见的；
2. 在接口类型的字段注释里逐个标注单位 —— 让"这一层混了口径"成为**接口文档里的事实**，
   而不是下一轮某个人重新踩一次。

★ 顺带得到一个天然探测器：改对之后，面板卡片上的「至少盈利 11 笔 / 68.8%」
与播报里的「数学上还需要 11 笔盈利…隐含胜率不低于 68.8%」逐字一致。
**面板与播报同源，两边对不上就是有地方在偷偷改写数字。**

### L6.17.7 ★ 不要 `rm -rf` 一个大目录（会打爆本轮的删除配额）

本机 `safe-delete` 有一道「单轮批量删除」护栏（阈值 50，`scope: "turn"`）。
本轮我删 Chrome 临时 profile 时清掉 **3196 个文件**，随后**同一轮里**任何需要删文件的命令
都会被拦（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）—— 表现是**一个毫不相关的门禁突然崩了**，
而它上一次跑是绿的。

⇒ 判据：**清理动作与验证动作不要放在同一轮**。大清理之后，把验证留到下一轮再跑；
看到 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 时，先想"我这轮是不是刚删过一大堆东西"，
不要先去怀疑被测代码。

### L6.17.8 双击启动的三条硬约束（`scripts/app.ts` / `.cmd`）

1. **不用 dev server**：端口被占时 dev server 会**静默换端口**，而桌宠窗口连的是写死的 4173 ——
   界面上只表现为"没反应"。preview + `--strictPort` 端口被占直接失败，**失败是可见的**。
2. **判"要不要构建"看时间，不看"存在与否"**：只查 `dist` 在不在，改完 `src/**` 双击会打开一份
   **旧界面**，而它看起来完全正常。比的只有构建输入，不含 `artifacts/`（否则跑一次冒烟就要白构建）。
3. **进程级按死 `AUTOPILOT_LIVE=false`**，实盘须显式 `EVOLVE_ALLOW_LIVE=1`；
   变量名与 `.env` 的键**刻意不同**，免得被当成"上次留下的配置"。

`.cmd` 里只能放 ASCII（中文路径 + 非 ASCII 内容 = 乱码），`chcp 65001` 后再 `cd /d "%~dp0"`。

### L6.17.9 复现这一轮的提示词（可直接粘贴）

```text
给已有的「任务」层加一道启动口令，并把整套做成可以双击启动的 app，然后真的跑起来预览一遍。

口令要求：
1) 两半 —— 固定口令词 + 服务端签发的一次性四位码；只对"可做"的裁定签发。
2) 四位数字、不做前导零；念出来时各位之间留空格（合成语音会把 4821 读成"四千八百二十一"）。
3) 只能校验不能消费；要等所有拒绝理由都过了、动手之前那一刻才消费。
4) 明文与哈希都不许进账本；账本只记签发时刻、有效期、位数、次数上限这些可观测量。

门禁要求（缺一不可）：
- 8 条拒绝路径，每条都要配一条"正确输入必须通过"；
- 5 次变异测试，每次注入后必须报红、然后还原；
- 文案卫生单独一组：断言检查器自己会报红，再拿三类真实输入去验；
- 分页/取窗口的接口，必须成对断言"默认取最新"与"传 since 才是翻页"。

双击启动：
- 构建产物 + preview + --strictPort（不要 dev server：它会静默换端口）；
- 按源码 mtime 判是否要重新构建；
- 进程级按死 AUTOPILOT_LIVE=false；
- 停止脚本要重新观测一次再报告，不要信 taskkill 的返回码（PID 可能被复用）。

最后必须真的启动并走一遍：裁定 → 出码 → 故意错码 → 正码启动，并把每一步的**计算样式/接口原值**读回来核对，
不要只看截图。凡是"跑起来才发现"的缺陷，逐条记进进度文档。
```

---

## L6.18 进程监督取证：**退出状态本身不带信息**（2026-09-17 · 第九轮）

### L6.18.1 一句话定位

一个监督进程（把 ledger / orch / web 三个子进程拉起来并看着它们）**必须能回答"它为什么没了"**。
这一层不是"加日志"，而是承认一件反直觉的事：**`exit code` + `signal` 对定性这件事是零信息**，
于是把证据来源换到**子进程自己的遗言**上，并且**拒绝在证据不足时下结论**。

### L6.18.2 ★ 核心事实（本机实测，先跑一遍再写代码）

Windows 上，下面三种事因，父进程拿到的 `exit` 事件**逐字节相同**：

| 事因 | `code` | `signal` |
|---|---|---|
| 自己 `process.exit(1)` | `1` | `null` |
| 被 `taskkill /PID x /T /F` 打死 | `1` | `null` |
| 未捕获异常崩溃 | `1` | `null` |

（对照：`process.exit(7)` → `code=7`，证明码本身是能读到的。）

> ★ **你要复现的第一步不是写 guard，是先跑这个对照实验。**
> 结果会让你放弃"记录退出码"这条看起来最自然、实际零信息的路。
> 这条实验已固化成 `test:stack` 的 **S-K1** —— 换平台/换 Node 后它若报红，
> 说明这个前提变了，那时才可以重新考虑相信退出码。

**通用提问（建议加进审查清单）：**
> **「我准备记下来的这几个观测量，能不能唯一确定原因？」**
> 答不上来就不是取证，只是打印。本项目已有的两个同族提问是
> 「这个检查在什么条件下会变红？」（§L6.17.3）与「这个状态在什么输入下会被命中？」（§L6.16.3）。

### L6.18.3 三态定性：唯一允许说"不是崩溃"的条件

```
crashed        ⇒ self_crash      （记录文件里有崩溃记录 ⇒ 它是自己崩的）
armed 且无记录 ⇒ not_self_crash  （guard 活着而它一言不发 ⇒ 是被要求退出的）
其余           ⇒ unknown         （没有遗言机制 ⇒ 不下结论）
```

★ 第三档是本层最重要的返回值。**最贵的一类错误不是"查出假原因"，是"没人问就自动地自信了一下"**：
少了 `armed` 这一层，有人把 guard 从某个角色里摘掉之后，监督进程会继续宣布
"没记录 ⇒ 不是崩溃" —— **看起来完全合理、实际是假的**，而且**没有任何东西会报红**。
所以门禁不只断言 `unknown`，还要断言渲染出来的文字里**不出现"不是自崩溃"**（S-K4）。

推论一条：**"没有遗言"这个信号，只有在能证明"遗言机制本来应该工作"时才有意义。**

### L6.18.4 为什么"先落盘、再打印、最后才退"

`stackCore.shutdown()` 里早就有这行注释：

> 留一点时间让 stdout 刷完：本机往管道写是异步的，立刻退出会偶发把最后几行（往往正是结论）丢掉。

**同一条道理必须应用到子进程的崩溃路径上**，而它很容易被漏掉：
`console.error` 之后立刻 `process.exit(1)`，在 Windows 上同样可能把最后几行丢掉 ——
而那些行恰好就是崩溃原因。⇒ 顺序固定为：

```
① appendFileSync 真同步落盘   ← 主证据：管道可以丢，文件不会
② writeSync(2, ...) 尽力同步写 stderr
③ setTimeout(exit, 150) 再退  ← 给异步管道一点时间，尽力而为
```

★ 并且**安装 guard 时用 `writeFileSync` 截断写一行 `armed`**：
这样记录文件里的内容必然属于本次启动，父进程不需要按 mtime 去猜哪些行是上一轮的。

### L6.18.5 ⚠️ 两个会让人写错方向的坑

1. **日志时间戳用 `toISOString()` 会把现场指错 8 小时。** 它返回 UTC；本机 GMT+8，
   于是 `11:50` 的事故记成 `03:50`，而文件管理器/任务管理器/用户的记忆全是本地时间。
   判"这是多久以前"时会直接算错。⇒ 用带偏移的本地时间（`2026-09-17 11:50:27 +08:00`），
   老日志（无偏移后缀）与新日志一眼可分，不必改写历史。
2. **不要让门禁依赖"能删文件"。** 本机有一套**批量删除护栏**
   （`safe-delete-bulk-guard.cjs`），机制已读源码 + 读状态确认：
   阈值 **50**、计的是**目标目录里的文件个数（递归）**、按 `requestId = conversationRequestId || toolCallId`
   分桶、**只在放行时累加**、`deleteCount === 0` 直接放行、该工具调用有 approval 则放行且照常累加、
   清理靠 `updatedAt` 超 **7 天**。
   ★★ **桶按「会话」计，不按「一条用户消息」计** —— 实测证据是一个算术：
   某个桶 count=**3266**，而新一轮开局第一条删除命令就报 **3235** = 上一次批量清理的 **3196** + 39。
   ⇒ **一次 `rm -rf` 大目录会把整个会话的删除预算一次用光，之后本会话内任何未被放行的删除都被拒。**
   如果一道门禁靠"开局删掉旧临时文件"来保证干净，它就会**因为一个与它无关的原因变红** ——
   即"对完全正确的输入报错"，比不报错更费人。真红假红混在一起，这道门就废了。
   ⇒ 正确做法是**把"干净"交给命名**（文件名带 pid + 时间戳 ⇒ 天然是新文件），
     删除只作为**尽力而为的收尾**，失败要**说出来**但不判失败。
   ⇒ 附带一条同样重要的：**想跑 CI 就前台跑。** 后台运行的 Bash 调用拿不到 escalation 放行，
     而预算已为 0 ⇒ 后台跑时 `build`（vite 构建前必然清空 `dist/assets`）**必然红**。
     而**双击启动不受影响** —— 护栏只在 agent 的工具调用环境里生效，从资源管理器双击拿到的是干净环境。

### L6.18.6 门禁与破坏验证

- `test:stack` **6 组 S-K1~S-K6**（进 `ci` 链，门禁 28 → 29 道）。
- **破坏验证 6/6 报红**：改 `inferExitCause` 不看遗言 → S-K4；`probeCrashLog` 永远返回没崩 → S-K2；
  guard 不写记录 → S-K2；guard 不写 `armed` → S-K2；去掉 `shuttingDown` 检查 → S-K5；
  时间戳改回 UTC → S-K6（实际值 `04:34:13`，正好把那个 8 小时错位还原了一遍）。
- **S-K5 必须成对**：同一个夹具，自己 `exit(1)` → **必须**告警；被 `shutdown` → **必须不**告警。
  单看后者可能是假绿（handler 根本没接上）。
- **S-K3 的断言写成"两个报告相等"**（被打死的与自崩溃的 `code`/`signal` 逐字节相同）——
  这条相等关系本身就是"退出码不可信"的证明。

### L6.18.7 复现这一层时的提示词（可直接粘贴）

```text
给本地三进程栈（ledger / orch / web）补上"子进程为什么没了"的取证能力。按顺序做，不要跳步：

1. 先做对照实验并写成断言：在本机分别让一个子进程 ① 自己 process.exit(1)
   ② 被 taskkill /PID x /T /F 打死 ③ 抛未捕获异常崩溃，把父进程收到的 (code, signal) 打出来。
   如果三者相同，就接受"退出码零信息"这个前提，再往下做；如果不同，记录差异并重新设计。
   实验里必须有一个 process.exit(7) 的对照组，证明"码确实读得到"（否则可能是没读到而不是相同）。

2. 子进程侧：写 installCrashGuard(role)，挂 uncaughtException / unhandledRejection。
   处理顺序必须是 ① appendFileSync 同步落盘 ② writeSync(2) 尽力打印 ③ 延时 150ms 再退。
   安装时用 writeFileSync 截断写一行 armed 到记录文件（证明"机制本该工作"）。
   记录文件路径由环境变量 EVOLVE_CRASH_LOG 传入，路径约定只在 stackCore 里定义一次。
   抛出的东西要显式格式化 —— String(对象) 会念出 [object Object]，两个不同的崩溃会变成同一句遗言。

3. 监督侧：把 onUnexpectedExit 的参数从 (name, code) 换成一份报告，至少含：
   退出码、signal、存活时长、最后一行输出及其时刻、静默了多久、临终前 20 行、
   崩溃记录路径 / guard 是否 armed / 有没有崩溃记录。
   再写 inferExitCause 三态 + renderExitReport，两个入口（双击启动 / dev stack）共用同一份渲染。

4. 定性规则必须是三态，且第三态 fail-closed：armed 过才算"不是自崩溃"；
   没 armed 一律"无法判定"，并且**渲染文字里不许出现"不是自崩溃"**。
   给没有遗言机制的角色（比如 vite）留 unknown —— 不要为了让报告好看把它并进 not_self_crash。

5. 时间戳改成带偏移的本地时间（不要再 toISOString）。日志里的时间必须能和文件管理器对表。

6. 门禁 test:stack 至少 6 组：三种事因退出状态相同 + 对照码 / 自崩溃有遗言且落进文件 /
   被打死不是崩溃且退出状态与自崩溃断言相等 / 没 armed 时是 unknown 且不许下结论 /
   成对（自己退出要告警、被 shutdown 不许告警）/ 时间戳带偏移。
   ★ 准备夹具**不要用 rmSync 清旧文件**：本机删除配额会把它变成随机红灯。
     用覆盖写，并让"文件里有内容但没有 armed 行"成为 S-K4 的一部分。

7. 逐条破坏验证（改坏→跑→还原），6 处都要按预期报红，把每处被抓到的断言名记进文档。
```

### L6.18.8 本层的明确不做

```text
1. 不让监督进程去轮询子进程的"最后一条业务 seq" —— 那是在监管器里新引入一个活动部件
   （新的失败面），而"最后一行输出 + 崩溃记录"已经足够定性。理由要写进注释，
   否则下一个人会以为"忘了做"。
2. 不给第三方进程（vite）装 guard —— 装不上也不该装；它永远落 unknown，报告如实说。
3. 不把三态压成两态（unknown 并进 not_self_crash）。
4. 不回改历史日志里的 UTC 时间戳 —— 带偏移的新格式已能让两者一眼可分。
```

---

## L6.19 答非所问：**意图被静默换成一个数字**（2026-09-17 · 第十轮）

### L6.19.1 一句话定位

用户说了一句**任务**，系统回了一句**行情报价** —— 报价是真的，任务是丢的，
而用户从回答里看不出任何异常。这一层讲怎么发现、怎么修、以及**为什么判据不能写两份**。

### L6.19.2 ★ 核心事实：这是第三族失效，它的特征是"答案看起来对"

本项目已经记过两族"检查器失效"（P0 家族）：

```text
第一族 · 不可能失败的检查   —— 断言写成恒真，永远绿
第二族 · 不可能命中的状态   —— 分支写了但真实数据构造不出来，永不发生
第三族 · 没读懂被伪装成读懂了 —— ★ 本轮新增
```

第三族的特殊之处：**系统没有任何异常**。它没有报错、没有崩、**给出的答案还是真的**。
所以：

> **不能靠"回答看起来对不对"判断一句话有没有被读懂。**
> 一个答非所问的系统，最差的回答恰恰是那些"单独看完全正确"的答案。

通用提问（直接抄进 checklist）：

```text
「如果系统完全没读懂这句话，输出会长什么样？和我现在看到的能区分吗？」
「这个失败是响的，还是哑的？」—— 哑的失败必须**额外造一个观测点**，否则它不会被发现。
```

### L6.19.3 三处独立失效叠加：任修一处都不够

真实链路（拿它当模板，别的入口同理）：

| 环 | 失效 | 具体 |
|---|---|---|
| ① 解析 | 词表只认一种形态 | `MULTIPLE_RE = /翻\s*(\d+)\s*倍/` 要求**数字**，而中文最常说「翻倍」 |
| ② 判定 | 门槛太紧 + 没有第二判据 | `looksLikeMission` 要求「金额+目标」，缺一个就判"不是任务" |
| ③ 兜底 | **把"没读懂"降级成"读懂了"** | "认出标的但没动作词 ⇒ 当问行情" ⇒ 返回 `query_market` |

★ 第 ③ 环是最危险的设计：它**主动**给出一句看似合理的回答。
任何"兜底猜测"都该问一句：**猜错的时候，用户能不能发现？**

### L6.19.4 修法：判据只写一份，且必须排除"派生值"

```text
① 补齐词形态（`BARE_MULTIPLE_RE`）：认「翻倍 / 翻一番 / 翻番 / 两倍 / 十倍」，
   ★ 并**排除后面紧跟「杠杆」的** —— "10 倍杠杆"是仓位倍率，不是收益目标，差一个数量级。
   反向也要断言：`一倍` 不构成目标（说了等于没赚），认不出来比认错好。
② 新增并列判据 `hasExecutionSignal(spec)`：判"这是在提一件事，只是没说全"。
   意图层：`looksLikeMission(spec) || hasExecutionSignal(spec)`。
③ 兜底**不改** —— 它安全的原因只有一个：上一层用**同一个函数**接走了所有执行诉求。
   在那里另写一份"是不是任务"的正则，就是同一个动作的第二条实现路径。
```

判据必须两段，且第二段的存在理由**只能**是"不误伤闲聊"：

```text
① 两个及以上「强信号」→ 是执行诉求。
   强信号 = 场所 / 金额 / 目标 / 倍数 / 杠杆 / （没提场所却）显式说了测试网或实盘。
② 只有一个强信号 → 还要有"执行味的词"（目标类 或 产品类）**且**动作类。
   反例：「看看币安」只有一个场所信号，被追问本金同样是答非所问。
```

⚠️ **`execution` 在"说了场所"时是从场所派生出来的，不是独立证据。**
第一版没排除它，结果一句「看看币安」凑够两个信号、被判成执行诉求。
这是本轮**第一次**被自己的断言抓到的错误 —— 修法写进注释，否则下一个人会"顺手"简化回去。

### L6.19.5 ⚠️ 两个坑：都是**方向相反**的假绿

```text
坑 A · 用"别的修复顺带也能让它变绿"的输入去验证一条新接线
  我用**用户原话**验证"意图层接上了 hasExecutionSignal"，但那句话在裸倍数修好之后
  **本来就满足 looksLikeMission** ⇒ 撤掉接线，断言照样全绿。
  ⇒ 判据要选**只有该修复才救得活**的输入（我补的是「在OKX测试网做BTC永续」：
     没金额、没倍数，只有场所 + 产品词 + 动作词）。
  ⇒ 通用提问：**「这条断言依赖的这个修复，是不是别的修复顺带也能让它变绿？」**

坑 B · 合法值被写进坏值列表
  P13③ 的坏值列表里原本有 `'xl'`（当时非法，断言"会回落默认"）；
  本轮加了 `xl` 档之后它变成**合法值** ⇒
  「用户点特大号没反应」这个缺陷**永远测不出来**（断言本来就期望回落）。
  ⇒ 加新档位/新枚举时**逐项复查坏值列表**；坏值首选"拼写相近但不合法"（`'xxl'`）；
     正例断言改成**遍历所有合法值**，这样加档位时自动被覆盖。
```

### L6.19.6 门禁与破坏验证

```text
不新增门禁（总数仍 29）—— 不变量分别落进既有三道：
  test:voice    13 → 14 场景（+S1b：自我介绍 5 种问法 / 2 种"介绍某物"不误接 /
                          用户原话判成任务 / 槽位不全也接住 / 3 种问价仍是问价）
  test:mission  16 → 17 组（+S-M17：裸倍数 6 种 /「10倍杠杆」不误当目标 / 1 倍不算 /
                          3 条正例接住 + 4 条反例不被拖进裁定 / 语音层同一句话判成任务）
  test:pet      89 → 91 断言（P13 ③ 改遍历 · ③b 遍历合法档 · ⑩ 严格递增 · ⑪ 不超窗口 60%）
破坏验证 12/12（`_mutate9.mjs`），其中 M6 是**逼出假绿**的那一处。
★ 跑 CI 必须**前台**跑（后台拿不到删除放行 ⇒ `build` 必红），理由见 L6.18.5。
```

### L6.19.7 复现这一层时的提示词（可直接粘贴）

```text
我要给一个**交易助手**的语音入口补两类能力，先别写代码，按顺序做：

一、自查"答非所问"这条链路。用户报：他说「在OKX测试网做BTC永续，3天内翻倍」，
    系统回了一句 BTC 的报价。请你自己走一遍从「拿到这句话」到「产出回答」的全链路，
    找出**每一处**会把它变成报价的地方，并逐处说明触发条件。
    要求：不要只找一个根因就收工 —— 这类缺陷通常是几处失效叠加的。

二、自查"介绍自己"为什么答不上来。用户问「介绍一下你自己」，系统回了"我没听懂"。
    请检查意图词表里有没有覆盖这个问法，以及如果覆盖了，回答的内容是"操作清单"
    还是"身份与职责"。后者才是用户问的。

三、设计"执行诉求"判据。要求：
    1) 判据**只能写一份**，放在解析层，意图层与兜底**共用同一个函数**；
    2) 判据分两段：多信号 → 直接判定；单信号 → 还要有执行味的词佐证；
    3) 列出的每个"强信号"必须是**独立证据**，凡是"从别的信号派生出来的"都不许算；
    4) 正反成对：给我 3 条该接住的正例 + 4 条不许接住的反例（含"看看币安"这种
       "只提了场所、其实在闲聊"的句子），并说明反例为什么危险。

四、每个新增断言都要做破坏验证：把它依赖的实现改坏一次，确认它**真的会报红**。
    特别检查：这条断言依赖的修复，是不是**别的修复顺带也能让它变绿**？
    如果是，换一个只有该修复才救得活的输入。

五、最后用**真起服务 + 真发那两句话**做端到端验证（纯函数烟测不够 ——
    用户的抱怨发生在整条链上）。
```

### L6.19.8 本层的明确不做

```text
1. 不放宽 `looksLikeMission` 本身（它是"闲聊守卫"）。
   新增的是**并列的第二判据**，不是把它改松 —— 改松会把对话拖进裁定。
2. 不给"介绍自己"加 LLM 润色：身份与边界是**必须逐字可控**的内容
   （与意图层同一条红线：LLM 可以决定怎么说，不可以决定做什么）。
3. 不把 `xl` 设为默认档 —— 用户要的是"能选大的"，不是"默认就大"；
   默认偏小的理由（字幕才是窗口主体）没有被推翻。
4. 不顺手改 `MONEY_RE` 让它认「1万U」这类中文数量级 —— 那是另一条独立缺陷
   （"万/千"没被折算），夹带进来会让这一轮的改动无法逐条归因。
```

---

# Part I · 验证层与 CI（29 道门禁）

> v1 完全缺失。**这一层是"能不能相信这套系统"的答案**——没有它，前面所有架构描述都只是声明。

## I1 · 门禁清单（`npm run ci`，实测 28 道）

> ★ 2026-09-16 建立 · **2026-09-17 第九轮 29 道逐道实跑复核**（不是"跑一次没报错"——那是 `&&` 短路链，见 §I3 与 §3.6）。
> 断言数均为实跑输出取值，非文档抄写。本表随语音层落地由 24 → 25，随桌宠层落地 25 → **26**，随合并/keyScope 轮 26 → **27**，随任务层落地 27 → **28**，随进程监督取证轮 **28 → 29**。
>
> ⚠️ **本次复核顺带修掉了一批过时数字**（这些是 F-21 那类"同一事实抄了多份"的产物）：
> `test:gateway` 8 → **9 场景**、`test:voice` 11 → **12 场景**、`test:autopilot` 6 → **9 场景**，
> 以及 `recon`/`mirror`/`proposal-slo`/`surveillance`/`llm-provider` 从"—"补成实跑值。
> 改表时请从 `npm run ci` 的输出里取值，**不要照抄本表**。

| # | 命令 | 断言/规模 | 守护什么 |
|---|---|---|---|
| 1 | `lint` | — | 代码卫生（v3 已清零，见 F-18） |
| 2 | `typecheck` | — | 类型正确性（`tsc --noEmit`） |
| 3 | `test:orch` | — | 风控 / 熔断 / 晋升闸 / 资金帽 / 握手门 / **killswitch 三处同步** |
| 4 | `test:gateway` | **9 场景** | killswitch 与故障演练（归档 `artifacts/drill-latest.json`） |
| 5 | `test:promotion` | — | 引擎晋升状态机全链路回归（含**拒绝旧自报格式**的回归） |
| 6 | `test:recon` | **3 场景** | 对账逻辑与出站闸触发 |
| 7 | `test:mirror` | **3 场景** | 镜像互查（内存链 vs 持久链）+ **`/events` 读取语义（S5：默认取最新 / 传 since 才是翻页 / 截断自报 / limit 有上限；成对断言，避免"取错了一段"还全绿）** |
| 8 | `test:proposal-slo` | **5 场景** | 提案安全边界 + SLO 评估 |
| 9 | `test:surveillance` | **6 场景** | 操纵自监控标记 |
| 10 | `test:voice` | **14 场景** | 语音层：意图解析 / 中文数字归一 / **语音单与直连拿到逐字相同的拒绝理由** / 两段式确认 / 打断作废 / 播报限流 / **P0 不可压制** / 异动 / **播报溯源** / 配置与音色 / 端到端 / **文案卫生（不得出现占位符垃圾）** / **出声链路（拟人音色 · 报警不许重试失败过的云端 · 口型时间轴）** / **S1b 介绍自己与答非所问（"你是谁"5 种问法全接住 · "介绍某物"不许误接 · 用户原话判成任务而非报价 · 槽位不全也接住 · 真问价仍是问价）**（见 L6.11 / L6.15 / L6.19） |
| 11 | `test:pet` | **91 项 / 13 组** | 桌宠桌面外壳：窗口标志位 / 置顶层级 / **可找回性不变量** / 越界钳制 / 原生拖动 / 回声闸门 / 口型 / 照片裁剪 / 透明窗三处同向 / 主进程结构不变量（含 **冒烟判定靠协议行 + 存活轮询**）/ **P0 报警对比度** / **P12 单一入口·单一通道·单一实现** / **P13 头像尺寸有界·素材分流·动图不叠器官层·档位严格递增·最大档不超窗口 60%**（见 L6.12 / L6.13 / L6.19） |
| 12 | `test:keyscope` | **21 项** | **密钥权限范围自检**：Binance 三态（含"缺字段≠安全"）/ OKX `perm` 四形态（按逗号切分，不做子串匹配）/ **缺证据一律不放行** / **调用方无从自报结论** / 聚合器**最坏优先**（见 L6.14） |
| 13 | `test:sandbox` | 3 场景 | 沙箱：良性 / **四条出网通道全 BLOCKED** / 死循环击杀 |
| 14 | `test:autopilot` | **9 场景** | 自治：目标越界 / 防重入 / 选优 / 执行 / 止盈 / 回撤停机 |
| 15 | `test:llm-provider` | **5 场景** | LLM 适配器契约 |
| 16 | `test:commercial` | — | 商用加固：哈希链 + **篡改定位** / 指标聚合 / 提案边界 |
| 17 | `test:r20` | **40 项** | R20 内化 5 模块（见 Part L） |
| 18 | `test:risk-guard` | **29 项** | 风控内核：1R 定规模 / 止损几何 / 保本棘轮 / 预留与拦截管线 / 宪法红线 / **心法样本量不可自报（F-44）** |
| 19 | `test:trusted-seam` | **49 项** | 接缝 6 模块：成本闸门 / 对手方三档 / 跨通道结算 / 审批在环 / 声称核验 / 上下文预算 |
| 20 | `test:dex` | **11 项** | DEX 五链：合约完整性 / 规模匹配池深 / **拒绝侧正确** / 同源校验 |
| 21 | `test:leverage` | **29 项** | 微资金 × 杠杆：`maxSafeLeverage` 反推 / 强平几何 / 张数换算 / 通道地板拆分 |
| 22 | `test:verifier` | **18 项** | 独立复核：上下文隔离 / 独立重推 / 任一不符即拒 |
| 23 | `test:model-router` | **11 项** | 模型分层：未识别按付费 / `EV_LLM_ALLOW_PAID` 默认关 / probe 不走付费 |
| 24 | `test:overfit` | **30 项** | **过拟合门禁**：CSCV-PBO 正确性 / 凭据不可伪装 / 真实引擎接线（见 §3.10） |
| 25 | `test:mission` | **17 组（S-M1~S-M17）** | **任务层**：目标解析 / **缺槽位不补默认值且不误报** / **三态均可达且"证据不足"记 `hold`** / 场所名即契约 / **不可行必带数** / 达标数学（119 笔） / **杠杆不放大仓位** / **内容寻址的边界（同义换说法不换 id、少一个从句必换 id）** / 一任务一执行线 / 仅追加前缀校验 / **脱敏零误报（内容地址不被当密钥）** / 门结论倒扫账本（pin 绕过不是通过） / 端到端（见 L6.16） / **S-M14 启动口令：8 条拒绝各配一条放行、TTL 边界、连错作废、新码覆盖、单次消费、明文与哈希都不落账** / **S-M15 端到端启动（不可行不签发 → 可行才签发 → 错码被拒且不动状态 → 正码真的启动 → 不能重放 → 不与下单确认串台）** / **S-M16 文案卫生（检查器自身会报红 / 四类输入无 markdown 星号·叠标点·undefined·NaN / 回落时不自作主张）** / **S-M17 裸倍数与执行诉求（「翻倍」=2 倍 · 6 种裸倍说法 · 「10倍杠杆」不误当收益目标 · 1 倍不算目标 · 3 条执行诉求接住 + 4 条闲聊/问价不被拖进裁定 · 语音层同一句话判成任务而非报价）** |
| 26 | `test:stack` | **6 组（S-K1~S-K6）** | **进程监督取证**：**S-K1 三种事因的退出状态逐字节相同（自己 exit / taskkill 打死 / 未捕获异常 → 都是 `code=1 signal=null`；配 `exit 7` 对照证明码是真读到的）** / **S-K2 自崩溃留下遗言（`crashed=true` + 记录文件里真的有原因，不只管道里）** / **S-K3 被打死 ≠ 崩溃（armed 过、无遗言 ⇒ `not_self_crash`，并断言它的退出状态与 S-K2 相等）** / **S-K4 没 armed ⇒ `unknown`，且渲染文字里不许出现"不是自崩溃"（不许下假结论）** / **S-K5 成对：同一夹具自己退出必须告警、被 shutdown 必须不告警** / **S-K6 时间戳是本地时间且带偏移**（见 L6.18） |
| 27 | `backtest:golden` | 真门禁 | 复现性 / dataHash / **过拟合凭据结构与逐折自洽** / 基线比对 |
| 28 | `build` | — | `tsc && vite build` 产物构建。★ **它守的是一条别的门都守不住的不变量**：import 解析（见 L6.13.4） |
| 29 | `audit:sec` | — | 依赖漏洞（`npm audit --audit-level=high`，实测 0 vulnerabilities） |

> **`pet:smoke` 与 `keys:audit` 刻意不进 CI**：前者会真起一个 Electron 窗口（CI 不该弹窗，
> 也不该依赖"这台机器能不能建 GPU 进程/托盘"）；后者要联网 + 依赖真实密钥 + 结果非确定
> （进 CI 只会制造随机红灯）。要真验证时手动跑：`npm run pet:smoke` / `npm run keys:audit`。

**另有非门禁的运维脚本**（手动跑）：`scripts/okx-*.ts`、`binance-probe.ts`、
`inspect-mirror-db.ts`、`rebuild-audit-chain.ts`。

> **两条烟测的设计原则**（写新烟测时照此办）：
> 1. **只测语义不变量，不测数值。** 数值会随预设套件调整而变，测它们会把烟测变成维护负担；
>    而「未知状态必须继续占用预算」「指纹必须确定性」这类语义是稳定的。
> 2. **把「两套口径」当作第一类缺陷来测。** 本仓库历史上最贵的几类 bug
>    （账本错配、面板显示值与引擎执行值分裂、提示词口径与代码口径不一致）
>    都不是逻辑错误，而是**同一个事实存了两份**。
>    写断言时主动问：这个值在别处是否还有一份副本？如果有，加一条断言把它们钉死。
> 3. ★ **加一条新判据（2026-09-14 起）：这个检查在什么条件下会变红？**
>    答不上来就不是检查。`test:overfit` 替代掉的那个「自报 `wfRobust` 布尔量」就是反例——
>    它在产品路径上**永不触发**（见 §3.10 / F-41）。

## I2 · ⚠️ GitHub CI 与本地 CI 不一致

`.github/workflows/ci.yml` **只跑 5 道**：`lint` → `typecheck` → `backtest:golden` → `build` → `audit`（外加 `quote-check.cjs` 带 `continue-on-error`）。

**后果**：本地 **21 套 smoke 测试**（orch/网关/晋升/对账/镜像/提案/监控/**语音**/沙箱/自治/LLM/商用/R20/风控内核/接缝/DEX/杠杆/独立复核/模型分层/过拟合/**任务层**）
在 GitHub 上**完全没跑**。推送代码后看到 CI 绿，不代表资金路径回归通过。

**修复建议**：把 workflow 里的 step 替换成单条 `npm run ci`，
避免"两套门禁清单"再次漂移（这是 F-21 同类问题的又一实例）。

> ⚠️ 2026-09-15 复核追加一处：workflow 用 `node-version: 20`，而本地实测运行在 Node 22/25。
> 沙箱的网络封锁层依赖 Node 的 Permission Model 行为（`--import` 预加载 + CJS 命名空间改写），
> **两个大版本之间的行为差异没有在 CI 里被覆盖**。要么把 workflow 对齐到 22，要么显式记录"CI 不覆盖沙箱语义"。

## I3 · 验证纪律（写进给 AI 的提示词）

```text
1. 改代码后必跑 `npm run typecheck`；涉及 server/ 时加跑对应的 smoke。
2. 涉及执行/风控/账本（core.ts / risk.ts / gateway / venue / pipelineService）时，
   必须跑 `npm run test:orch && npm run test:gateway && npm run test:recon`。
3. 新增策略族的五步验收（缺一步即为死代码）：
   ① src/engine/strategies.ts 实现纯函数 decide
   ② 接入 buildCandidateSet 网格
   ③ server/autopilot.ts 的 rebuildStrategy 可重建
   ④ src/engine/index.ts 导出
   ⑤ typecheck + backtest:golden 通过
4. 发版前跑 `npm run ci` 全链。★ 任一道红灯即停，修完重跑全链——
   禁止"只重跑通过的那几道"。
5. 引用代码用 `file_path:line_number` 格式，便于复核。
```

---

# Part J · 文档治理地图（5 份文档 + 环境变量样例，谁说了算）

> v1 完全缺失；v2 给出诊断与建议；**v3 已执行收敛**。
> 收敛前 9 份文档中，有 4 份都在做「给 AI 的可复用提示词」这件事，
> 同一事实（fitness 版本、服务端口、门禁数）在 3~4 份里各写一遍 → 必然漂移。

## J1 · 收敛后的文档地图

| 文档 | 权威范围 | 状态 |
|---|---|---|
| `DEV-PROMPT-KIT.md` | ★ **技术事实 + 复现提示词的唯一出处**（架构 / 契约 / 坑位 / 门禁） | ✅ 本文档 |
| `DEV_PROGRESS.md` | ★ **完成度与缺陷清单的唯一出处**（能力矩阵 / 路线图 / 待决项） | ✅ 2026-09-15 复核 |
| `R20-BENCHMARK.md` | 外部项目对标与内化依据（R20 Quantum Trader） | ✅ 范围独立 |
| `SEAM-BENCHMARK.md` | 多源情报对标与内化依据（Web4.0 / 多 Agent 验证 / Skill 经济 / 加密量化成熟度） | ✅ 范围独立 |
| `PROMPT-KIT-METHOD.md` | 通用方法论母版（如何给任意项目做提示词套件 + LLM 提示词模板） | ✅ 吸收了 `PROMPT_ENGINEERING` 的模板 |
| `COMPLIANCE.md` | 合规能力映射与对客门槛 | ✅ 范围独立 |
| `README.md`（仓库根） | 面向使用者的入口说明 | ✅ 范围独立 |
| `.env.example`（仓库根）| ★ **环境变量的唯一权威** | ✅ 有效 |

> ⚠️ 2026-09-15 复核查出的一类漂移：**两份 BENCHMARK 文档曾长期不在本表内**。
> 文档地图漏项的代价是：新事实写进哪一份、由谁负责更新，变成没有归属的动作。
> **新增文档时必须同时更新本表**，否则它已经漂移了。

## J2 · 本轮已删除的 5 份文档与去向

| 已删除 | 日期 | 精华去向 | 删除理由 |
|---|---|---|---|
| `SYSTEM_PROMPT.md` | 08-24 | → 本文 **Part A** 的「工程纪律」段 + Part E 红线 | 与 PROMPT_ENGINEERING / PROD_PROMPT_KIT 三方重叠 |
| `PROMPT_ENGINEERING.md` | 08-23 | → `PROMPT-KIT-METHOD.md` 的**LLM 提示词模板**（模板 0–4）+ 本文 Part B | 项目梳理部分已被 v1/v2 的 Part B 完全覆盖 |
| `PROD_PROMPT_KIT.md` | 09-04 | → 本文 **Part M**（生产级交付与充值实测） | 端口 8787 与实况（8790）不符；发版门已并入 Part I |
| `PHASE_C_ARCHITECTURE.md` | 08-24 | → 本文 **Part H**（L6.1–L6.9 已完整覆盖其全部有效内容）| 阶段性设计草案，落地后已成历史 |
| `LLM-AGENT-TEAM.md` | 08-30 | → 本文 **Part K**（LLM 智能体团队） | 编排侧已实现大半，转为正式章节 |

> **保留原则**：文件不是按「有没有内容」删的，是按「有没有**独立权威范围**」删的。
> 一份文档若其内容全部可被另一份引用替代，它就是漂移源，不是资产。

## J3 · 冲突解决规则（写进给 AI 的提示词）

```text
当两份文档说法冲突时，按以下优先级判定：
1. 源码与 `npm run` 实测 > 一切文档（★ 最高优先级）
2. 完成度 / 达标状态 / 缺陷清单 → DEV_PROGRESS.md
3. 技术事实（架构/契约/端口/阈值/坑位） → DEV-PROMPT-KIT.md
4. 外部项目对标结论 → R20-BENCHMARK.md
5. 环境变量 → .env.example
6. 合规门槛 → COMPLIANCE.md
7. 发现文档与代码冲突时：以代码为准，并**更新文档**（不要只记录不修）

★ 反面模式（本仓库已发生）：同一个事实在 3~4 份文档里各写一遍 → 必然漂移。
  **每个事实只允许有一个权威出处，其余文档用引用而非复述。**
```

## J4 · 仍未完成的治理动作

- **F-14 端口三重来源**：`server/index.ts`（`PORT ?? 8787`）、`devStack.ts`（`8790`）、
  前端默认 `orchUrl`（`8790`）三处对端口的表述仍不一致；实跑用 8790 是因为 8787 被占用。
  ✅ 2026-09-12 已修掉**用户可见症状**（`MonitorPage` 离线面板的误导文案 + placeholder），
  ⏳ 根因未动：三处仍是各写各的常量。
  建议统一为「默认 8787，可用 `PORT` 覆盖，前端从同一常量读」并在三处引用同一来源。
- **F-18 CI 口径**：本地 `npm run ci` 跑 **28 道**（2026-09-17 逐道实跑复核 28/28），GitHub CI 只跑 5 道。
  差异本身是刻意的（CI 上跑不了需要网络的用例，且 workflow 用的是 Node 20 而本地是 22/25），
  但**没有文档说明哪 22 道被跳过、为什么**。建议在 Part I 补一张对照表（见 §I2）。
- **F-20 不可达子图**：**12 个文件 / 587 行**（2026-09-15 复核实测；原记录 11 文件 / 526 行已过期）
  = 3 个零引用容器（`FlowDashboard` / `StyleDashboard` / `VerdictDashboard`）
  + 9 个仅被它们引用的叶子（`CapitalFlow` `FlowBar` `RiskMeter` `LiquidityHeatmap`
  `FactorTable` `DecayChart` `PurityHeatmap` `RiskHeader` `EvidencePanel`），
  应**整体**删除或接线。★ 注意 `KpiTrend` / `KpiDrilldown` 被 live 的 `KpiRow` 引用，**别一起删**。


---

# Part K · LLM 智能体团队（合并自原 `LLM-AGENT-TEAM.md`）

> 原文档是 08-30 的前瞻方案，编排侧此后已实现大半（提案器、模型路由、决策流筛选修复）。
> 本节保留**仍然有效的角色设计与硬约束**，已实现部分转为复现提示词。

## K1 · 为什么需要多角色而不是单模型单次调用

单次调用里模型同时扮演「提出想法」和「评价想法」，必然倾向自我肯定——
它不会主动否决自己刚提的方案。**把质疑单独交给一个角色，是廉价的对抗性检验。**

五人分工的关键不在「多模型」，而在**职责互斥**：提案者不评审、评审者不控仓、控仓者不下单。
每个角色只需在自己的职责上做对，不要求它在全局上正确。

## K2 · 五人团队

| # | Agent | 职责 | 输入 | 输出 | 模型取向 |
|---|---|---|---|---|---|
| 1 | **因子研究员** | 挖掘新因子、参数变异 | 市场数据 + 现有因子库 + 相关性 | 候选策略提案（含理由） | 数学推理强 |
| 2 | **策略评审员** | 挑毛病、识别过拟合 | 候选回测报告 + WF 结果 | 通过 / 否决 + **具体质疑点** | 批判性强 |
| 3 | **风控官** | 仓位、回撤、相关性、集中度 | 当前组合 + 候选仓位 | 仓位上限 / **一票否决** | 保守、指令遵循好 |
| 4 | **执行交易员** | 择时、拆单、下单 | 已过审信号 + 风控约束 | 具体订单（含拆单计划） | 工具调用稳 |
| 5 | **复盘分析师** | 归因、总结教训 | 成交记录 + 盈亏归因 | 改进建议 → 反馈给 ① | 长上下文归纳 |

**模型分配**：每个角色可由**不同 provider 的不同模型**扮演，以发挥各自所长。
测试期统一使用免费模型（`mimo-v2.5-free` 实测可用；`deepseek-v4-flash-free` 上游曾不可用）。

## K3 · 决策流程（闭环）

```
市场数据 / K线
      │
      ▼
① 因子研究员 ──提出候选──▶ ② 策略评审员 ──通过/否决+质疑点──▶ ③ 风控官
                                                                  │
                                                     仓位上限 / 一票否决
                                                                  ▼
                              ⑤ 复盘分析师 ◀──归因── ④ 执行交易员 ──▶ 订单
                                   │
                                   └────── 改进建议 ──────▶ ①（闭环）
```

**三个设计要点**：
1. **风控官的一票否决是硬约束**——不依赖模型自觉，必须在代码层强制。
2. **执行交易员不能绕过风控**：下单前必须校验风控官给出的仓位上限。
3. **评审员否决时不丢弃提案**，而是带着质疑点回到研究员，形成迭代而不是终止。

## K4 · 必须守住的五条硬约束

```text
1. LLM 的输出只能当「建议」。仓位、名义金额、回撤的上限必须在代码层强制校验，
   不能靠模型「自觉」。
2. 风控官的否决是硬否决，不允许被后续环节覆盖。
3. 每个 Agent 的调用都要有超时和降级：调不通就退回确定性引擎，不能卡死主循环。
4. 思维链要落盘（写进事件流）——这是 nof1 式透明化的基础，也是事后审计依据。
5. 成本控制：高频场景下每根 K 线调 5 个模型很贵。研究员/评审员低频（每 N 根 K 线），
   执行交易员高频但用小模型。
```

> ⚠️ **第 3 条的实测教训**：本项目曾因 `chatComplete` 使用 15s 超时 + 默认
> `source:'human'`，导致即使 provider 已启用，LLM 也从未真正参与决策——
> **「配置看起来对」和「路径真的走到了」是两件事**，必须靠事件流验证，不能靠读配置。

## K5 · 与确定性引擎的关系

Agent 团队**不替代**确定性引擎，而是**在外层提供搜索方向**：

- 确定性引擎（网格 + 适应度 + WF）负责**评估**：任何提案都要过同一套回测与稳健性校验。
- Agent 团队负责**生成**：在巨大的参数空间里提出有依据的候选，而不是穷举。

**因此：LLM 提案被拒是正常且必要的**，不能因为「模型提了就该采纳」而降低门槛。
本项目实测中提案被拦的主因是 `NOTIONAL_EXCEEDS_LIMIT`——这是风控在正常工作，不是 bug。

## K6 · 决策透明化（nof1 范式）

用户明确要求「看到因为什么所以怎么做」。落地要求：

- 每个 Agent 的**输入摘要 + 输出 + 理由**都要落事件流，不只是最终决策。
- UI 展示**中文**理由，形态为「因 → 果」（如「4H 多头通道 + 1H ADX 26 → 顺势开多」）。
- 决策理由要能追溯到**具体阈值**（哪个门禁放行的、哪个拦截器拦的、拦的理由是什么）。
- 模式标签（SIM / PAPER / LIVE）在 UI 上必须以**中文**呈现（模拟 / 纸交易 / 实盘）。

## K7 · 前端契约（编排器需提供的事件）

原文档 §3 列出的契约在 Part D3「编排服务 API 契约」中已完整覆盖。
决策大脑页消费的主要事件：`AUTOPILOT_*` 系列 + `PROPOSAL_*` + `INTERCEPTOR_*` +
`AUTOPILOT_INTERCEPTED`（含拦截原因）。本轮新增的 `AUTOPILOT_RESERVATION_*`
与 `POLICY_*` 亦应纳入决策流展示。

---

# Part L · R20 对标与内化（合并摘要，完整版见 `R20-BENCHMARK.md`）

> **本文只记录「内化成了什么形态」；「R20 原本怎么做、为什么学它」见 `R20-BENCHMARK.md`。**

## L1 · 内化的 5 项能力

| # | 能力 | 落地模块 | 解决的问题 |
|---|---|---|---|
| 1 | 组合风险预算原子预留 | `server/riskReservation.ts` | **LEDGER_MISMATCH 根治**：未知状态显式化 + 孤儿不自动释放 + 跨所合看 |
| 2 | 决策证据可观测性分档 | `server/decisionObservability.ts` | 防止「表面可观测、实际不可归因」的空壳污染自进化样本 |
| 3 | 策略政策快照与一键回滚 | `server/policySnapshot.ts` | 四单元确定性指纹 + 归档 + 回滚（回灌后比对指纹）|
| 4 | 风控口径插值进提示词 | `server/riskBrief.ts` | 消除「提示词一套口径、代码另一套」的静默分裂 |
| 5 | 原子写盘 | `server/atomicWrite.ts` | 写坏 `.env` 会导致全部风控参数静默回落默认值 |

## L2 · 复现这五项时的提示词

```text
在服务端新增五个模块，全部服务于「消除静默分裂」这一目标：

1. atomicWrite.ts —— 同目录临时文件 + write + fsync + rename 覆盖。
   失败路径必须清理临时文件。用它替换所有 .env / 配置类文件的裸 writeFileSync。
   理由：裸 writeFileSync 是「先截断再写」，进程被 kill 或磁盘写满时会留下半截文件；
   被写坏的 .env 会让全部风控参数回落到代码默认值，而面板仍显示旧值。

2. riskReservation.ts —— 组合风险预算原子预留台账（node:sqlite + BEGIN IMMEDIATE）。
   状态词表六态：占用态 pending/partial/unknown/confirmed，终态 rejected/closed。
   四条不可动摇的语义：
   a) confirmed 仍占用（确认成交到平仓之间风险依然真实）；
   b) unknown 全额占用，绝不释放（「本地丢了」≠「场所没有」）；
   c) 终态幂等不可复活（已释放的意图再提交，原样返回不改写）；
   d) 孤儿只标记 pending_cleanup，不自动释放（等对账器拿到场所侧结论）。
   越界时整体回滚，绝不部分占用。提供跨所合看：totalReservedByVenue + grossExposure。
   账户键按 {venue, environment} 建模，使 paper 与 live 预算隔离。
   接线顺序必须是「预留先行 → 发单 → 按回执推进」：
   发单前落账，崩溃重启后 recoverOrphans 仍能找到这笔未知敞口。

3. decisionObservability.ts —— 四档分档 DYNAMICS_OBSERVED/PARTIAL/PRICE_ONLY/NONE。
   只按「解释价格为何这样动」的字段计数（ATR/ADX/结构位/动能），不收 price。
   0 与 false 是有效值；NaN/Infinity/空串算缺失。
   提供 isSampleQualitySufficient：数量与可归因占比必须同时达标。

4. riskBrief.ts —— 把执行层实时阈值渲染成【本周期风险预算】块插值进 LLM 提示词。
   必须读 riskConstants 的活绑定，不能读 riskConfig 的 DEFAULTS 表。
   措辞须含：当前值、这是执行层硬约束、已禁用的能力明文禁止申请。
   API 同时返回结构化值与渲染文本，保证面板与提示词同源。

5. policySnapshot.ts —— 四单元（风控参数/心法库/拦截闸门/模型路由）确定性指纹。
   指纹必须确定性：对象键排序后拼装、数值归一化、不含时间戳/id/运行期计数。
   拦截器的 order 是语义字段（顺序会改变拦截结果），必须参与指纹。
   归档默认 skipIfUnchanged；索引损坏时从快照文件重建。
   回滚后重新采集指纹并比对；导入只校验不直接回灌。
```

## L3 · 明确不内化（避免「对标=全盘照抄」）

| 项 | 理由 |
|---|---|
| Python 插件热插拔执行用户代码 | 与「用户代码必须进程级隔离」的红线冲突；要做应做成子进程 + 契约 RPC |
| 微积分动能引擎（v / a / κ） | 当前样本量不足，加三个新超参只会增加调参噪声 |
| 同 base_url 优先的回退模型链 | 单 provider 无收益，且会让「谁在做决策」不可追溯 |
| 参谋委员会交叉质询 | 席位配置层尚未落地，跳步是本末倒置（见 Part M 待决项）|
| R20 的阈值取值本身 | 风格不同不是对错：R20 面向小资金高周转，EVOLVE 当前以本金安全为先 |

---

# Part M · 生产级交付与充值实测（合并自原 `PROD_PROMPT_KIT.md`）

## M1 · 商用生产级（L5）差距

从「能跑」到「能对客」，缺的是**资质与合规**，不是功能：

| 维度 | 当前状态 | L5 门槛 |
|---|---|---|
| 密钥管理 | `.env` 明文（仅本地开发） | 机密管理服务 / KMS |
| 审计 | SHA-256 事件哈希链 ✅ | 独立审计留存 + 可导出 |
| 合规 | 自监控 + 异常上报 ✅ | 持牌主体 / 合格投资者流程 |
| 资金 | paper 虚拟资金 | 托管 / 多签 / 限额 |
| 可用性 | 单进程 | 多实例 + 故障转移 |

> ⚠️ **不要用「功能已齐」推导「可以上线」**。上表右列全部是**资质与运维**问题，
> 写代码解决不了。凡是涉及真实资金的推进，必须逐项书面确认。

## M2 · 充值实测操作序列（每步需用户逐项书面确认）

```text
以下步骤按顺序执行，**每完成一步停下来等确认**，不得连做：

1. 确认 STOP 状态：killswitch 处于冻结、自治循环已停止、无未平持仓。
2. 导出当前策略政策快照并归档（POST /policy/archive），记录指纹。
   理由：实测出问题时要能一键回滚到「实测前」这个对象。
3. 核对预留台账为空或与场所一致（GET /reservations/summary），
   若有未释放预留，先查明原因，不得直接清空。
4. 用最小金额（不是最小可行金额，是「全部亏掉也不影响」的金额）跑第一笔。
5. 成交后立即核对：本地账本 vs 场所余额 vs 预留台账，三者必须一致。
6. 对账通过才允许放大金额；任一步不一致即回到 1 并归档现场。
```

> ⚠️ **第 2 步是新增的，也是本轮内化带来的直接好处**：在本轮之前，
> 没有任何机制能回答「实测前的配置是什么」——回滚只能靠人肉回忆改了哪几个键。

## M3 · 日常运维任务提示词（合并自原 `PROD_PROMPT_KIT.md` §3）

> 这四条是**日常重复执行**的任务提示词，可直接复制使用。
> 与 Part A 的区别：Part A 是「从零复现」，这四条是「在已有系统上做事」。

**① 每日运行状态查询**

```text
查询 orchestration 运行状态并如实报告，不做任何交易动作：
GET /healthz（uptime / killswitch / mode）
  → GET /autopilot（running / stage / cycles / pnlPct / winner）
  → GET /state（equity / positions / orders）
  → GET /reservations/summary（跨所敞口与未释放预留）
报告「运行时长、当前盈利、持仓、阶段、敞口」。若 autopilot 为 idle，
直说未运行、盈利为 0，不要用历史成绩充数。
```

**② 新增策略族（五步缺一即为死代码）**

```text
① src/engine/strategies.ts 实现纯函数 decide；
② 接入 buildCandidateSet 网格；
③ server/autopilot.ts 的 rebuildStrategy 可重建；
④ src/engine/index.ts 导出；
⑤ npm run typecheck + npm run backtest:golden 通过。
缺任一步即为死代码，上线前逐项勾选。
```

**③ 风控 / 执行链路变更**

```text
改动 core.ts / risk.ts / gateway / venue / pipelineService / riskConstants.ts 后必跑：
npm run test:orch && npm run test:gateway && npm run test:recon && npm run test:risk-guard，
并用小单在 paper 面验证 ORDER_SUBMIT → ACK → FILL 全链路，再谈 live。
★ 若改动了风控阈值本身，额外跑 npm run test:r20 —— 它守护「实时口径与面板一致」。
```

**④ 发版门**

```text
npm run ci 全绿才放行（28 道，见 Part I）。
任一道红灯即停，修完**重跑全链**，禁止「只跑通过的那几道」。
★ 门禁之间常有隐含依赖（如 build 失败会让 golden 的产物比对失真），
  跳过某道会让后续结果失去意义。
```

---

## M4 · 发版门（内容已并入 Part I）

原文档的「九道发版门」在 Part I 已扩展为 **28 道**（`npm run ci` 全绿才放行）。
**以 Part I 为准**，此处不再复述——避免同一事实两处维护导致漂移。

⚠️ **门禁数量 ≠ 门禁有效**：一个从没被跑到的门（因为短路）与一个红灯的门，
在"给人安全感"这件事上是等价的——**都是零**。
当天实况以 Part I 的逐道实跑表为准（2026-09-16 建立 · **2026-09-17 复跑 27/27 PASS**）。
★ 此处刻意**不写死当天数字**：这一段曾长期挂着"15/18 通过，3 道红"，
而那三道 2026-09-13 就已闭环——**"当前实况"是最会过期的一类句子**，
真要写就必须带日期，并且和 Part I 同源。

---

## 附录 · 复现时的推荐执行顺序

```
【前端轨】
1. L0 骨架 + 设计令牌          → 能跑起来空白壳
2. L1 行情                     → 看到真实价格跳动（最有成就感的里程碑）
3. L5 Store 状态机             → 为后续层提供状态承载
4. L2 钱包                     → 能连上钱包看余额
5. L3 DEX                      → 能出链上报价（先只做报价，再做签名）
6. L4 引擎（纯函数优先）        → 先 fitness + strategies，再 WF，最后 promotion
7. 页面填充与视觉打磨

【服务端轨】（可与前端轨并行，但依赖 6 的引擎内核）
8.  L6.1 骨架 + 鉴权 + 生产 fail-closed   → /healthz 能通
9.  L6.2 风控闸                            → 拒单原因可解释
10. L6.6 账本 + 审计链 + 持久化            → 重启后事件可续、链可校验
11. L6.3 执行网关 + L6.4 sandbox 适配器    → 全链路能跑通（无外部副作用）
12. L6.5 晋升内禁                          → live 意图必须带策略身份
13. L6.7 自治循环 + LLM 提案器             → 一键自治能自己选策略并交易
14. L6.8 可观测 + 对账 + 合规监控          → 出问题能看见
15. L6.9 沙箱                              → 用户代码安全评估
16. 补齐 Part I 的门禁清单（现 28 道）      → 每加一层就加对应 smoke，不要最后补
```

> **两条建议**：
> 1. **L4 引擎全部是纯函数，先写测试再接 UI。** 这层的 bug（如 F-1 版本号不一致）
>    在 UI 上很难发现，但在测试里一跑就现形。
> 2. **每加一层编排能力，同步加一道 smoke。** 本仓库的 21 套 smoke 不是一次写成的，
>    而是"能力落地即配门禁"累积出来的——事后补测试的成本是同步写的数倍。
>
> ⚠️ **最后提醒**：复现前必读 **Part F-15**。代码默认值已修正为 paper（fail-safe，已运行时验证），
> 但**本机 `.env` 显式设了 `AUTOPILOT_LIVE=true`** —— 复现到新环境时第一件要确认的就是这一行：
> 它决定你是否在出真实资金。**代码默认值安全 ≠ 你的部署安全。**
> F-18 的 lint 已在 v3 清零，但 **GitHub CI 与本地 CI 口径仍不一致**（28 道 vs 5 道），
> 首次在新环境跑门禁时请以 `npm run ci` 为准。
>
> ⚠️ **新增提醒（v3）**：先跑 `npm run test:r20` 与 `npm run test:risk-guard`
> 这**两套纯逻辑烟测**（共 69 项断言，不需要网络、不需要交易所）。
> 它们会在 1 秒内告诉你「风控内核与账本语义是否完好」——
> 这是判断一个陌生环境能不能信的最快方式。
