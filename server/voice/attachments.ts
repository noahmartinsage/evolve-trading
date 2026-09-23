/**
 * 附件受理 —— 桌宠「能添加截图和图片以及提交文档」的落地层
 *
 * ── 改造前是什么样 ────────────────────────────────────────────────────
 * 语音/桌宠链路上**完全没有附件通道**：全仓 grep 不到任何一处接收图片
 * 或文件的入口。用户说「帮我看看这张图」，系统能做的只有把这句话当成一句
 * 普通的话 —— 而它没有任何办法看到图，于是只能回"我不会"。
 *
 * ── 三条设计约束 ──────────────────────────────────────────────────────
 * ① **不支持的类型必须说清是哪一种不支持。**
 *    静默丢掉一个 PDF、然后回一句泛泛的"我处理不了"，用户无从判断
 *    是他给错了格式还是系统根本不支持。所以这里对每一种类型都给具名结论。
 *
 * ② **图片走模型，文本走本地抽取 —— 不要把文本也推给模型。**
 *    一份 200KB 的日志交给模型既慢又贵，而且模型会开始"总结"，
 *    而用户要的往往是"这几行错在哪"。文本类附件**原样带进上下文**，
 *    由模型在需要时引用；抽取失败就是抽取失败，不许假装读到了。
 *
 * ③ **体积上限是硬约束，超了要报数。**
 *    localStorage / 请求体 / 模型上下文各有各的上限，实测过的教训是
 *    "超限时静默截断"会让下游拿着半份数据得出完整结论。
 *
 * ── 为什么图片用 base64 而不是外链 ────────────────────────────────────
 * 外链会被厂商的抓取器访问 —— 等于把用户贴在桌宠上的截图变成公网可取地址。
 * 本地编码没有这个问题，代价只是请求体大一点（实测 640×640 JPEG ≈ 150KB）。
 */

/** 单个附件上限。手机截图常在 2~5MB，8MB 留了余量。 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
/** 一次最多几个。超过就该让人分批，而不是把一次请求变成一次上传。 */
export const MAX_ATTACHMENTS = 4
/** 文本类抽取后最多带多少字进上下文。 */
export const MAX_TEXT_CHARS = 60_000

export interface RawAttachment {
  name: string
  /** MIME 类型。缺省时按扩展名推。 */
  mimeType?: string
  /** base64（**不要** data URL 前缀；带前缀会被 `base64:` 解析器当垃圾）。 */
  dataBase64: string
}

export type AttachmentKind = 'image' | 'text' | 'unsupported'

export interface AttachmentDigest {
  name: string
  kind: AttachmentKind
  /** 认下来的 MIME。 */
  mimeType: string
  /** 原始字节数（解 base64 后）。 */
  bytes: number
  /**
   * 图片：可直接送进模型的 data URL。
   * 文本：抽取出的正文。
   * 不支持：空串。
   */
  dataUrl: string
  text: string
  /** 抽取是否被截断（截断必须说出来）。 */
  truncated: boolean
  /** 一句能念给人听的话。**成功也要有**，用于播报"我收到了什么"。 */
  summary: string
  /** 失败/不支持时的可念原因。 */
  reason?: string
}

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** 文本类：能直接当字读的。刻意不含 pdf/docx —— 它们需要解析库，混进来只会静默出错。 */
const TEXT_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  ts: 'text/plain',
  tsx: 'text/plain',
  js: 'text/plain',
  mjs: 'text/plain',
  py: 'text/plain',
  sh: 'text/plain',
  sql: 'text/plain',
  html: 'text/html',
  xml: 'text/xml',
  ini: 'text/plain',
  env: 'text/plain',
}

/** 明确知道"现在处理不了"的类型 —— 名单存在的意义是**给出具名理由**。 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  pdf: 'PDF 需要专门的解析库（本机没有装），我不想用一段正则去猜它的正文 —— 猜出来的东西看着像原文，但不是',
  doc: '老版 Word 是二进制格式，需要专门解析库',
  docx: 'Word 需要解压 XML 再抽取，本机没有装这个库',
  xls: '老版 Excel 是二进制格式，需要专门解析库',
  xlsx: 'Excel 需要解压 XML 再抽取，本机没有装这个库',
  ppt: 'PowerPoint 是二进制格式，需要专门解析库',
  pptx: 'PowerPoint 需要解压 XML 再抽取，本机没有装这个库',
  zip: '压缩包我不解 —— 解压是另一个动作，而且它可能很大',
  rar: '压缩包我不解',
  '7z': '压缩包我不解',
  mp4: '视频需要抽帧与转码，不在这一层做',
  mov: '视频需要抽帧与转码，不在这一层做',
  mp3: '音频需要先转写成文字，本机没有装转写引擎',
  wav: '音频需要先转写成文字，本机没有装转写引擎',
  exe: '可执行文件我不读',
  dll: '可执行文件我不读',
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim())
  return m ? m[1].toLowerCase() : ''
}

/**
 * 从文件名/MIME 判定类型。
 *
 * ★ 顺序是先 MIME 后扩展名，但**扩展名能覆盖 MIME**：浏览器给的
 *   `application/octet-stream` 对什么都成立，而 `.log` 是真信息。
 *   反过来，`image/png` 比 `.png` 可信（内容已经被识别过）。
 */
export function classifyAttachment(name: string, mimeType?: string): { kind: AttachmentKind; mime: string } {
  const ext = extOf(name)
  const mime = (mimeType ?? '').toLowerCase().split(';')[0].trim()
  if (IMAGE_MIMES.includes(mime)) return { kind: 'image', mime }
  if (TEXT_EXT[ext] && (!mime || mime === 'application/octet-stream')) return { kind: 'text', mime: TEXT_EXT[ext] }
  if (mime.startsWith('image/')) return { kind: 'image', mime }
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/x-ndjson') {
    return { kind: 'text', mime }
  }
  if (TEXT_EXT[ext]) return { kind: 'text', mime: TEXT_EXT[ext] }
  return { kind: 'unsupported', mime: mime || 'unknown' }
}

function b64Bytes(b64: string): number {
  const clean = b64.replace(/\s+/g, '')
  if (clean.length === 0) return 0
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.floor((clean.length * 3) / 4) - pad
}

function bytesToText(b64: string): string {
  return Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8')
}

/**
 * 受理一个附件。
 *
 * 任何一条失败路径都返回带 `reason` 的摘要，**不抛异常** ——
 * 调用它的是语音回合，一个抛出的异常在那一层只会变成一句"出错了"，
 * 而用户需要知道的是"这张图太大"还是"这个格式我不读"。
 */
export function digestAttachment(a: RawAttachment): AttachmentDigest {
  const { kind, mime } = classifyAttachment(a.name, a.mimeType)
  const bytes = b64Bytes(a.dataBase64 ?? '')

  const base: AttachmentDigest = {
    name: a.name,
    kind,
    mimeType: mime,
    bytes,
    dataUrl: '',
    text: '',
    truncated: false,
    summary: '',
  }

  if (!a.dataBase64 || bytes === 0) {
    return { ...base, kind: 'unsupported', reason: `${a.name} 是空的（0 字节），没有内容可读`, summary: `${a.name} 是空的，我没读到内容` }
  }
  if (bytes > MAX_ATTACHMENT_BYTES) {
    return {
      ...base,
      kind: 'unsupported',
      reason: `${a.name} 有 ${(bytes / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB 的单件上限`,
      summary: `${a.name} 太大了（${(bytes / 1024 / 1024).toFixed(1)}MB），超过上限，我没收`,
    }
  }

  if (kind === 'image') {
    const dataUrl = `data:${mime};base64,${a.dataBase64.replace(/\s+/g, '')}`
    return {
      ...base,
      dataUrl,
      summary: `${a.name}（图片 · ${mime} · ${(bytes / 1024).toFixed(0)}KB）`,
    }
  }

  if (kind === 'text') {
    const raw = bytesToText(a.dataBase64)
    // ★ 二进制嗅探在**解成字符串之后**做：一个 .log 里混进 NUL 字节，
    //   说明它其实不是文本（或被截断过）。这时候说"读到了一堆乱码"
    //   比把乱码当正文交出去诚实得多。
    if (/\0/.test(raw.slice(0, 4096))) {
      return {
        ...base,
        kind: 'unsupported',
        reason: `${a.name} 虽然是 ${extOf(a.name) || '文本'} 扩展名，但内容里有空字节，它不是纯文本`,
        summary: `${a.name} 的内容不是纯文本，我没法当文字读`,
      }
    }
    const truncated = raw.length > MAX_TEXT_CHARS
    const text = truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw
    const lines = text.split('\n').length
    return {
      ...base,
      text,
      truncated,
      summary:
        `${a.name}（文本 · ${(bytes / 1024).toFixed(0)}KB · ${lines} 行）` +
        (truncated ? `，超过 ${MAX_TEXT_CHARS} 字上限，只带了前 ${MAX_TEXT_CHARS} 字` : ''),
    }
  }

  const ext = extOf(a.name)
  const known = KNOWN_UNSUPPORTED[ext]
  return {
    ...base,
    reason: known
      ? `${a.name}：${known}`
      : `${a.name} 的类型（${mime}）我不认。能读的是图片（png/jpeg/webp/gif）与纯文本（txt/md/log/csv/json/yaml 等）`,
    summary: `${a.name} 我读不了：${known ? known.split('，')[0] : `不认识 ${mime} 这种类型`}`,
  }
}

export interface DigestBatch {
  digests: AttachmentDigest[]
  /** 全部收下了（可以带着它们去问模型）。 */
  ok: boolean
  images: AttachmentDigest[]
  texts: AttachmentDigest[]
  rejected: AttachmentDigest[]
  /** 一句能念的汇总。**成功与部分失败都要能念**。 */
  summary: string
}

/**
 * 批量受理。
 *
 * ★ 部分失败**不算整批失败**：三张图里有一张是 PDF，那就用两张图回答，
 *   并把 PDF 的事说出来。整批拒绝会让用户以为"图片功能坏了"。
 */
export function digestAttachments(list: readonly RawAttachment[]): DigestBatch {
  const capped = list.slice(0, MAX_ATTACHMENTS)
  const digests = capped.map(digestAttachment)
  const images = digests.filter((d) => d.kind === 'image')
  const texts = digests.filter((d) => d.kind === 'text')
  const rejected = digests.filter((d) => d.kind === 'unsupported')

  const parts: string[] = []
  if (images.length > 0) parts.push(`收到 ${images.length} 张图：${images.map((d) => d.name).join('、')}`)
  if (texts.length > 0) parts.push(`收到 ${texts.length} 份文本：${texts.map((d) => d.summary).join('；')}`)
  if (rejected.length > 0) parts.push(rejected.map((d) => d.reason ?? `${d.name} 读不了`).join('；'))
  if (list.length > MAX_ATTACHMENTS) parts.push(`你一次给了 ${list.length} 个附件，我只受理了前 ${MAX_ATTACHMENTS} 个`)

  return {
    digests,
    ok: images.length + texts.length > 0,
    images,
    texts,
    rejected,
    summary: parts.length > 0 ? parts.join('。') + '。' : '没有收到任何附件',
  }
}
