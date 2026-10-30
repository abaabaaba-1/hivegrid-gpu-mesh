# BeeNet 本机 API 重实现契约（静态分析版）

来源：BeeNet Windows 0.3.2 官方 ZIP 的 `README.md`、Go 字符串、REA/Ghidra 伪代码。以下是兼容客户端的接口边界和已确认的行为；未标注字段的 JSON 结构还需要在授权环境中通过请求样本或继续反编译确认。

## 监听与安全边界

- 默认监听 `127.0.0.1:18650`；端口冲突时从 18651 起寻找空闲端口。
- 只接受回环 Host，阻止 DNS rebinding。
- 页面会话使用 HttpOnly、SameSite=Strict Cookie。
- 改变状态的浏览器请求需要自定义请求头，防止跨站表单直接提交。
- 页面 CSP 只允许客户端自身脚本和样式；静态证据包含 `Content-Security-Policy`、`Origin`、`Cookie` 和 `missing X-Fabric header`。
- 本机 API 令牌以 `bn-local-…` 形式出现；平台密钥不暴露给调用方。

## 接口分组

| 分组 | 路径 | 方法 | 已确认用途 |
|---|---|---:|---|
| 页面/状态 | `/api/state` | GET | 返回客户端运行状态、登录/共享/本机接口状态 |
| 账户 | `/api/signup`、`/api/signin` | POST | 注册、登录 |
| 账户 | `/api/signout` | POST | 注销当前本机页面会话 |
| 账户 | `/api/recovery-code` | POST | 恢复码相关操作 |
| 账户 | `/api/account/merge` | POST | 将当前账户合并到目标账户 |
| 账户/密钥 | `/api/key/reveal` | GET | 显示登录用密钥；静态字符串同时出现 `keys_disabled` |
| 首次同意 | `/api/consent` | POST | 共享 GPU 前的同意页提交；同意前不启动节点 |
| 网关 | `/api/gateway` | POST | 保存/切换平台网关地址 |
| 本机接口 | `/api/localapi` | GET/POST | 查询、开关 OpenAI 兼容本机接口并管理 `bn-local` 令牌 |
| 机器能力 | `/api/machine` | GET | GPU、显存、PCIe、可运行模型大小等只读信息 |
| 共享 GPU | `/api/share` | POST | 开启、关闭或更新共享配置 |
| 共享 GPU | `/api/diagnostics` | GET | 节点、引擎、下载和平台连通性诊断 |
| Tor | `/api/tor` | GET | 读取 Tor 状态 |
| 自动启动 | `/api/autostart` | POST | 用户级开机自启开关 |
| 预设 | `/api/presets`、`/api/presets/{name}` | GET/POST/DELETE | 本地保存、读取和删除“模型 + 系统提示 + 参数”预设 |
| Ollama | `/api/chat`、`/api/generate` | POST | Ollama 请求翻译到 BeeNet OpenAI 协议并支持流式 NDJSON |
| Ollama | `/api/tags`、`/api/show`、`/api/ps`、`/api/version` | GET/POST | Ollama 模型、详情、运行中模型和版本兼容接口 |
| Ollama | `/api/embed` | POST | 通过平台嵌入模型生成向量 |
| 更新 | `/api/update/check`、`/api/update/apply` | POST | 检查并应用已签名发布清单 |
| 更新 | `/api/autoupdate` | POST | 自动更新开关 |
| 客户端控制 | `/api/uninstall`、`/api/quit` | POST | 卸载和退出客户端 |

## BabelMesh 演示控制面补充接口

为支持控制台实时展示，演示 Coordinator 额外提供：

| 路径 | 方法 | 用途 |
|---|---:|---|
| `/v1/tasks?limit=50&status=succeeded` | GET | 返回最近任务，按创建时间倒序；`limit` 限制为 1–200，`status` 可选 |

响应形如 `{ "tasks": [...], "count": 1 }`。单任务详情仍通过 `/v1/tasks/{id}` 获取。

## 本机 OpenAI/Anthropic 兼容面

当 `/api/localapi` 打开后，客户端端口提供：

- `GET /v1/models`
- `GET /v1/account`
- `POST /v1/chat/completions`
- `POST /v1/images/generations`
- `POST /v1/videos`
- `POST /v1/messages`（Anthropic 消息格式）
- `POST /v1/embeddings`（静态字符串出现 `embeddings`；README 对 `/api/embed` 有明确说明）

请求使用 `Authorization: Bearer bn-local-…`；Anthropic 还接受 `x-api-key`。令牌只允许调用模型相关接口，不能操作账户、共享或更新。

## 反编译得到的请求路径

`FUN_14036c980`（0x14036c980）是 `net/http` 风格的总处理入口：

1. 对 GET 请求调用 `FUN_14036c7c0` 生成页面/静态响应，并以 200 返回。
2. 其余请求调用 `FUN_1403815e0` 做方法、路径、来源和请求上下文检查。
3. 检查失败时由 `FUN_1403813c0` 返回 400。
4. 通过检查后，调用 `FUN_14036c380`、`FUN_14036c420` 处理会话/令牌，再进入业务分发。

`FUN_1403815e0`（0x1403815e0）从 `http.Request` 类似结构的偏移 0x40/0x48 读取请求字段，组装校验对象并调用 `FUN_14016dd40`、`FUN_14016de80`。这说明 400 是统一的请求保护层，而不是某个业务接口独有的错误。

`FUN_14036c420`（0x14036c420）调用随机源读取 24 字节，使用内置 `0123456789abcdef` 转成 48 字符十六进制文本，再经过后续处理返回令牌/会话值。它与二进制中的 `local-api.token`、`bn-local`、Cookie、Origin 和 `missing X-Fabric header` 字符串相邻出现，支持“本机令牌 + 浏览器来源校验”的实现判断。

## 三个重点接口的恢复结果

下面的字段分为两类：内嵌 UI 发出的 JSON 是直接证据；REA/Ghidra 伪代码中看到的字段和分支是二进制证据。原始 Go 类型名和局部变量名没有恢复，因此流程中的函数名用地址表示。

### `POST /api/signup`

内嵌页面的调用是：

```json
{
  "invite_code": "<邀请码>",
  "account": "<账户名或邮箱>"
}
```

请求必须带 `X-Fabric: 1`，并以 `Content-Type: application/json` 发送。页面只读取成功结果中的两个字段：

```json
{
  "account": "<规范化后的账户>",
  "recovery_code": "<恢复码>"
}
```

`recovery_code` 存在时，页面会把它和 `account` 一起保存给用户。成功响应的 HTTP 状态是 2xx；原始响应对象可能还有其他字段，但当前证据没有证明它们是稳定的公开契约。

处理流程（`main.(*Server).signup`，`0x140382080`）：

1. 创建约 0x20 字节的请求体对象，并通过 `0x1403815e0` 做统一请求检查。
2. 从 JSON 取两个字符串值；当前 UI 和字符串交叉引用将它们对应为 `invite_code`、`account`。任一为空时直接返回 400。
3. 创建 30 秒上下文，调用平台注册回调。普通路径使用 `0x140391e00`；邀请码以 `-baff-ks` 前缀开头时会进入另一条特殊回调路径（这是静态分支推断，不能当作公开邀请码规则）。
4. 平台错误时透传有效的 HTTP 状态；状态不在有效范围时回退为 502，并写入统一错误对象。
5. 注册成功后调用 `0x14035fde0` 更新本地账户/会话状态，再序列化成功 JSON。该步骤说明注册结果会落到本地会话，而不只是返回一个远端响应。

### `/api/localapi`

该接口用于开关本机 OpenAI 兼容网关并管理独立的 `bn-local-...` 令牌。页面调用已经恢复为：

| 方法 | 请求 JSON | 响应中已确认字段 |
|---|---|---|
| `GET` | 无 | `on: boolean`；开启时还有 `base: string`、`token: string` |
| `POST` | `{ "on": true/false }` | 同上；关闭时至少返回 `{"on":false}` |
| `POST` | `{ "on": true, "renew": true }` | 返回新的 `base`、`token`；旧令牌失效 |

开启时 `base` 形如 `http://127.0.0.1:18650/v1`。这个 token 与平台账户 API key、浏览器会话 Cookie 是三套不同凭据。页面请求同样必须带 `X-Fabric: 1`；浏览器自动携带页面会话 Cookie。

处理流程：

1. `main.(*Server).localAPI`（`0x14036c980`）把 GET 分派到 `main.(*Server).localAPIView`（`0x14036c7c0`），返回当前开关、地址和令牌状态。
2. POST 先通过 `0x1403815e0` 的方法/来源/上下文检查，再经过 `0x14036c380`、`0x14036c420` 的会话和令牌逻辑。
3. `on:false` 关闭本机网关；`on:true` 启动或保持网关；同时提供 `renew:true` 时重新生成令牌并替换旧值。
4. 令牌生成路径读取 24 字节随机数并编码为 48 个十六进制字符，外层再加 `bn-local-` 前缀或等价包装。具体持久化键名在二进制中出现为 `local-api.token`。

### `POST /api/chat`（Ollama 兼容）

`main.(*Server).ollamaChat`（`0x1403761c0`）是 `/api/chat` 的核心处理函数；`main.chatBody`（`0x1403750c0`）负责把请求体规范化后交给模型调度。已从二进制直接恢复的输入字段如下：

| 字段 | 作用/证据 |
|---|---|
| `model` | 必填；缺失或空值返回 400，错误文本为 `model is required` 类信息 |
| `messages` | chat 模式要求的消息数组 |
| `stream` | 是否流式；未提供时默认 `true` |
| `role`, `content` | 消息对象字段 |
| `system`, `prompt`, `images` | 兼容 generate/多模态或系统提示的输入 |
| `format`, `schema`, `strict`, `json_schema`, `response_format` | 结构化输出相关字段 |
| `options` | Ollama 参数容器 |
| `temperature`, `top_p`, `seed`, `stop`, `num_predict`, `presence_penalty` | `options` 中已观察到的参数 |
| `stream_options`, `include_usage` | 流式用量统计开关 |

字符串池还出现 `prompt_eval_count`、`frequency_penalty` 等 Ollama/OpenAI 兼容字段；当前已确认它们存在，但尚未从伪代码中单独确认每个字段的读写位置，因此重实现时应作为可选字段处理。

非流式 chat 响应中已确认会构造这些字段：

```json
{
  "model": "<model>",
  "created_at": "<timestamp>",
  "message": {
    "role": "assistant",
    "content": "<text>"
  },
  "done": true,
  "done_reason": "stop",
  "total_duration": 0,
  "eval_count": 0
}
```

`thinking` 和 `tool_calls` 在伪代码中是可选分支；generate 模式使用顶层 `response`（以及可选 `thinking`），而不是 `message`。`done_reason` 会在停止条件对应的分支中取 `stop`，长度限制分支取 `length`。数值字段的实际单位由上游模型适配器决定，当前静态证据只能确认字段名，不能确认每个计数的单位。

流式模式会输出 Ollama 风格的逐行 JSON（NDJSON），中间对象携带增量 `message.content` 或 `response`，最后一行带 `done:true`、`done_reason` 和统计字段。伪代码已确认这些键和最终行构造，但没有恢复出原始 Go 结构体的全部零值/省略规则，因此兼容实现应按 Ollama 客户端允许的字段子集解析。

处理流程（`0x1403761c0`）：

1. 解析并校验 JSON；请求保护层失败返回 400。
2. 读取 `model`，空值返回 400；读取 `stream`，缺省设为 true。
3. chat 分支检查 `messages`；随后调用 `chatBody` 统一处理消息、系统提示、图片、结构化输出和 `options`。
4. 设置约 30 秒的上游请求上下文，调用模型调度函数 `0x14037c360`。
5. 上游错误映射为网关错误；成功时按 `stream` 选择 NDJSON 增量输出或单个最终 JSON。

### 页面通用请求封装

内嵌 `api()` 函数显示，除 GET 无请求体外，其他调用默认使用 POST；所有请求带 `X-Fabric: 1`。非 2xx 响应优先读取 `data.error.message`，其次读取 `data.error`、原始文本或 `statusText`，因此重实现时应保留对象形式的 `error` 字段。

## 重实现时建议的边界

先实现回环 HTTP 服务和上述路由，再实现本地 JSON/NDJSON 协议转换；平台访问、账户密钥、节点证明和 GPU 共享应作为独立模块。不要把平台密钥直接放进本机 API 响应，也不要把 UI 会话 Cookie 当作本机 API 令牌。

## 证据文件

- `beenet-api-handler-evidence.json`：0x14036c7c0 的伪代码和字符串引用。
- `beenet-route-init-evidence.json`：0x14036c980 的总入口伪代码。
- `beenet-auth-matcher-evidence.json`：0x1403815e0 的请求校验伪代码。
- `beenet-session-check-evidence.json`：0x14036c420 的随机令牌/会话相关伪代码。
- `beenet-signup-handler-evidence.json`：0x140382080 的注册处理器伪代码。
- `beenet-chatbody-evidence.json`：0x1403750c0 的 Ollama 请求体规范化伪代码。
- `beenet-ollama-chat-evidence.json`：0x1403761c0 的 `/api/chat` 解析、调度和响应构造伪代码。
- `ui1.js`、`chat.js`：从客户端资源中提取的内嵌页面脚本；其中 `ui1.js` 直接包含 `/api/signup`、`/api/localapi` 和通用 `api()` 调用。
