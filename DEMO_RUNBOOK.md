# 明日演示脚本

## 开场（30 秒）

先接入 SSL VPN，在浏览器打开 `http://10.98.10.1:8000/`。展示“把分散的 GPU，连成一张算力网”和 8 个在线节点，说明页面读的是 Coordinator 实时状态，不是静态看板。

如果现场 VPN 临时中断，本机已经准备好同样的八节点可视化备用页：
`http://127.0.0.1:8000/`。备用页使用 mock worker 演示调度、任务流和故障恢复，页面操作完全一致。

重启后若备用页还没启动，在项目目录执行：

```powershell
python scripts/start_local_demo.py
```

## 正常请求（1 分钟）

1. 点击“开始演示”。
2. 模型保持 `Qwen2.5 · vLLM（真实模型）`，输入：`请用三句话解释 BabelMesh 的调度流程，并说明 GPU 故障时如何恢复。`。
3. 点击“发送到集群”。
4. 观察任务从“排队中”变成“已成功”，结果中会出现 `backend=vllm` 和真实生成文本，同时任务流、成功率和 P95 延迟刷新。

## 故障恢复（1 分钟）

需要展示故障摘除时，另开 SSH 终端执行：

```powershell
ssh ubuntu@10.98.10.1
sudo systemctl stop babelmesh-worker-vllm@0.service
```

先把目标 GPU 选为 GPU 0 并提交一个问题，页面会显示节点进入离线/退出状态，任务重新排队后由其他 GPU 完成。演示结束后恢复：

```bash
sudo systemctl start babelmesh-worker-vllm@0.service
```

## 资源建议

- 真实模型已经部署在 6000D 八卡机上：8 个 RTX 6000D、8 个 vLLM 实例（18100–18107）和 8 个 BabelMesh vLLM worker 均由 systemd 开机自启。
- 对外给领导访问：准备一台能被浏览器访问的 Linux 服务器，反向代理 8000，并限制管理接口只对内网开放。

## 客户端

项目包含 Windows 客户端：`client-0.3.2/beenet.exe`。启动后本机会打开
`http://127.0.0.1:18650/`，提供蜂网聊天、模型、代码助手和“共享 GPU”页面；
`client-0.3.2/node-agent.exe` 是节点代理。客户端和 BabelMesh 控制面是两条链路：
明天的集群调度演示使用 8000 页面，客户端演示使用 18650 页面。

## 当前边界

演示控制面已经覆盖节点、路由、任务、重试、超时、取消、幂等和指标。`beenet_compat` 是协议兼容骨架，已覆盖 local API、signup、Ollama chat、OpenAI chat completions 和 Anthropic messages；账户、GPU 共享、账本和图像/视频真实后端还需要继续接入。
