/**
 * 神经语音合成（把"生硬的机器音"换成拟人音色）
 *
 * ── 为什么不能继续用 `speechSynthesis` ────────────────────────────────
 * 浏览器那套合成的声音来自**操作系统装的语音包**。Windows 上能拿到的
 * Huihui / Yaoyao / Kangkang 全是 SAPI5 时代的**拼接式**合成 ——
 * 字与字之间是硬接的，没有韵律建模，听感就是"机器在念字"。
 * 这就是"音色太生硬、一点都不拟人化"的全部原因：换档位、调音高都救不了它，
 * 那是在同一条劣质管线上做微调。
 *
 * 真正拟人化的是**神经 TTS**（豆包、ChatGPT 语音、Edge 的"大声朗读"都是）。
 * 本项目选 Edge 那条：零密钥、中文音色质量高、延迟约 1.5 秒。
 *
 * ── 这里为什么不引入 `ws` 依赖 ──────────────────────────────────────
 * 服务端只需要一个极小的 WebSocket 客户端：发两个文本帧、收若干二进制帧。
 * 而 `ws` 会连带一整套服务端实现。所以这里手写握手与帧编解码 ——
 * 约 100 行，换来**零新依赖**。本项目的立场是明确的：
 * 不为一个不参与风控的装饰性能力引入重型依赖。
 *
 * ── 实测出来的四条能力边界（2026-09-17，本机真跑）─────────────────────
 * 这些不是猜的，是逐条量出来的。**目录与界面必须按这个来**，
 * 否则就会出现"选了没变化"的假选项 —— 那比选项少更糟。
 *
 *   | 参数                  | 是否生效 | 证据                                   |
 *   |-----------------------|----------|----------------------------------------|
 *   | 换 voiceId            | ✅ 生效  | 云希 45936 / 晓伊 49248 / 云扬 43488 字节（CBR，字节数∝时长）|
 *   | prosody rate          | ✅ 生效  | rate 2.0 → 24480 字节，rate 0.5 → 96624 字节 |
 *   | prosody pitch         | ❌ 不生效| pitch 2.0 与默认**逐字节相同**（48528）|
 *   | mstts:express-as style| ❌ 不生效| 加了它服务端直接 `1007 SSML is invalid` 关连接 |
 *
 * 所以这一层的音色差异**只由 voiceId 与 rate 构成**。
 * `pitch` 与 `style` 被刻意从配置里去掉 ——
 * 留着一个"看起来能调、实际不动"的滑块，正是用户说的"僵硬"的来源之一。
 *
 * ── 一个必须如实告知的现实约束 ──────────────────────────────────────
 * 这是**非官方接口**，握手参数里有一个随 Chromium 版本走的
 * `Sec-MS-GEC-Version`。它会过期，过期的表现是 **403 Forbidden**
 * （不是超时、也不是 404 —— 路径还在，只是参数不合格）。
 *
 * 所以这里做了三件事，而不是硬编码一个版本号然后等它某天悄悄坏掉：
 *   ① 版本号可用环境变量 `EDGE_TTS_SEC_VERSION` 覆盖；
 *   ② 403 与"连不上"在错误信息里**分开报**（一个可修、一个是网络问题）；
 *   ③ 调用方失败时**明确降级到浏览器合成**并如实告知，
 *      绝不静默回退 —— 用户听到机器音时必须知道是"云端不可用"，
 *      而不是以为"选了也没用"。
 */

import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:tls'

/** Edge 公开的固定客户端令牌。它出现在 Edge 扩展的前端代码里，不是密钥。 */
const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'

/** Windows FileTime 的 epoch 偏移（秒）。 */
const WIN_EPOCH_OFFSET = 11644473600

/**
 * `Sec-MS-GEC-Version` 里的 Chromium 版本。
 *
 * ★ 这个值是**会过期的**：过期后服务端返回 403（不是 404，路径没变）。
 * 本机实测：`1-130.0.2849.68` → 403；`1-133.0.3065.39` → 101 握手成功。
 * 所以它做成可覆盖的环境变量，而不是写死在代码里 ——
 * 一个会过期的东西被写死，等于埋了一颗"某天开始不出声"的雷。
 */
const SEC_VERSION = process.env.EDGE_TTS_SEC_VERSION ?? '1-133.0.3065.39'

const WS_HOST = 'speech.platform.bing.com'
const WS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1'

/** 单次合成超时。超过就放弃并让调用方降级 —— 卡住不出声比出声生硬更糟。 */
const SYNTH_TIMEOUT_MS = 12_000

export interface NeuralVoice {
  /** Edge 音色标识。 */
  id: string
  label: string
  gender: 'female' | 'male'
  /**
   * 该音色的**本音语速**。
   *
   * 这是本引擎上唯一真正生效的"风格"旋钮（见文件头的实测表）。
   * 用户自己的语速微调会**乘在它上面**，与 `voiceId` 目录里的
   * rate 语义一致 —— 两套音色体系必须共用同一套语义，
   * 否则"换成男声"和"调快语速"会互相覆盖。
   */
  rate: number
  tags: string[]
  note: string
}

/**
 * 神经音色目录。
 *
 * ★ 每一条都**真的与其它条不同**：id 不同、或 rate 不同。
 * 刻意不放"同一副嗓子的风格变体"—— 实测 `express-as` 在这个端点上
 * 直接报 SSML 非法，放进来就是"选了没变化"。
 */
export const NEURAL_VOICES: NeuralVoice[] = [
  {
    id: 'zh-CN-XiaoxiaoNeural',
    label: '晓晓 · 自然女声',
    gender: 'female',
    rate: 1,
    tags: ['推荐', '默认', '拟人'],
    note: '日常对话语气，停顿与重音自然，最接近真人闲聊。',
  },
  {
    id: 'zh-CN-XiaoyiNeural',
    label: '晓伊 · 轻快女声',
    gender: 'female',
    rate: 1.08,
    tags: ['轻快'],
    note: '语速略快、语气明亮，适合盯盘时的短播报。',
  },
  {
    id: 'zh-CN-YunxiNeural',
    label: '云希 · 阳光男声',
    gender: 'male',
    rate: 1,
    tags: ['男声', '自然'],
    note: '自然的青年男声，不像播报腔。',
  },
  {
    id: 'zh-CN-YunyangNeural',
    label: '云扬 · 播报男声',
    gender: 'male',
    rate: 1.05,
    tags: ['男声', '播报'],
    note: '新闻播报腔。信息密度高，比闲聊语气更正式。',
  },
  {
    id: 'zh-CN-YunjianNeural',
    label: '云健 · 低沉男声',
    gender: 'male',
    rate: 0.96,
    tags: ['男声', '低沉'],
    note: '低频、有力度。把报警念出来时压迫感最强。',
  },
  {
    id: 'zh-CN-liaoning-XiaobeiNeural',
    label: '晓北 · 东北话',
    gender: 'female',
    rate: 1,
    tags: ['方言', '亲切'],
    note: '东北口音。听感最"像身边人"，但严肃播报时未必合适。',
  },
  {
    id: 'zh-CN-shaanxi-XiaoniNeural',
    label: '晓妮 · 陕西话',
    gender: 'female',
    rate: 1,
    tags: ['方言', '亲切'],
    note: '陕西口音。同上的取舍。',
  },
]

/** 默认神经音色（目录第一条）。 */
export function defaultNeuralVoice(): NeuralVoice {
  return NEURAL_VOICES[0]
}

export function getNeuralVoice(labelOrId: string): NeuralVoice | undefined {
  return (
    NEURAL_VOICES.find((v) => v.label === labelOrId) ?? NEURAL_VOICES.find((v) => v.id === labelOrId)
  )
}

// ───────────────────── WebSocket 握手参数 ─────────────────────

/**
 * `Sec-MS-GEC` 令牌。
 *
 * 算法：SHA256(「对齐到 5 分钟的 Windows FileTime(100ns 单位)」+ TrustedClientToken)
 * 取大写十六进制。**必须对齐到 5 分钟的时间片**，否则同一秒内两次请求
 * 算出的值都不同，服务端一律拒。
 */
export function secMsGec(now = Date.now()): string {
  let ticks = now / 1000 + WIN_EPOCH_OFFSET
  ticks -= ticks % 300
  ticks *= 1e7
  return createHash('sha256')
    .update(`${ticks.toFixed(0)}${TRUSTED_TOKEN}`, 'utf8')
    .digest('hex')
    .toUpperCase()
}

/** 供诊断用：把当前握手参数打出来（不含任何用户数据）。 */
export function handshakeDebug(): { host: string; secVersion: string; gecHead: string } {
  return { host: WS_HOST, secVersion: SEC_VERSION, gecHead: secMsGec().slice(0, 12) }
}

// ───────────────────── 最小 WebSocket 客户端 ─────────────────────

/** 把一段文本编成客户端文本帧（客户端发出的帧**必须**加掩码）。 */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const mask = randomBytes(4)
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

interface Frame {
  opcode: number
  fin: boolean
  payload: Buffer
}

/**
 * 从缓冲区里切出一个完整的帧。
 *
 * 返回 `null` 表示"还不够"（要等更多数据）—— 网络分片是常态，
 * 假设一次 `data` 事件就是一个完整帧是这类实现最常见的错。
 */
export function decodeFrame(buf: Buffer): { frame: Frame; rest: Buffer } | null {
  if (buf.length < 2) return null
  const b0 = buf[0]
  const b1 = buf[1]
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(64 * 1024 * 1024)) return null
    len = Number(big)
    offset = 10
  }
  let maskKey: Buffer | null = null
  if (masked) {
    if (buf.length < offset + 4) return null
    maskKey = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null
  let payload = buf.subarray(offset, offset + len)
  if (maskKey) {
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
  }
  return { frame: { opcode, fin, payload }, rest: buf.subarray(offset + len) }
}

/**
 * 控制帧（pong / close），服务端不遮罩。
 *
 * `payload` 要显式标注类型：`@types/node` 的 `Buffer` 现在是泛型的，
 * 让默认值 `Buffer.alloc(0)` 去推断会把参数收窄成 `Buffer<ArrayBuffer>`，
 * 于是传入 `subarray` 得到的 `Buffer<ArrayBufferLike>` 会报类型错。
 */
function encodeControlFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.from([0x80 | opcode, payload.length])
  return Buffer.concat([header, payload])
}

// ───────────────────── SSML ─────────────────────

export interface SynthOptions {
  /** 语速倍率，1 为标准。**这是本引擎上唯一生效的韵律旋钮**（见文件头实测表）。 */
  rate?: number
  voiceId?: string
  timeoutMs?: number
  /**
   * 诊断回调。只在排查握手/协议问题时传。
   *
   * 存在的理由：这条链路的失败形态是"连接被关闭"，而**为什么**被关闭
   * 全在服务端发回的 close 帧状态码里。没有这一层，403 / 1007（SSML 非法）/
   * 1011（服务端内部错）在日志里长得一模一样 —— 而三者的处置完全不同。
   * 本机就是靠它把"连接被关闭"定位成"SSML is invalid"的。
   */
  onDebug?: (msg: string) => void
}

export interface SynthResult {
  audio: Buffer
  mime: string
  bytes: number
}

/** 把倍率转成 Edge 认的 SSML 百分比。越界一律夹到合法区间，不报错。 */
export function ssmlRate(rate = 1): string {
  const pct = Math.round((Math.min(2, Math.max(0.5, rate)) - 1) * 100)
  return `${pct >= 0 ? '+' : ''}${pct}%`
}

/** XML 转义。文本可能含 `&` 或 `<`（例如交易对写着 A&B），不转义会让 SSML 解析失败。 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 拼 SSML。
 *
 * ★ 这里**刻意只产出 prosody.rate**。
 *
 * 曾经还带着 `<mstts:express-as style='chat'>`，结果服务端一律回
 * `1007 SSML is invalid` 并直接关连接 —— 而错误信息里不会告诉你是哪一处。
 * 逐项实测（见文件头表格）后确认：这个 consumer 端点裁掉了 Azure 语音服务
 * 的情感风格与变调能力，只留下音色与语速。
 *
 * 少写这两个参数不是"简化"，是**不写出一个服务端不认的请求**。
 */
export function buildSsml(text: string, opts: SynthOptions = {}): string {
  const voiceId = opts.voiceId ?? defaultNeuralVoice().id
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
    `<voice name='${voiceId}'>` +
    `<prosody rate='${ssmlRate(opts.rate)}'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  )
}

export class NeuralTtsError extends Error {
  readonly kind: 'forbidden' | 'network' | 'timeout' | 'protocol'
  constructor(kind: NeuralTtsError['kind'], message: string) {
    super(message)
    this.name = 'NeuralTtsError'
    this.kind = kind
  }
}

/**
 * 合成一段语音，返回 MP3。
 *
 * 失败一律抛 `NeuralTtsError`，且 `kind` 要能区分"握手被拒"（版本号过期，可修）
 * 与"连不上"（网络问题）—— 这两者对使用者的处置完全不同，
 * 混成一句"合成失败"等于让人无从下手。
 */
export function synthesizeNeural(text: string, opts: SynthOptions = {}): Promise<SynthResult> {
  return new Promise<SynthResult>((resolve, reject) => {
    const voiceId = opts.voiceId ?? defaultNeuralVoice().id
    const query =
      `${WS_PATH}?TrustedClientToken=${TRUSTED_TOKEN}` +
      `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_VERSION}`

    const handshake =
      `GET ${query} HTTP/1.1\r\n` +
      `Host: ${WS_HOST}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      // 这三条 client hints 不是可选的：缺了会被判成非浏览器流量
      `Sec-CH-UA: "Chromium";v="133", "Not(A:Brand";v="24", "Microsoft Edge";v="133"\r\n` +
      `Sec-CH-UA-Mobile: ?0\r\n` +
      `Sec-CH-UA-Platform: "Windows"\r\n` +
      `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold\r\n` +
      `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0\r\n` +
      `Pragma: no-cache\r\n` +
      `Cache-Control: no-cache\r\n\r\n`

    let settled = false
    const dbg = opts.onDebug ?? (() => undefined)
    let sock: ReturnType<typeof connect> | null = null
    // 显式标注：`Buffer.alloc(0)` 推断出的是 `Buffer<ArrayBuffer>`，
    // 而 `decodeFrame` 返回的 rest 是 `Buffer<ArrayBufferLike>` —— 会报类型错
    let buf: Buffer = Buffer.alloc(0)
    let handshakeDone = false
    const audioChunks: Buffer[] = []
    let pendingText = ''
    let continuation: Buffer | null = null
    /** 续帧要记住"上一帧是文本还是二进制" —— 分片时的 opcode 是 0，不带类型。 */
    let pendingBinary = false

    const cleanup = () => {
      clearTimeout(timer)
      try {
        sock?.destroy()
      } catch {
        /* 已经断了 */
      }
    }
    const ok = (v: SynthResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(v)
    }
    const bad = (kind: NeuralTtsError['kind'], msg: string) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new NeuralTtsError(kind, msg))
    }

    const timer = setTimeout(
      () => bad('timeout', `神经合成超过 ${SYNTH_TIMEOUT_MS / 1000} 秒未完成`),
      opts.timeoutMs ?? SYNTH_TIMEOUT_MS,
    )

    const ssml = buildSsml(text, { ...opts, voiceId })

    const sendConfig = () => {
      const payload =
        `X-Timestamp:${new Date().toUTCString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                // wordBoundary 关掉：口型用的是确定性包络（见 avatarMotion.ts），
                // 开它只会多收一堆用不上的消息
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        })
      sock?.write(encodeTextFrame(payload))

      const reqId = randomBytes(16).toString('hex')
      // ★ X-Timestamp 必须是 RFC1123 GMT（`toUTCString`）。
      //   用 `toString()` 会得到本地时区的中文格式，服务端不接受 ——
      //   而且它的表现同样只是"连接被关闭"，看不出是时间格式的问题。
      const ssmlPayload =
        `X-RequestId:${reqId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${new Date().toUTCString()}\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml
      sock?.write(encodeTextFrame(ssmlPayload))
      dbg(`已发送 config 与 ssml（长度 ${ssml.length}）`)
    }

    const handleTextFrame = (payload: Buffer) => {
      pendingText += payload.toString('utf8')
      if (pendingText.includes('Path:turn.end')) {
        if (audioChunks.length === 0) {
          bad('protocol', '服务端返回了结束标记但没有任何音频数据')
          return
        }
        const audio = Buffer.concat(audioChunks)
        ok({ audio, mime: 'audio/mpeg', bytes: audio.length })
      }
    }

    const handleBinaryFrame = (payload: Buffer) => {
      if (payload.length < 2) return
      const headerLen = payload.readUInt16BE(0)
      const header = payload.subarray(2, 2 + headerLen).toString('utf8')
      if (header.includes('Path:audio')) {
        audioChunks.push(payload.subarray(2 + headerLen))
      }
    }

    try {
      sock = connect({ host: WS_HOST, port: 443, servername: WS_HOST }, () => {
        sock?.write(handshake)
      })
    } catch (e) {
      bad('network', `建立连接失败：${e instanceof Error ? e.message : String(e)}`)
      return
    }

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])

      if (!handshakeDone) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) {
          // 握手响应异常大 —— 正常情况下只有几百字节
          if (buf.length > 64 * 1024) bad('protocol', '握手响应异常，无法解析')
          return
        }
        const head = buf.subarray(0, end).toString('utf8')
        const status = head.split('\r\n')[0] ?? ''
        buf = buf.subarray(end + 4)
        if (!status.includes('101')) {
          // ★ 403 单独报：它几乎总是"版本号过期"，与网络问题处置不同
          if (status.includes('403')) {
            bad(
              'forbidden',
              `握手被拒（403）：Sec-MS-GEC-Version=${SEC_VERSION} 可能已过期，` +
                `可用环境变量 EDGE_TTS_SEC_VERSION 覆盖`,
            )
          } else {
            bad('protocol', `握手未升级：${status}`)
          }
          return
        }
        handshakeDone = true
        dbg(`握手 ${status}`)
        sendConfig()
      }

      // 一次 data 事件里可能有多个帧、也可能只有半个帧
      for (;;) {
        const decoded = decodeFrame(buf)
        if (!decoded) return
        buf = decoded.rest
        const { frame } = decoded

        if (frame.opcode === 0x9) {
          sock?.write(encodeControlFrame(0xa, frame.payload)) // ping → pong
          continue
        }
        if (frame.opcode === 0x8) {
          // close 帧前两字节是状态码，之后是原因 —— 不读它就只剩一句"被关闭"
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 0
          const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : ''
          dbg(`close 帧 code=${code} reason=${reason}`)
          if (!settled) bad('protocol', `连接被服务端关闭（code=${code}${reason ? ' ' + reason : ''}）`)
          return
        }

        // 分片：opcode 0 是续帧，要拼到上一帧上
        if (frame.opcode === 0x0) {
          continuation = continuation
            ? Buffer.concat([continuation, frame.payload])
            : frame.payload
          if (frame.fin && continuation) {
            const merged = continuation
            continuation = null
            if (pendingBinary) handleBinaryFrame(merged)
            else handleTextFrame(merged)
          }
          continue
        }

        const isText = frame.opcode === 0x1
        const isBinary = frame.opcode === 0x2
        if (!isText && !isBinary) continue

        if (!frame.fin) {
          pendingBinary = isBinary
          continuation = frame.payload
          continue
        }
        if (isText) handleTextFrame(frame.payload)
        else handleBinaryFrame(frame.payload)
      }
    })

    sock.on('error', (e: Error) => {
      const code = (e as { code?: string }).code ?? ''
      bad('network', `连接出错：${code || e.message}`)
    })
    sock.on('close', () => {
      if (!settled) bad('protocol', '连接在音频收完之前被关闭')
    })
  })
}
