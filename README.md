# Agnes 生图工具（DSH 插件）

在 DeepSeek Harness 中为 AI 增加一个 `agnes_image` 工具，允许 AI 主动调用 [Agnes Image 2.5 Flash](https://www.agnes-ai.cn/zh-Hans/docs/agnes-image-25-flash) 接口进行生成、编辑与合成图片。

> 🔒 **安全提示**：API Key 仅保存在本机，设置界面遮罩、不回显、不写日志，保障密钥安全。

## ✨ 核心功能

- **三种模式**：支持 `text2img`（文生图）、`img2img`（图生图）、`multi_image`（多图合成）。
- **尺寸与比例**：支持原生档位 `1K/2K/3K/4K` + 官方支持的 `ratio`（`1:1 3:4 4:3 16:9 9:16 2:3 3:2 21:9`）。
- **灵活输出**：`output_format` 可选 `url` 直接给链接；或 `base64` 将结果存为会话附件并内联预览（避免超长文本刷屏）。
- **错误分型提示**：针对未配置 Key、缺 `images`、参考图不可访问、超时、鉴权失败等提供友好的修复建议。
- **严格图片校验**：对返回的图片进行协议、主机、Base64 解码及文件头（PNG/JPEG/WebP/GIF）校验，确保展示内容安全合规。

## 🚀 安装

在 Harness 中使用插件管理器安装本目录：
- 使用 `plugin_manager` 的 `install_bundle`，target 指向 `agnes-image` 目录的绝对路径；
- 或在 Plugins 页面安装本地 bundle。

安装后插件名为 **Agnes 生图**，配置入口在 **Plugins → Agnes 生图 → 配置**。

## 🔑 配置 API Key

系统会按以下顺序解析 Key，前一路为空才看下一路（每次工具调用重新解析，修改 Key 后无需重启）：

1. **设置界面（推荐）**：Plugins → Agnes 生图 → 配置 → 填入 API Key → 保存。
   Key 以 `role('secret')` 写入本机 profile 的 Cordis 配置，界面遮罩、无法读回；插件在调用时通过 `settings.describe()` 取回真值（仅内存使用，不写日志）。
2. **凭据服务**：`ctx.credentials` 里的 `AGNES_API_KEY`（`.dsh/.credentials.yaml` 的 `refs`）。
3. **环境变量**：`AGNES_API_KEY`（需重启进程才会生效）。

未配置时调用工具不会抛错，而是返回引导提示，告诉用户去哪里配置。如需诊断，可以让 AI 调用 `agnes_image_status` 工具，它会报告「是否配好 / 来源 / Base URL / 超时」，且**绝不回显 Key**。

### 🔍 排查「配了 Key 还说没配」
`agnes_image_status` 会顺带打印诊断行：settings 里本插件的命名空间、该命名空间的 `apiKey` 状态、以及插件实例收到的 `config.apiKey` 是否为空，用以区分「保存失败」还是「读取失败」。

## 🛠️ 工具参数说明

AI 在判断需要生成图片时，会主动调用 `agnes_image` 工具，支持以下参数：

| 参数名 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 图像生成或编辑指令（AI 会自动按官方推荐结构组织）。 |
| `mode` | string | 否 | `text2img` \| `img2img` \| `multi_image`（默认 `text2img`）。 |
| `size` | string | 否 | 输出档位：`1K` \| `2K` \| `3K` \| `4K`（默认 `2K`，勿传精确像素）。 |
| `ratio` | string | 否 | 宽高比，如 `16:9`（默认 `1:1`）。 |
| `images` | string[] | 否 | 图生图/多图合成必填：HTTPS URL 或 Data URI Base64。 |
| `output_format`| string | 否 | `url`（默认返回链接）或 `base64`（直接转为附件预览）。 |

## 📖 官方文档对应关系

本项目严格遵循官方 API 文档开发，关键实现对应如下：

| 文档要点 | 实现位置 |
| --- | --- |
| 模型 `agnes-image-2.5-flash` | `index.js` 的 `MODEL` |
| `POST /v1/images/generations` | `ENDPOINT_PATH` + `endpointOf()` |
| `Authorization: Bearer` | `execute()` 的请求头 |
| 文生图必填 `model/prompt/size` | `body = { model, prompt, size }` |
| 档位 `size` + `ratio` | `SIZES` / `RATIOS` / `SIZE_TABLE` |
| 图生图 `extra_body.image`，不要 `tags` | `extra_body = { image, response_format }` |
| URL 输出用 `extra_body.response_format:"url"` | text2img / img2img 分支 |
| 图生图 Base64 用 `extra_body.response_format:"b64_json"` | img2img/multi_image 分支 |
| 文生图 Base64 用顶层 `return_base64:true` | `mode === 'text2img'` 且 base64 |
| 超时 60s–360s | `timeoutMs` 配置与 `resolveTimeout()` |
| 提示词推荐结构 | 工具 `description` |
| 常见错误与修复建议 | `explainHTTPError()` 与各校验分支 |

## 🛡️ 安全说明

- Key 不进入日志、不出现在工具返回值或错误信息里，也不发往除 Agnes 之外的地址。
- 设置页输入框为 `password`，已保存的 Key 由 Host 在 `settings.describe` 阶段剥离，浏览器拿不到。
- 生成图若设置「另存目录」，仅写入用户显式填写的本机绝对路径。

## 📝 开源协议

MIT License