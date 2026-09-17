/**
 * 沙箱网络封锁层 —— 在策略代码之前加载，把所有出网通道堵死。
 *
 * ## 为什么必须有它：`--permission` 挡不住网络
 *
 * Node 的权限模型（`--permission`）覆盖文件系统、子进程、worker_threads、WASI，
 * 但**不覆盖网络**。也就是说，一个在 `--permission` 下运行的沙箱脚本，
 * 依然可以自由地 `fetch('https://…')` 把数据送出宿主。
 *
 * 对本项目来说这不可接受：沙箱里跑的是 LLM 生成、可能失控的策略代码，
 * 它能读到 K 线、策略参数，也可能读到宿主注入的任何东西。
 * 「沙箱内不能联网」必须是**由这段代码自己保证的事实**，
 * 而不是一个「以为开了」的开关 —— 后者比没有防护更危险：
 * 它让沙箱的存在变成一种虚假的安全感。
 *
 * ## 为什么不是简单地把 fetch 置为 undefined
 *
 * 因为出网通道不止 `fetch` 一条。至少要同时堵住：
 *   - Web 标准出口：`fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource`
 *   - Node 底层：`net.connect` / `tls.connect`
 *   - HTTP 族：`http.request` / `https.request` / `http2.connect`
 *   - 其他：`dgram.createSocket`（UDP 外发）/ `dns.*`（DNS 外泄的隐蔽通道）
 *
 * 只堵 `fetch` 是典型的「堵了正门，后门大开」。
 *
 * ## ⚠️ 加载顺序是这个文件里最容易踩的坑
 *
 * 内置模块的 ESM namespace 对象是 **exotic object**：
 *   - `Reflect.set(ns, 'connect', x)` 恒返回 `false` —— 命名导出**不可写**；
 *   - 它的属性是 CJS exports 的**值快照**，不是 live accessor。
 *
 * 所以一旦某个模块的 ESM facade 被创建，它的命名导出就永远改不动了。
 * 唯一有效的顺序是：
 *
 *     先用 CJS `require()` 拿到 exports 对象 → 改好 → **然后**才 import
 *
 * 实测对照（同一份代码，只换顺序）：
 *   - 先 `import('node:dns')` 再改 exports → 命名导出仍是原函数 → `dns.lookup` 放行
 *   - 先 `require('node:dns')` 改好再 `import` → 命名导出即封锁版
 *
 * 本文件因此**全程只用 `createRequire`**，绝不 import 任何待封模块 ——
 * `--import` 保证本模块先于 worker 求值，于是 worker 那边 import 时
 * 拿到的已经是封锁版快照。
 *
 * ## 能力边界（写清楚，免得下次有人以为这是一道物理墙）
 *
 * 已覆盖：`fetch` / `WebSocket` / `EventSource` / `net.connect` / `tls.connect` /
 * `http(s).request` / `http2.connect` / `dgram.createSocket` / `dns.*`
 * —— 也就是「用标准 API 发起出网」的全部常规路径，含模型生成代码的典型写法。
 *
 * 未覆盖：在 JS 层够不到的更深路径（原生插件、`process.binding` 之类）。
 * 真要那道墙，正确做法是在**进程外**隔离（容器网络命名空间 / 独立 namespace），
 * 或者等 Node 权限模型补上网络维度。在 JS 层每多封一层，
 * 都多一分把运行时自身弄坏的风险 —— 而那不叫安全。
 */

import { createRequire } from 'node:module'

const MARK = 'SANDBOX_NETWORK_BLOCKED'

function deny(label: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`${MARK}: ${label} 在沙箱内被禁止`)
  }
}

/**
 * 用 defineProperty 而非直接赋值：部分导出是 accessor 属性，
 * 直接赋值会静默失败（非严格模式）或抛错（严格模式），
 * 两种结果都是「封锁看着装上了、实际没生效」。
 */
function patch(exportsObj: unknown, names: string[], label: string): void {
  if (!exportsObj || (typeof exportsObj !== 'object' && typeof exportsObj !== 'function')) return
  const obj = exportsObj as Record<string, unknown>
  for (const n of names) {
    if (typeof obj[n] !== 'function') continue
    const blocked = deny(`${label}.${n}`)
    try {
      Object.defineProperty(obj, n, { value: blocked, writable: true, configurable: true, enumerable: true })
    } catch {
      try {
        obj[n] = blocked
      } catch {
        // 两处都改不动就放弃这一项
      }
    }
  }
}

/** 用 defineProperty 封印全局，让沙箱代码无法把它改回来。沙箱进程用完即退，不需还原。 */
function sealGlobal(name: string): void {
  try {
    Object.defineProperty(globalThis, name, {
      value: deny(`globalThis.${name}`),
      writable: false,
      configurable: false,
      enumerable: false,
    })
  } catch {
    // 该运行时版本可能根本没有这个全局（如旧版没有 EventSource），跳过
  }
}

for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
  sealGlobal(name)
}

const require_ = createRequire(import.meta.url)

/** 待封锁的模块：specifier、要替换的导出名、日志标签。 */
const TARGETS: [string, string[], string][] = [
  ['node:net', ['connect', 'createConnection'], 'net'],
  ['node:tls', ['connect'], 'tls'],
  ['node:http', ['request', 'get'], 'http'],
  ['node:https', ['request', 'get'], 'https'],
  ['node:http2', ['connect'], 'http2'],
  ['node:dgram', ['createSocket'], 'dgram'],
  ['node:dns', ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny'], 'dns'],
  ['node:dns/promises', ['lookup', 'resolve', 'resolve4', 'resolve6'], 'dns.promises'],
]

for (const [spec, names, label] of TARGETS) {
  try {
    // 只 require，绝不 import —— 见文件头「加载顺序」一节
    patch(require_(spec), names, label)
  } catch {
    // 该运行时版本没有这个模块，或不允许 require，跳过
  }
}

// `new dns.Resolver().resolve(...)` 绕过模块级函数，所以原型也要封。
// 这里不改 net.Socket.prototype.connect：实测那样会打断 worker 的 stdio
// （Node 内部建 stdio 也走它，进程会以 `Error: write EOF` 崩掉）。
for (const [spec, proto, names, label] of [
  ['node:dns', 'Resolver', ['resolve', 'resolve4', 'resolve6', 'resolveAny'], 'dns.Resolver#'],
  ['node:dns/promises', 'Resolver', ['resolve', 'resolve4', 'resolve6'], 'dns.promises.Resolver#'],
] as const) {
  try {
    const mod = require_(spec) as Record<string, unknown>
    const ctor = mod?.[proto] as { prototype?: Record<string, unknown> } | undefined
    const p = ctor?.prototype
    if (!p) continue
    for (const n of names) {
      if (typeof p[n] !== 'function') continue
      try {
        Object.defineProperty(p, n, { value: deny(`${label}${n}`), writable: true, configurable: true, enumerable: false })
      } catch {
        /* 改不动则跳过 */
      }
    }
  } catch {
    /* 模块不可用时跳过 */
  }
}
