/**
 * 服务的**自我声明** —— 全仓库唯一一份。
 *
 * ── 它解决的是一个真出过的错 ──────────────────────────────────────────
 * 「能连上」与「是我们」是两回事，而本机实测过它们**不一样**（2026-09-21）：
 *   隔壁工作区的 Python `dash_server.py` 占着 `127.0.0.1:8790`，
 *   我们的编排层占的是 `0.0.0.0:8790` / `[::]:8790`。Windows 上这两条可以同时成立，
 *   且**更具体的绑定赢** ⇒ 往 `127.0.0.1:8790` 发请求，答话的是**别人的服务**。
 *
 * 于是有两处**用法完全正常、结论完全错**的输出：
 *   ① 启动器的健康探测用「HTTP 有没有响应」当判据 ⇒ 通的是别人，却报"就绪"。
 *      （判据 2 的镜像：这条判据对**正确的输入**也会绿，所以它不是检查。）
 *   ② 启动器的运行时自检读 `/fleet/autonomy` 拿到别人的 404，
 *      打印三行「⚠ 读不到 —— 这不等于「没有」」—— **三行指向错误动作的假警**。
 *
 * ⇒ 判定必须问一句「你是谁」。`/healthz` 必须回答 `role`，
 *   而这一格的名字、取值集合、识别函数**只能在这里出现一次**。
 *
 * ── 为什么单独一个文件而不是塞进 stackCore ────────────────────────────
 * 两个服务进程（`index.ts` / `ledgerServer.ts`）与栈内核都要用它。
 * 塞进 stackCore 会让被监管的服务去 import 监管代码（`child_process` 那一套），
 * 关系就反了。这个文件**零依赖**，谁都能安全地引。
 */

/** `/healthz` 响应体里那**一格**。改它 = 改协议，全仓库只有这一处。 */
export const HEALTH_ROLE_FIELD = 'role'

/**
 * 会自报身份的角色名。**取值必须与 `stackRoles()` 里的 `name` 逐字相同** ——
 * 否则"启动器等的是 A、服务报的是 B"，等待会一直超时，
 * 而超时的表现是"启动失败"（看起来像服务挂了，其实是名字对不上）。
 * 这条一致性由 `stack-smoke` 的 S-I1 钉住。
 */
export const SERVICE_ROLE_NAMES = ['ledger', 'orch'] as const
export type ServiceRole = (typeof SERVICE_ROLE_NAMES)[number]

/**
 * 从 `/healthz` 的响应体里读出服务自报的角色。
 *
 * ★ 读不出就是 `null` —— **不是**"默认是我们"。
 *   把"读不出"当成通过，等于把这条检查变成永远绿的装饰。
 */
export function healthRoleOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const v = (body as Record<string, unknown>)[HEALTH_ROLE_FIELD]
  return typeof v === 'string' && v !== '' ? v : null
}

/** 这一格是不是它自己。**判据只有这一处**，两个调地方（等待 / 解析）共用。 */
export function isServiceRole(body: unknown, role: ServiceRole): boolean {
  return healthRoleOf(body) === role
}
