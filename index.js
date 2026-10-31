/**
 * Agnes 生图工具 —— Host 侧实现。
 *
 * 官方文档（严格对齐）：
 *   https://www.agnes-ai.cn/zh-Hans/docs/agnes-image-25-flash
 *
 * 文档要点（代码里对应位置已逐一标注）：
 *   - 模型名 `agnes-image-2.5-flash`；端点 `POST https://api.agnes-ai.cn/v1/images/generations`。
 *   - 鉴权：`Authorization: Bearer <API_KEY>`，`Content-Type: application/json`。
 *   - 文生图必填 `model` / `prompt` / `size`；`size` 用档位 `1K|2K|3K|4K`，比例用 `ratio`
 *     （`1:1 3:4 4:3 16:9 9:16 2:3 3:2 21:9`，默认 `1:1`）；不要传 1920x1080 这类非原生精确尺寸。
 *   - 图生图 / 多图合成：输入图放 `extra_body.image`（公共 HTTPS URL 或 Data URI Base64），
 *     不要传 `tags: ["img2img"]`；多图时在 prompt 里说明每张图的角色。
 *   - 输出格式：`response_format` 不能放请求体顶层。
 *       URL 输出           → `extra_body.response_format: "url"`
 *       图生图要 Base64    → `extra_body.response_format: "b64_json"`
 *       文生图要 Base64    → 顶层 `return_base64: true`
 *   - 生成可能耗时数秒到几十秒，客户端超时应为 60s–360s。
 *   - 响应：URL 模式读 `data[0].url`；Base64 模式读 `data[0].b64_json`。
 *
 * 安全边界：API Key 只从本机插件配置（settings，secret 字段，界面遮罩）或进程环境变量
 * `AGNES_API_KEY` 读取；不写日志、不回显、不发送给 Agnes 之外的主机。
 */

import z from '@deepseek-ai/schemastery'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** 官方模型名（文档「模型名称」）。 */
const MODEL = 'agnes-image-2.5-flash'
/** 官方 Base URL；用户可在配置里改成自建代理，但默认必须是官方地址。 */
const DEFAULT_BASE_URL = 'https://api.agnes-ai.cn/v1'
/** 官方端点路径（文档「API Endpoint」）。 */
const ENDPOINT_PATH = '/images/generations'
/** 档位尺寸（文档「请求参数 / 尺寸与宽高比」）。 */
const SIZES = ['1K', '2K', '3K', '4K']
/** 支持的宽高比（文档「尺寸与宽高比」）。 */
const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']
/** 生成模式。 */
const MODES = ['text2img', 'img2img', 'multi_image']
/** 文档给出的原生输出尺寸表，用于在结果里说明真实像素，避免用户误以为能精确到 1920x1080。 */
const SIZE_TABLE = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048', '3K': '3072x3072', '4K': '4096x4096' },
  '3:4': { '1K': '864x1152', '2K': '1728x2304', '3K': '2592x3456', '4K': '3456x4608' },
  '4:3': { '1K': '1152x864', '2K': '2304x1728', '3K': '3456x2592', '4K': '4608x3456' },
  '16:9': { '1K': '1312x736', '2K': '2624x1472', '3K': '3936x2208', '4K': '5248x2944' },
  '9:16': { '1K': '736x1312', '2K': '1472x2624', '3K': '2208x3936', '4K': '2944x5248' },
  '2:3': { '1K': '832x1248', '2K': '1664x2496', '3K': '2496x3744', '4K': '3328x4992' },
  '3:2': { '1K': '1248x832', '2K': '2496x1664', '3K': '3744x2496', '4K': '4992x3328' },
  '21:9': { '1K': '1568x672', '2K': '3136x1344', '3K': '4704x2016', '4K': '6272x2688' },
}

/** 生成图片的大小上限，避免把超大响应读进内存。 */
const MAX_IMAGE_BYTES = 48 * 1024 * 1024

/**
 * 插件配置。
 * apiKey 用 schemastery 的 secret 角色：写入本机 profile 的 Cordis 配置文档，
 * 但从 settings.describe / 客户端表单里被剥离，只留「已设置」标记（界面遮罩，不可回读）。
 */
const Config = z.object({
  // secret：describe()/表单拿不到明文，只留 { path, set } 标记（界面遮罩）。
  // volatile：字段进入 settings 表单并可热更新（dsh-settings 只投影 volatile 字段）。
  apiKey: z
    .string()
    .description('Agnes API Key（仅保存在本机，界面不回显；留空时回退到环境变量 AGNES_API_KEY）')
    .role('secret')
    .volatile()
    .default(''),
  baseURL: z
    .string()
    .description('Agnes API Base URL（默认官方 https://api.agnes-ai.cn/v1）')
    .volatile()
    .default(DEFAULT_BASE_URL),
  timeoutMs: z
    .number()
    .description('请求超时（毫秒，60s–360s；图片生成可能耗时数十秒）')
    .volatile()
    .default(180_000)
    .min(60_000)
    .max(360_000),
  saveDirectory: z
    .string()
    .description('可选：把生成结果另存到本机目录（留空则只保存在会话附件里）')
    .volatile()
    .default(''),
})

/**
 * 供 AI 调用的工具参数表（标准 JSON Schema）。
 *
 * 注意：`ctx.tools.register()` 会把 `parameters` **原样**交给模型提供方，
 * 不会再像官方 `defineTool` 那样把「属性名 → 参数定义」映射编译成对象根。
 * 因此这里必须自己写 `type: 'object'` + `properties` + 对象级 `required` 数组，
 * 否则模型侧会报 `schema must be a JSON Schema of 'type: "object"', got 'type: null'`，
 * 整条请求 400，表现为对话失败。
 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      description:
        '图像生成或编辑指令。推荐结构见工具描述：文生图=主体+场景/环境+风格+光照+构图+细节密度；' +
        '图生图=[改变要求]+[新风格/场景]+[添加或移除的元素]+[需要保留的元素]；' +
        '多图合成=[参考图角色]+[目标场景]+[图像之间的关系]+[风格/光照/构图]。',
    },
    mode: {
      type: 'string',
      enum: MODES,
      description:
        'text2img=文生图（只需 prompt + size）；img2img=图生图（必须 images）；' +
        'multi_image=多图合成（必须 images 多张，并在 prompt 说明每张图角色）。默认 text2img。',
    },
    size: {
      type: 'string',
      enum: SIZES,
      description:
        '输出档位：1K / 2K / 3K / 4K，默认 2K。不要用 1920x1080 这类非原生精确尺寸；需要 16:9 请配 ratio。',
    },
    ratio: {
      type: 'string',
      enum: RATIOS,
      description: '宽高比，默认 1:1。如 "16:9" 生成 2K 时实际输出 2624x1472。',
    },
    images: {
      type: 'array',
      items: { type: 'string' },
      description:
        '图生图/多图合成的参考图：公共 HTTPS 图片 URL，或 data:image/...;base64,<...> Data URI。' +
        '本地图片请先转成 Data URI Base64；需要登录的私有链接 Agnes 取不到。',
    },
    output_format: {
      type: 'string',
      enum: ['url', 'base64'],
      description: 'url=返回图片链接（默认，最省 token）；base64=直接取回图片字节并保存为附件预览。',
    },
  },
}

/** 一张图片附件的值形状（与 read_image 的 image 值一致；输出 schema 用标准 JSON Schema 方言）。 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

/** 工具返回值 schema（标准 JSON Schema：required 必须是数组）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'code', 'message', 'mode', 'size', 'ratio', 'outputFormat'],
  properties: {
    ok: { type: 'boolean' },
    code: { type: 'string' },
    message: { type: 'string' },
    mode: { type: 'string', enum: MODES },
    size: { type: 'string', enum: SIZES },
    ratio: { type: 'string' },
    outputFormat: { type: 'string', enum: ['url', 'base64'] },
    url: { type: 'string' },
    filePath: { type: 'string' },
    revisedPrompt: { type: 'string' },
    image: IMAGE_VALUE_SCHEMA,
  },
}

const DESCRIPTION = `用 Agnes Image 2.5 Flash 生成或编辑图片。当用户要求画图、做海报/封面/插画、改图、换风格、合成多张参考图时主动调用。

【模式】
- text2img（默认）：文生图，只需要 prompt（+ size/ratio）。
- img2img：图生图，必须提供 images（1 张参考图），prompt 描述要改成什么。
- multi_image：多图合成，images 传多张，并且必须在 prompt 里说明每张参考图的角色与它们如何组合。

【提示词结构（官方推荐）】
- 文生图：[主体] + [场景/环境] + [风格] + [光照] + [构图] + [细节密度/质量要求]
- 图生图：[改变要求] + [新风格/场景] + [添加或移除的元素] + [需要保留的元素]
- 多图合成：[参考图角色] + [目标场景] + [图像之间的关系] + [风格/光照/构图]
高信息密度画面请明确描述视觉层次：主要主体、背景环境、重要次要细节、风格、光照、构图约束。

【参数】
- size 用档位 1K/2K/3K/4K（默认 2K），不要传 1920x1080 之类的精确尺寸；要 16:9 就传 size:"2K", ratio:"16:9"（实际输出 2624x1472）。
- images 只接受公共 HTTPS 图片 URL 或 data:image/...;base64,... Data URI；本地文件先转 Base64，私有/需登录链接会失败。
- output_format:"url"（默认）直接拿链接；"base64" 会把图片存成会话附件并内联预览（适合用户要直接看图）。

【失败时】结果里的 message 会给出可操作修复建议（未配置 Key / 缺 images / 图片链接不可公开访问 / 超时 / 鉴权失败等），按提示处理后再试，不要反复重试同一请求。`

/**
 * 读取有效 API Key：本机配置优先，其次进程环境变量。
 * 注意：任何情况下都不要把 key 写进 message、日志或错误里。
 */
function resolveApiKey(config) {
  const fromConfig = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
  if (fromConfig.length > 0) return fromConfig
  const fromEnv = typeof process.env.AGNES_API_KEY === 'string' ? process.env.AGNES_API_KEY.trim() : ''
  return fromEnv
}

/**
 * 复用 Profile 里已有的 `AGNES_API_KEY` 凭据（例如 LLM 提供方配置里用了同一个 Key）。
 * 凭据服务只在内存中解析，不写日志；解析失败时静默回退到「未配置」引导。
 */
/**
 * 从 settings 服务读取本插件命名空间里的 apiKey。
 *
 * 为什么需要这一步：`role('secret')` 字段会在 settings 的 describe/客户端表单里被剥离，
 * 但 Host 侧 describe() 的 `user`/`value` 仍是文档真值；配置页保存的 Key 就落在这里。
 * 因此插件在每次调用时主动读一次，既能跟上用户改 Key，又不需要重启。
 * 只在内存里使用，绝不写日志、绝不回显。
 */
async function resolveSettingsApiKey(ctx) {
  try {
    const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
    if (!settings || typeof settings.describe !== 'function') return ''
    const list = await settings.describe()
    const row = (Array.isArray(list) ? list : []).find(
      (item) =>
        item &&
        typeof item.ns === 'string' &&
        (item.ns === 'agnes-image' || item.ns.endsWith(':agnes-image') || item.ns.endsWith('/agnes-image')),
    )
    if (!row) return ''
    for (const layer of [row.value, row.user, row.base]) {
      if (layer && typeof layer.apiKey === 'string' && layer.apiKey.trim()) return layer.apiKey.trim()
    }
    return ''
  } catch {
    return ''
  }
}

async function resolveCredentialApiKey(ctx) {
  try {
    const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
    if (!credentials || typeof credentials.resolve !== 'function') return ''
    const resolved = await credentials.resolve('AGNES_API_KEY')
    // resolve() 返回 { value, source } 而不是裸字符串（凭据服务契约）。
    const value = typeof resolved === 'string' ? resolved : resolved && typeof resolved.value === 'string' ? resolved.value : ''
    return value.trim()
  } catch {
    return ''
  }
}

function resolveBaseURL(config) {
  const raw = typeof config?.baseURL === 'string' && config.baseURL.trim() ? config.baseURL.trim() : DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
}

function resolveTimeout(config) {
  const value = Number(config?.timeoutMs)
  if (!Number.isFinite(value)) return 180_000
  return Math.min(360_000, Math.max(60_000, Math.round(value)))
}

function endpointOf(baseURL) {
  return `${baseURL}${ENDPOINT_PATH}`
}

/** 校验输出 URL 合法性（http/https、有主机名），返回规范字符串或 undefined。 */
function validImageURL(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (!url.hostname) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/** 通过文件头判断图片媒体类型。 */
function sniffMediaType(buffer) {
  if (!buffer || buffer.length < 12) return undefined
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  return undefined
}

/** 扩展名（用于另存文件）。 */
function extensionOf(mediaType) {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    default:
      return 'png'
  }
}

/** 把 `data:image/png;base64,...` 归一为纯 Base64；普通 Base64 原样返回。 */
function stripDataURI(value) {
  const text = value.trim()
  const match = /^data:[^;,]+;base64,(.*)$/is.exec(text)
  return match ? match[1] : text
}

/** 宽松的 Base64 校验：只允许 base64 字符与空白，长度足够且能解码。 */
function decodeBase64Image(value) {
  const clean = stripDataURI(value).replace(/\s+/g, '')
  if (clean.length < 32) return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return undefined
  const buffer = Buffer.from(clean, 'base64')
  return buffer.length >= 16 ? buffer : undefined
}

/** 文本里的 Base64 预览截断，避免刷屏。 */
function previewBase64(value, limit = 64) {
  const clean = stripDataURI(value)
  const head = clean.slice(0, limit)
  return `${head}…（共 ${clean.length} 个 Base64 字符，已省略）`
}

/** 从 API 错误响应里提取可读信息。 */
function readErrorPayload(status, payload, rawText) {
  const message =
    (payload && payload.error && (payload.error.message || payload.error.type)) ||
    (payload && (payload.message || payload.detail)) ||
    (typeof rawText === 'string' && rawText.trim() ? rawText.trim().slice(0, 600) : '')
  return { status, message: typeof message === 'string' ? message : '', payload }
}

/** 把 HTTP 失败翻译成「可操作的建议」。 */
function explainHTTPError({ status, message }) {
  const detail = message ? `服务端说明：${message}` : ''
  if (status === 401 || status === 403) {
    return {
      code: 'auth_failed',
      message:
        `Agnes 鉴权失败（HTTP ${status}）。请到「插件 → Agnes 生图 → 配置」检查 API Key 是否填写正确、是否已过期或被撤销。` +
        (detail ? `\n${detail}` : ''),
    }
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      message: `Agnes 返回限流（HTTP 429）。请降低频率或稍后再试。${detail ? `\n${detail}` : ''}`,
    }
  }
  if (status === 400) {
    const lower = message.toLowerCase()
    if (lower.includes('image') || lower.includes('url')) {
      return {
        code: 'bad_image',
        message:
          'Agnes 拒绝了参考图（HTTP 400）。请确认 images 是公共 HTTPS 图片 URL（无需登录/cookie），' +
          '或改传 data:image/png;base64,... 形式的 Data URI Base64。' +
          (detail ? `\n${detail}` : ''),
      }
    }
    if (lower.includes('response_format') || lower.includes('tags')) {
      return {
        code: 'bad_request',
        message:
          '请求参数不符合 Agnes 规范（response_format 只能放在 extra_body，图生图不要传 tags）。' +
          '本工具已按官方格式封装，请把完整参数发回以排查。' +
          (detail ? `\n${detail}` : ''),
      }
    }
    return { code: 'bad_request', message: `Agnes 拒绝了请求（HTTP 400）。${detail}` }
  }
  if (status >= 500) {
    return {
      code: 'server_error',
      message: `Agnes 服务端错误（HTTP ${status}），通常稍后重试即可。${detail ? `\n${detail}` : ''}`,
    }
  }
  return { code: 'http_error', message: `Agnes 请求失败（HTTP ${status}）。${detail ? `\n${detail}` : ''}` }
}

/** 下载并校验一张生成结果，存入附件服务，返回可内联渲染的图片值。 */
async function materializeImage(ctx, source, signal) {
  let buffer
  let mediaType
  if (source.kind === 'url') {
    const response = await fetch(source.url, { redirect: 'follow', signal })
    if (!response.ok) throw new Error(`下载生成图失败（HTTP ${response.status}）`)
    const declared = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const length = Number(response.headers.get('content-length') || 0)
    if (length > MAX_IMAGE_BYTES) throw new Error('生成图超过大小上限，未下载预览')
    buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('生成图超过大小上限，未下载预览')
    mediaType = sniffMediaType(buffer) || (declared.startsWith('image/') ? declared : undefined)
  } else {
    const decoded = decodeBase64Image(source.base64)
    if (!decoded) throw new Error('Agnes 返回的 b64_json 不是合法 Base64')
    buffer = decoded
    mediaType = sniffMediaType(buffer)
  }
  if (!mediaType) throw new Error('返回内容不是受支持的图片格式（PNG/JPEG/WebP/GIF）')
  const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
  if (!attachments) return { mediaType, bytes: buffer }
  const ref = await attachments.saveImage({ data: new Uint8Array(buffer), mediaType })
  return { mediaType, bytes: buffer, ref }
}

/** 将图片字节另存到用户配置的目录（可选）。 */
async function persistToDisk(directory, buffer, mediaType, stamp) {
  const raw = String(directory || '').trim()
  if (!raw) return undefined
  const target = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
  if (!isAbsolute(target)) return undefined
  try {
    await fs.mkdir(target, { recursive: true })
    const name = `agnes-${stamp}.${extensionOf(mediaType)}`
    const path = join(target, name)
    await fs.writeFile(path, buffer)
    return path
  } catch {
    return undefined
  }
}

/** 统一构造返回值，保证与 OUTPUT_SCHEMA 一致。 */
function result(partial) {
  return {
    ok: partial.ok === true,
    code: partial.code || 'ok',
    message: partial.message || '',
    mode: partial.mode || 'text2img',
    size: partial.size || '2K',
    ratio: partial.ratio || '1:1',
    outputFormat: partial.outputFormat || 'url',
    ...(partial.url ? { url: partial.url } : {}),
    ...(partial.filePath ? { filePath: partial.filePath } : {}),
    ...(partial.revisedPrompt ? { revisedPrompt: partial.revisedPrompt } : {}),
    ...(partial.image ? { image: partial.image } : {}),
  }
}

function failure(partial) {
  return result({ ...partial, ok: false })
}

/**
 * 本地版 defineTool：第三方插件在 profile 里解析不到 `@deepseek-ai/dsh-tools`，
 * 而 `ctx.tools.register` 接受的就是普通对象，所以这里只做最基本的形状检查，
 * 同时让代码读起来和官方 defineTool 一致。
 * @template T
 * @param {T} definition
 * @returns {T}
 */
function defineTool(definition) {
  if (!definition || typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new Error('defineTool: name is required')
  }
  if (!definition.parameters || typeof definition.parameters !== 'object') {
    throw new Error('defineTool: parameters must be an object')
  }
  if (!definition.output || typeof definition.execute !== 'function') {
    throw new Error('defineTool: output and execute are required')
  }
  return definition
}

/**
 * 注册工具。
 * @param {import('@deepseek-ai/dsh-tools').Context} ctx
 * @param {object} config 已解析的插件配置
 */
export function apply(ctx, config) {
  const definition = defineTool({
    name: 'agnes_image',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const blocks = [{ type: 'text', text: value.message }]
        // 附件型图片直接内联渲染（不把 base64 塞进正文，避免超长刷屏）。
        if (value.ok && value.image && value.image.attachmentId) {
          blocks.push({ type: 'image', attachment: value.image })
        }
        return blocks
      },
    },
    timeoutMs: 390_000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      const mode = args && typeof args.mode === 'string' ? args.mode : 'text2img'
      return { card: 'generic', title: `Agnes 生图（${mode}）`, kind: 'other', rawInput: args }
    },
    async execute(args, exec) {
      const mode = MODES.includes(args.mode) ? args.mode : 'text2img'
      const size = SIZES.includes(args.size) ? args.size : '2K'
      const ratio = RATIOS.includes(args.ratio) ? args.ratio : '1:1'
      const outputFormat = args.output_format === 'base64' ? 'base64' : 'url'
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      const images = Array.isArray(args.images)
        ? args.images.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
        : []
      const native = SIZE_TABLE[ratio] && SIZE_TABLE[ratio][size]

      const base = { mode, size, ratio, outputFormat }

      // 1) 配置检查：给出可操作引导，而不是抛原始错误。
      //    优先级：插件配置 → Profile 里已保存的 AGNES_API_KEY 凭据 → 进程环境变量。
      let apiKey = resolveApiKey(config)
      if (!apiKey) apiKey = await resolveSettingsApiKey(ctx)
      if (!apiKey) apiKey = await resolveCredentialApiKey(ctx)
      if (!apiKey) {
        return failure({
          ...base,
          code: 'missing_api_key',
          message:
            '尚未配置 Agnes API Key，无法生成图片。\n' +
            '请打开「插件（Plugins）→ Agnes 生图 → 配置」，填入 API Key 并保存；' +
            '也可以设置环境变量 AGNES_API_KEY 后重启 Harness。\n' +
            'Key 只保存在本机配置中（界面遮罩、不回显），不会写入日志，也不会发送到 Agnes 以外的地方。',
        })
      }

      // 2) 参数校验。
      if (prompt.length === 0) {
        return failure({ ...base, code: 'missing_prompt', message: 'prompt 不能为空：请描述要生成或修改的画面。' })
      }
      if (mode !== 'text2img' && images.length === 0) {
        return failure({
          ...base,
          code: 'missing_image',
          message:
            '图生图 / 多图合成必须在 images 里提供参考图（图生图 1 张，多图合成 2 张以上）。\n' +
            '支持公共 HTTPS 图片 URL 或 data:image/png;base64,... 形式的 Data URI；' +
            '本地图片请先转 Base64，私有/需登录的链接 Agnes 无法访问。',
        })
      }
      if (mode === 'multi_image' && images.length < 2) {
        return failure({
          ...base,
          code: 'missing_image',
          message:
            'multi_image 需要至少 2 张参考图。若只有 1 张，请把 mode 改成 img2img；' +
            '多图合成时还要在 prompt 里说明每张图分别扮演什么角色，以及它们如何组合。',
        })
      }
      if (mode === 'text2img' && images.length > 0) {
        // 文档：图生图必须走 extra_body.image；这里纠正而不是静默丢弃。
        return failure({
          ...base,
          code: 'mode_mismatch',
          message:
            'mode="text2img" 时不需要 images。要基于参考图修改请用 mode="img2img"；' +
            '要合成多张参考图请用 mode="multi_image"。',
        })
      }

      const timeout = resolveTimeout(config)
      const endpoint = endpointOf(resolveBaseURL(config))

      // 3) 按官方文档组装请求体（response_format 绝不放在顶层）。
      const body = { model: MODEL, prompt, size }
      if (ratio !== '1:1') body.ratio = ratio
      if (mode === 'text2img') {
        // 文生图要 Base64：顶层 return_base64: true（文档「重要说明」）。
        if (outputFormat === 'base64') body.return_base64 = true
        else body.extra_body = { response_format: 'url' }
      } else {
        // 图生图/多图合成：输入图放 extra_body.image，不要 tags；Base64 用 extra_body.response_format。
        body.extra_body = { image: images, response_format: outputFormat === 'base64' ? 'b64_json' : 'url' }
      }

      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeout)
      const onAbort = () => controller.abort()
      if (exec && exec.signal) {
        if (exec.signal.aborted) controller.abort()
        else exec.signal.addEventListener('abort', onAbort, { once: true })
      }

      let response
      let rawText
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        rawText = await response.text()
      } catch (error) {
        if (timedOut) {
          return failure({
            ...base,
            code: 'timeout',
            message:
              `Agnes 请求超时（${Math.round(timeout / 1000)} 秒）。图片生成可能需要数秒到几十秒，` +
              '可把配置里的超时调高（最高 360s）后重试；也可以先降低 size（如 2K→1K）或简化 prompt。',
          })
        }
        const cause = error && error.cause && (error.cause.code || error.cause.message)
        return failure({
          ...base,
          code: 'network_error',
          message:
            '无法连接 Agnes API。请检查网络/代理是否可访问 https://api.agnes-ai.cn，' +
            `以及配置里的 Base URL 是否正确。\n${error && error.message ? error.message : String(error)}` +
            (cause ? `\n底层原因：${cause}` : ''),
        })
      } finally {
        clearTimeout(timer)
        if (exec && exec.signal) exec.signal.removeEventListener('abort', onAbort)
      }

      let payload
      try {
        payload = rawText ? JSON.parse(rawText) : undefined
      } catch {
        payload = undefined
      }

      if (!response.ok) {
        const explained = explainHTTPError(readErrorPayload(response.status, payload, rawText))
        return failure({ ...base, ...explained })
      }

      if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) {
        return failure({
          ...base,
          code: 'bad_response',
          message:
            'Agnes 返回了空结果或无法识别的响应格式（期望 data[0].url 或 data[0].b64_json）。\n' +
            `响应片段：${(rawText || '').slice(0, 400)}`,
        })
      }

      const item = payload.data[0] || {}
      const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

      // 4) URL 模式：展示链接；同时尝试下载成附件做内联预览（失败不影响主结果）。
      if (outputFormat === 'url') {
        const url = validImageURL(item.url)
        if (!url) {
          return failure({
            ...base,
            code: 'bad_response',
            message:
              'Agnes 没有返回合法的图片 URL（data[0].url）。可改用 output_format:"base64" 重试，' +
              '或把响应片段反馈给管理员。',
          })
        }
        let image
        try {
          const saved = await materializeImage(ctx, { kind: 'url', url }, controller.signal)
          image = saved.ref ? { ...saved.ref } : undefined
        } catch {
          image = undefined
        }
        const pixels = native ? `，原生像素 ${native}` : ''
        return result({
          ...base,
          ok: true,
          code: 'ok',
          url,
          ...(image ? { image } : {}),
          ...(revisedPrompt ? { revisedPrompt } : {}),
          message:
            `已生成 1 张图片（${size}${ratio !== '1:1' ? ` / ${ratio}` : ''}${pixels}）。\n` +
            `链接：${url}\n` +
            (image ? '已在会话中内联预览。' : '（浏览器可直接打开链接查看。）') +
            (revisedPrompt ? `\nAgnes 改写后的提示词：${revisedPrompt}` : ''),
        })
      }

      // 5) Base64 模式：只回附件/文件，不回传超长 Base64。
      if (typeof item.b64_json !== 'string' || item.b64_json.trim().length === 0) {
        return failure({
          ...base,
          code: 'bad_response',
          message:
            'Agnes 没有返回 b64_json。请确认文生图使用 return_base64、图生图使用 extra_body.response_format:"b64_json"；' +
            '也可改用 output_format:"url" 重试。',
        })
      }
      const decoded = decodeBase64Image(item.b64_json)
      if (!decoded) {
        return failure({
          ...base,
          code: 'bad_response',
          message: `Agnes 返回的 b64_json 不是合法 Base64：${previewBase64(item.b64_json)}`,
        })
      }
      const mediaType = sniffMediaType(decoded)
      if (!mediaType) {
        return failure({
          ...base,
          code: 'bad_response',
          message: 'Base64 内容不是受支持的图片格式（PNG/JPEG/WebP/GIF），已拒绝保存。',
        })
      }

      let saved
      try {
        saved = await materializeImage(ctx, { kind: 'base64', base64: item.b64_json }, controller.signal)
      } catch (error) {
        return failure({
          ...base,
          code: 'save_failed',
          message:
            '图片已生成，但保存为会话附件失败：' + (error && error.message ? error.message : String(error)) +
            '。可在配置里设置保存目录，或改用 output_format:"url"。',
        })
      }
      const filePath = await persistToDisk(config && config.saveDirectory, decoded, mediaType, stamp)
      const image = saved.ref ? { ...saved.ref } : undefined
      const pixels = native ? `，原生像素 ${native}` : ''
      return result({
        ...base,
        ok: true,
        code: 'ok',
        ...(image ? { image } : {}),
        ...(filePath ? { filePath } : {}),
        ...(revisedPrompt ? { revisedPrompt } : {}),
        message:
          `已生成 1 张图片（${size}${ratio !== '1:1' ? ` / ${ratio}` : ''}${pixels}，${mediaType}，` +
          `${Math.round(decoded.length / 1024)} KB）。` +
          (image ? '\n图片已保存到会话附件并内联预览（Base64 已省略，避免刷屏）。' : '\n图片已解码校验。') +
          (filePath ? `\n另存为：${filePath}` : '') +
          (revisedPrompt ? `\nAgnes 改写后的提示词：${revisedPrompt}` : ''),
      })
    },
  })

  ctx.tools.register(definition)

  // 配置自检工具：只报告「有没有配好、用的是哪一路来源」，绝不回显 Key 本体。
  // 用户问「为什么说没配 Key」时，AI 调它就能定位是配置没生效、还是凭据/环境变量没读到。
  ctx.tools.register({
    name: 'agnes_image_status',
    description:
      '检查 Agnes 生图工具的配置状态（只读，不生成图片）。返回 Key 是否可用、来源（插件配置 / 凭据服务 / 环境变量）、Base URL 与超时。当用户说「已经配了 Key 但还是提示未配置」时先调它定位问题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['configured', 'source', 'baseURL', 'timeoutMs', 'message'],
        properties: {
          configured: { type: 'boolean' },
          source: { type: 'string' },
          baseURL: { type: 'string' },
          timeoutMs: { type: 'number' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message }]
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute() {
      const fromConfig = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
      const fromEnv = typeof process.env.AGNES_API_KEY === 'string' ? process.env.AGNES_API_KEY.trim() : ''
      const fromSettings = fromConfig || fromEnv ? '' : await resolveSettingsApiKey(ctx)
      const fromCredential =
        fromConfig || fromEnv || fromSettings ? '' : await resolveCredentialApiKey(ctx)
      const source = fromConfig
        ? 'config'
        : fromSettings
          ? 'settings'
          : fromEnv
            ? 'env'
            : fromCredential
              ? 'credentials'
              : 'none'
      const configured = source !== 'none'
      const baseURL = resolveBaseURL(config)
      const timeoutMs = resolveTimeout(config)
      // 诊断：把 Host 侧真的注册了哪些 settings 命名空间、其中有没带 apiKey 标记一并报出来，
      // 方便定位「配置页保存了但插件读不到」这类命名空间不匹配的问题（不会输出任何 Key 内容）。
      let diag = ''
      try {
        const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
        if (settings && typeof settings.describe === 'function') {
          const list = await settings.describe()
          const mine = (Array.isArray(list) ? list : []).filter(
            (item) => item && typeof item.ns === 'string' && item.ns.includes('agnes'),
          )
          diag =
            '\n[诊断] settings 命名空间：' +
            (mine.length === 0
              ? '（没有任何包含 agnes 的命名空间）'
              : mine
                  .map((item) => {
                    const secrets = Array.isArray(item.secrets) ? item.secrets : []
                    const marker = secrets.some((s) => s && s.set && Array.isArray(s.path) && s.path.includes('apiKey'))
                    const saved =
                      (item.user && typeof item.user.apiKey === 'string' && item.user.apiKey.trim().length > 0) ||
                      (item.value && typeof item.value.apiKey === 'string' && item.value.apiKey.trim().length > 0)
                    return `${item.ns}（apiKey ${marker || saved ? '已设置' : '未设置'}）`
                  })
                  .join('、')) +
            `\n[诊断] 插件实例收到的 config.apiKey：${typeof config?.apiKey === 'string' && config.apiKey.trim() ? '非空' : '空'}`
        }
      } catch (error) {
        diag = '\n[诊断] 读取 settings 失败：' + (error && error.message ? error.message : String(error))
      }
      return {
        configured,
        source,
        baseURL,
        timeoutMs,
        message:
          (configured
            ? `Agnes API Key 已就绪（来源：${source}）。\nBase URL：${baseURL}\n超时：${Math.round(timeoutMs / 1000)}s`
            : 'Agnes API Key 仍未配置。\n' +
              '已检查：插件配置、settings 里的 apiKey、凭据服务与环境变量 AGNES_API_KEY，四路都是空的。\n' +
              '请在「插件 → Agnes 生图 → 配置」填入 Key 并保存（保存后无需重启，工具每次调用都会重新读取）。') +
          diag,
      }
    },
  })
}

/** tools 服务是硬依赖：没有它本插件不激活。 */
export const inject = ['tools']
export { Config, PARAMETERS, OUTPUT_SCHEMA, DESCRIPTION, MODEL, SIZES, RATIOS }
