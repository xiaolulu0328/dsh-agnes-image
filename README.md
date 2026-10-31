# Agnes 生图工具（DSH 插件）

在 DeepSeek Harness 里给 AI 增加一个 `agnes_image` 工具，按 Agnes 官方
[Agnes Image 2.5 Flash](https://www.agnes-ai.cn/zh-Hans/docs/agnes-image-25-flash) 接口
生成、编辑与合成图片。API Key 只保存在本机，设置界面遮罩、不回显、不写日志。

## 功能

- 三种模式：`text2img`（文生图）、`img2img`（图生图）、`multi_image`（多图合成）。
- 尺寸档位 `1K/2K/3K/4K` + 官方支持的 `ratio`（`1:1 3:4 4:3 16:9 9:16 2:3 3:2 21:9`）。
- `output_format`：`url` 直接给链接；`base64` 把结果存成会话附件并内联预览（正文里不放超长 Base64）。
- 错误分型友好提示：未配置 Key、缺 `images`、参考图不可公开访问、超时、鉴权失败、返回格式异常等。
- 返回图片做过校验（URL 协议/主机、Base64 解码、PNG/JPEG/WebP/GIF 文件头），避免把非图片内容当图片展示。

## 安装

```powershell
dsh plugin add @xiaolulu0328/dsh-agnes-image
```

在 Harness 里用插件管理器安装本目录：

- `plugin_manager` → `install_bundle`，target 指向 `agnes-image` 目录的绝对路径；
- 或在 Plugins 页面安装本地 bundle。

安装后插件名为 **Agnes 生图**，入口在 **Plugins → Agnes 生图 → 配置**。

## 配置 API Key

按下面的顺序解析，前一路为空才看下一路（每次工具调用重新解析，改 Key 不用重启）：

1. **设置界面（推荐）**：Plugins → Agnes 生图 → 配置 → 填入 API Key → 保存。
   Key 以 `role('secret')` 写入本机 profile 的 Cordis 配置，界面遮罩、无法读回；
   插件在调用时通过 `settings.describe()` 取回真值（只在内存里用，不写日志）。
2. **凭据服务**：`ctx.credentials` 里的 `AGNES_API_KEY`（`.dsh/.credentials.yaml` 的 `refs`）。
3. **环境变量**：`AGNES_API_KEY`（需要重启进程才会进环境）。

未配置时调用工具不会抛错，而是返回一段引导，告诉用户去哪里配置。
拿不准当前用的是哪一路，可以让 AI 调 `agnes_image_status`，它只报告「有没有配好 / 来源 / Base URL / 超时」，不会回显 Key。

### 排查「配了 Key 还说没配」

`agnes_image_status` 会顺带打印诊断行：settings 里本插件的命名空间、该命名空间的 `apiKey` 状态、
以及插件实例收到的 `config.apiKey` 是否为空，用来区分「Key 没保存成功」和「保存了但没被读到」。

## 工具参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string（必填） | 生成/编辑指令 |
| `mode` | `text2img` \| `img2img` \| `multi_image` | 默认 `text2img` |
| `size` | `1K` \| `2K` \| `3K` \| `4K` | 默认 `2K`，不要传 `1920x1080` |
| `ratio` | string | 可选，如 `16:9` |
| `images` | string[] | 图生图/多图合成必填：HTTPS URL 或 Data URI Base64 |
| `output_format` | `url` \| `base64` | 默认 `url` |

## 官方文档对应关系

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

## 安全说明

- Key 不进入日志、不出现在工具返回值或错误信息里，也不发往除 Agnes 之外的地址。
- 设置页输入框为 `password`，已保存的 Key 由 Host 在 `settings.describe` 阶段剥离，浏览器拿不到。
- 生成图若设置「另存目录」，仅写入用户显式填写的本机绝对路径。
