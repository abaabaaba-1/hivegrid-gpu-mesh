# HiveGrid GPU Mesh

[![CI](https://github.com/abaabaaba-1/hivegrid-gpu-mesh/actions/workflows/ci.yml/badge.svg)](https://github.com/abaabaaba-1/hivegrid-gpu-mesh/actions/workflows/ci.yml)

HiveGrid is a multi-GPU inference control plane for registering GPU workers,
routing model tasks, tracking execution, and recovering from worker failures.
It includes a lightweight visual dashboard, a coordinator API, vLLM-backed
workers, and a local mock mode for demos without a GPU.

The repository is organized around three layers:

- `babelmesh_demo/`: Coordinator, Worker, dashboard, vLLM adapters, and systemd templates;
- `beenet_compat/`: compatibility API skeleton for the original client flows;
- `tests/`: HTTP-level scheduler and lifecycle tests.

## Quick start

```powershell
python scripts/start_local_demo.py
```

Open `http://127.0.0.1:8000/` to view the dashboard. The local fallback starts
eight mock workers so the node map, task flow, metrics, and retry behavior can
be demonstrated without the production GPU host.

## Production layout

The same coordinator API runs on an NVIDIA host with one vLLM instance and one
worker per GPU. The deployment notes cover the RTX 6000D host, systemd units,
model configuration, and the presentation flow:

- [README-babelmesh-demo.md](README-babelmesh-demo.md)
- [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)
- [6000D_CONNECTION.md](6000D_CONNECTION.md)
- [DEPLOYMENT.md](DEPLOYMENT.md)

Production deployment is intentionally manual and reviewable. GitHub Actions
automatically compiles the project and runs the API test suite on Python 3.11,
3.12, and 3.13 for every push to `main` and every pull request.

## Validation

```powershell
python -m unittest discover -s tests -v
```

For contributor rules and credential handling, see [CONTRIBUTING.md](CONTRIBUTING.md)
and [SECURITY.md](SECURITY.md).
