# BeeNet 客户端静态分析（REA）

分析对象：官方 Windows ZIP 版 0.3.2，未执行二进制，仅做静态分析。

## 文件

| 文件 | SHA-256 | 结论 |
|---|---|---|
| `beenet.exe` | `4420f965d69d4d3b6b7909a3a54372689f13ef6fc25ed15fa25296d706547a37` | 64 位 Windows Go 主客户端 |
| `node-agent.exe` | `c6ddf66814b5614c14f55575c11ab3a80a34fc75e82ff0ed5b15643bebc51893` | 64 位 Windows Go GPU 节点代理 |

REA `inspect_go_binary` 识别到 Go 1.27.2、CGO_ENABLED=0、amd64/windows。

主客户端内嵌模块路径：`fabric/client`，依赖本地模块 `gpu-research/fit`。

节点代理内嵌模块路径：`gpu-research/node-agent`，依赖 `gpu-research/artifact`、`attestation`、`e2e`、`pki`、`receipt`、`relay`、`tlog`，以及 `quic-go/quic-go`。

## 主客户端可恢复的源码结构

从 Go 符号和字符串中可观察到以下模块边界：

- `main.Manager`、`main.Server`、`main.Platform`：客户端生命周期、本机 HTTP 服务和平台访问。
- `main.Config`、`main.Store`、`main.OpenStore`：本地设置、密钥和状态存储。
- `main.Fetcher`、`main.NewFetcher`、`main.failover`：平台请求、失败转移。
- `main.Updater`、`main.VerifyRelease`、`main.VerifyRegistryAny`：更新清单、签名和版本校验。
- `main.GPU`、`main.detectGPUs`、`main.readGPUUse`、`main.MachineProfile`：GPU 检测、占用率和机器能力。
- `main.shareOn`、`main.shareOff`、`main.shareStatus`、`main.startNode`：共享 GPU 生命周期。
- `main.NewTorSwitch`、`main.torSwitch`、`main.socksDial`：Tor 代理切换。
- `main.cliLogin`、`main.cliModels`、`main.cliRun`、`main.cliShare`、`main.cliConnect`：命令行入口。
- `main.anthropicToOpenAI`、`main.toOpenAIMessages`、`main.ollamaDetails`：协议转换。

## 主客户端核心本机接口

静态字符串中确认了回环 HTTP 服务和以下路由：

- `GET /api/state`
- `POST /api/signup`
- `POST /api/signin`
- `POST /api/gateway`
- `POST /api/consent`
- `POST /api/localapi`
- `GET /api/machine`
- `GET /api/presets`、`POST /api/presets`、`/api/presets/{name}`
- `POST /api/share`
- `GET /api/ollama`、`POST /api/ollama`
- `POST /api/chat`
- `GET /api/tor`
- `POST /api/autostart`
- `GET /api/key/reveal`
- `POST /api/recovery-code`
- `POST /api/account/merge`
- `GET /api/diagnostics`
- `POST /api/autoupdate`
- `POST /api/update/check`、`POST /api/update/apply`
- `POST /api/uninstall`
- `POST /api/signout`
- `POST /api/quit`

主客户端还包含公网协议代理路由：`/v1/models`、`/v1/account`、`/v1/chat/completions`、`/v1/images/generations`、`/v1/videos`、`/v1/contributions`、`/v1/trial`、`/v1/mint/keys` 等。

本机协议兼容信息：OpenAI `/v1`、Ollama `/api/*`、Anthropic `POST /v1/messages`；默认监听 `127.0.0.1:18650`，冲突时递增端口。

## 节点代理可恢复的源码结构

- `main.Controller`、`main.NewController`：节点控制面。
- `main.Assignment`、`main.fetchAssignment`、`main.localizeAssignment`：任务领取和本地化。
- `main.engine`、`main.startEngine`、`main.engineProc`、`main.modelFetcher`：模型/推理引擎和模型下载。
- `main.gpu`、`main.gpuDevices`、`main.modelBencher`、`main.measureModel`：GPU 能力和测速。
- `main.meteringProxy`、`main.usage`、`main.usageNote`：用量计量。
- `main.NodeAttestor`、`main.attestGet`、`main.attestPost`、`main.verifyRS`：节点证明和验证。
- `main.serveTunnel`、`main.startRPCServer`、`main.rpcServerArgs`：中继和 RPC 服务。
- `main.comfyAdapter`、`main.sdAdapter`、`main.startComfy`、`main.startSD`、`main.startSDVideo`：图像/视频后端。
- `main.searchService`、`main.parseBingPage`、`main.parseDuckPage`：联网搜索后端。
- `gpu-research/pki`、`artifact`、`attestation`、`receipt`、`relay`、`tlog`：密钥、加密工件、证明、签名回执、中继和透明日志。

节点代理静态字符串中还发现了 `/v1/enroll`、`/v1/attest`、`/v1/tokens`、`/v1/relays`、`/v1/assignments`、`/v1/usage`、`/v1/audits`、`/v1/limits`、`/v1/nodes/{id}/...`、`/v1/tenants/{tenant}/...` 等控制面接口，以及 `quic-go` 依赖，说明节点到平台之间存在基于 QUIC/中继的控制和数据通道。

## Ghidra 深度分析结果

已配置官方 Ghidra 12.1.4 和 Microsoft OpenJDK 21，并通过 REA `doctor` 检查。REA 对主客户端建立了 Ghidra 快照：

- `beenet.exe`：7,951 个过程、17,810 个已定义字符串，镜像基址 `0x140000000`。
- `node-agent.exe`：9,916 个过程、22,503 个已定义字符串，镜像基址 `0x140000000`。
- 两个程序均为 PE x86-64，主代码区分别约 4.0 MiB 和 5.4 MiB。
- Ghidra 没有发现 PDB；原始 Go 版本 1.27.2 超出 Ghidra 12.1.4 的已测试 RTTI 版本，因此 Go 专用类型恢复不完整，但 PE、函数边界、字符串、调用关系和反编译能力已经可用。

REA 证据：主客户端概览 `ev_8862160d8ee6475042edabb222b544fce4835081ea1845a1b49797b83431478a`，主客户端字符串查询 `ev_73c742255b4bd364c8cd9b277574d9b5d1c58d4d5095fb6bec41a9605b6cab70`，节点代理概览 `ev_7d36b20a93cbbff3edc2046d03a75b4e791a227a1a514697882839b1bf7d7a42`。

针对本机 API 路由字符串 `0x1404026aa`，REA 找到交叉引用 `0x14036c864`，并反编译出过程 `FUN_14036c7c0`。该过程有 13 个基本块、9 个直接调用、59 条出边，伪代码包含 `/v1/messages`、`/api/recover`、`/api/signout`、`/api/gateway`、`/api/consent`、`/api/localapi`、`/api/presets` 等路由字符串，说明它属于本机 HTTP 路由/服务初始化路径，而不是单个业务请求处理器。完整函数 Evidence 已保存为 `beenet-api-handler-evidence.json`。

进一步反编译得到：

- `FUN_14036c980`（0x14036c980）是总 HTTP 入口。GET 请求直接调用 `FUN_14036c7c0` 返回页面/静态响应；其他请求先进入 `FUN_1403815e0`，失败统一写回 HTTP 400，再继续会话/业务处理。
- `FUN_1403815e0`（0x1403815e0）从类似 `http.Request` 的结构读取方法和路径字段，组装校验对象并调用 `FUN_14016dd40`、`FUN_14016de80`。它是请求来源、路径和上下文保护层，而不是某个业务 API 的实现。
- `FUN_14036c420`（0x14036c420）读取 24 字节随机值，并使用内置十六进制字符表生成 48 字符文本，再交给后续处理。结合 `local-api.token`、`bn-local`、Cookie、Origin 和 `missing X-Fabric header` 字符串，可以确认本机接口采用独立令牌并带浏览器来源校验。

面向重实现的接口分组和伪代码证据已整理到 `beenet-api-contract.md`；新增证据文件为 `beenet-auth-matcher-evidence.json`、`beenet-request-check-evidence.json`、`beenet-session-check-evidence.json`。这些结果足以先搭建回环 HTTP 服务、OpenAI/Ollama/Anthropic 协议转换和会话保护层；账户、平台密钥和节点证明仍应作为独立模块按授权协议重新实现。

快照文件：`beenet-ghidra.snapshot.json`、`node-agent-ghidra.snapshot.json`。

## 重点接口的函数级恢复

以下结果把 Go 符号表、REA/Ghidra 伪代码和客户端内嵌页面脚本交叉验证。字段名来自页面请求或二进制中的 JSON key；没有把无法确认的 Go 类型名强行补出来。

### `/api/signup`

- `main.(*Server).signup`：`0x140382080`，证据文件 `beenet-signup-handler-evidence.json`（Evidence `ev_911a188fcd58ddd2ca70f039a3f8f2d37517f3d6a0ead34d6f713d25d662e8e9`）。
- 页面直接发送 `POST /api/signup`：`{"invite_code": ..., "account": ...}`，请求头由 `api()` 统一添加 `X-Fabric: 1` 和 JSON 内容类型。
- 处理器先走统一请求检查，再解析两个必填字符串；缺任一个返回 400。
- 创建 30 秒上下文并调用平台注册回调；平台错误透传有效状态，非法状态回退 502。
- 成功后刷新本地账户/会话状态，页面读取 `account` 与 `recovery_code`，并保存恢复码。

### `/api/localapi`

- `main.(*Server).localAPI`：`0x14036c980`；GET 视图 `main.(*Server).localAPIView`：`0x14036c7c0`。
- GET 返回 `on`，开启时还返回 `base` 和 `token`；POST 接受 `{on}`，以及 `{on:true,renew:true}` 的令牌轮换请求。
- UI 证据显示本机基地址形如 `http://127.0.0.1:18650/v1`，令牌形如 `bn-local-...`；它与平台账户密钥分离。
- 二进制证据显示 POST 经过统一请求和会话检查；令牌生成读取 24 字节随机数并编码为十六进制文本。

### `/api/chat`

- `main.(*Server).ollamaChat`：`0x1403761c0`，证据文件 `beenet-ollama-chat-evidence.json`（Evidence `ev_4fbd8d135ee15f04707aa1c9304b4365cce79f8b35b3cee4d908bd24b341455e`）。
- `main.chatBody`：`0x1403750c0`，证据文件 `beenet-chatbody-evidence.json`（Evidence `ev_b7d67f9c559db4023ceaab732c33dcb415e54b8180090ef813747e363a9dc4d1`），负责消息、系统提示、图片、结构化输出和 `options` 的规范化。
- `model` 必填；`stream` 缺省为 true；chat 模式检查 `messages`。
- 已恢复输入 key：`model`、`messages`、`stream`、`system`、`role`、`content`、`prompt`、`images`、`schema`、`strict`、`json_schema`、`response_format`、`options`、`temperature`、`top_p`、`seed`、`stop`、`num_predict`、`presence_penalty`、`stream_options`、`include_usage`。
- 已恢复输出 key：`done`、`done_reason`、`total_duration`、`eval_count`、`created_at`、`message`、`role`、`content`、`thinking`、`tool_calls`、`response`。非流式 chat 使用 `message`；generate 分支使用 `response`；流式分支输出 Ollama 风格 NDJSON，最后一行带 `done:true` 和统计字段。
- 字符串池另外出现 `prompt_eval_count`、`frequency_penalty`，但当前还没有把它们和独立读写点完全绑定，暂列为可选兼容字段。
- 上游模型调用设置约 30 秒上下文；上游失败进入网关错误路径。

这些结果已经足够写一个协议兼容的本机服务，但不等同于恢复原始 BeeNet Go 源码：平台注册回调、模型上游 URL、完整结构体类型和所有错误文案仍需在有授权的运行环境中继续验证。

## REA 当前限制

REA 已成功完成 Go 构建信息、PE 导入表、PE 资源和导出表分析，并已配置 Ghidra 深度分析。两个 PE 均无导出表；PE 导入仅包含 `kernel32.dll`，这是 Go 静态链接程序的常见结果。Ghidra 的 Go RTTI 分析器对 Go 1.27.2 有版本限制，所以恢复出的过程名和类型信息仍需结合 Go 符号表、字符串和调用关系解释。

结论：已经可以恢复出较清晰的客户端/节点代理源码模块结构和核心接口清单，但不能仅凭当前分析恢复原始 Go 源码。下一步可以在授权范围内针对具体接口函数继续取伪代码、调用关系和数据结构，再据此重新实现兼容客户端。
