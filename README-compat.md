# BeeNet 兼容服务骨架

这是根据 `beenet-api-contract.md` 的静态分析结果写的 clean-room 协议实现，不包含原始 BeeNet 二进制或源代码。

## 启动

```powershell
python -m beenet_compat.server
```

默认监听 `127.0.0.1:18650`，可通过 `BEENET_PORT` 修改端口。当前模型后端是确定性的本地 stub，用于验证协议；将 `ChatBackend.reply` 替换为真实推理后端即可接入模型服务。

## 已实现接口

- `GET/POST /api/localapi`：开关和轮换 `bn-local-*` 令牌
- `POST /api/signup`：`invite_code` + `account`，返回 `account` + `recovery_code`
- `POST /api/chat`：Ollama 风格非流式 JSON 和流式 NDJSON
- `GET /v1/models`、`GET /v1/account`
- `POST /v1/chat/completions`、`POST /v1/messages`

浏览器控制面请求需要 `X-Fabric: 1`。开启 localapi 后，`/v1` 请求使用 `Authorization: Bearer <bn-local-token>`。
