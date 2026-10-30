"""Run the five-minute BabelMesh control-plane demonstration.

The script uses mock workers so it is repeatable on a machine without CUDA.
It demonstrates registration, routing, an in-flight worker failure, retry on a
second worker, and the JSON metrics endpoint.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("BABELMESH_DEMO_PORT", "8000"))
BASE = f"http://127.0.0.1:{PORT}"


def request(path: str, method: str = "GET", body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=payload, method=method)
    if payload:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def wait_for(predicate, timeout: float = 15.0, label: str = "condition") -> Any:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception:
            pass
        time.sleep(0.25)
    raise RuntimeError(f"timed out waiting for {label}: {last}")


def main() -> int:
    processes: list[subprocess.Popen[str]] = []
    coordinator_env = os.environ.copy()
    coordinator_env.update({"BABELMESH_COORDINATOR_PORT": str(PORT), "BABELMESH_HEARTBEAT_TIMEOUT": "2", "BABELMESH_MONITOR_INTERVAL": "0.2", "BABELMESH_QUIET": "1"})
    try:
        processes.append(subprocess.Popen([sys.executable, "-m", "babelmesh_demo.coordinator"], cwd=ROOT, env=coordinator_env, text=True))
        wait_for(lambda: request("/healthz")[0] == 200, label="coordinator")
        print("[1/5] coordinator healthy", flush=True)

        for worker_id, gpu, delay in (("gpu0", "0", "5"), ("gpu1", "1", "0.1")):
            env = os.environ.copy()
            env.update({"BABELMESH_MOCK": "1", "BABELMESH_MOCK_DELAY": delay, "BABELMESH_HEARTBEAT_INTERVAL": "0.4"})
            processes.append(subprocess.Popen([sys.executable, "-m", "babelmesh_demo.worker", "--coordinator", BASE, "--worker-id", worker_id, "--gpu-index", gpu, "--model", "demo"], cwd=ROOT, env=env, text=True))
        wait_for(lambda: len([node for node in request("/v1/nodes")[1].get("nodes", []) if node.get("status") == "ready"]) == 2, label="two ready workers")
        print("[2/5] two workers registered", flush=True)

        _, submitted = request("/v1/tasks", "POST", {"idempotency_key": "demo-failure-001", "model": "demo", "input": {"prompt": "failure injection demo"}, "preferred_gpu": "0", "deadline_ms": 15000, "max_retries": 1})
        task_id = submitted["task_id"]
        wait_for(lambda: request(f"/v1/tasks/{task_id}")[1].get("status") == "running" and request(f"/v1/tasks/{task_id}")[1].get("worker_id") == "gpu0", label="task running on gpu0")
        print(f"[3/5] task {task_id} running on gpu0", flush=True)

        processes[1].terminate()
        processes[1].wait(timeout=5)
        recovered = wait_for(lambda: (lambda task: task if task.get("status") == "succeeded" and task.get("worker_id") == "gpu1" else None)(request(f"/v1/tasks/{task_id}")[1]), timeout=12, label="retry on gpu1")
        print(f"[4/5] gpu0 stopped; task retried on {recovered.get('worker_id')}", flush=True)

        _, replay = request("/v1/tasks", "POST", {"idempotency_key": "demo-failure-001", "model": "demo", "input": {"prompt": "failure injection demo"}})
        metrics = request("/metrics")[1]
        print(f"[5/5] idempotent_replay={replay.get('idempotent_replay')} metrics={json.dumps(metrics, ensure_ascii=False)}", flush=True)
        return 0
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()


if __name__ == "__main__":
    raise SystemExit(main())
