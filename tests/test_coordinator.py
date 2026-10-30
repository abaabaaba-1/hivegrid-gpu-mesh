from __future__ import annotations

import json
import os
import threading
import time
import unittest
import urllib.error
import urllib.request

from babelmesh_demo.coordinator import Server


class CoordinatorApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.old_timeout = os.environ.get("BABELMESH_HEARTBEAT_TIMEOUT")
        self.old_interval = os.environ.get("BABELMESH_MONITOR_INTERVAL")
        os.environ["BABELMESH_HEARTBEAT_TIMEOUT"] = "0.4"
        os.environ["BABELMESH_MONITOR_INTERVAL"] = "0.05"
        self.server = Server("127.0.0.1", 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        if self.old_timeout is None:
            os.environ.pop("BABELMESH_HEARTBEAT_TIMEOUT", None)
        else:
            os.environ["BABELMESH_HEARTBEAT_TIMEOUT"] = self.old_timeout
        if self.old_interval is None:
            os.environ.pop("BABELMESH_MONITOR_INTERVAL", None)
        else:
            os.environ["BABELMESH_MONITOR_INTERVAL"] = self.old_interval

    def request(self, path: str, method: str = "GET", body: dict | None = None) -> tuple[int, object]:
        payload = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=payload, method=method)
        if payload:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=2) as response:
                raw = response.read().decode()
                return response.status, raw if response.headers.get_content_type() == "text/plain" else json.loads(raw)
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode())

    def register(self, node_id: str, gpu: str, model: str = "demo", memory: int = 1000) -> None:
        status, body = self.request("/v1/nodes/register", "POST", {"node_id": node_id, "gpu_index": gpu, "models": [model], "memory_mb": memory, "cuda_ready": True})
        self.assertEqual(status, 200, body)

    def test_standard_health_nodes_and_metrics(self) -> None:
        status, body = self.request("/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.register("gpu0", "0")
        status, body = self.request("/v1/nodes")
        self.assertEqual(status, 200)
        self.assertEqual(body["nodes"][0]["status"], "ready")
        status, body = self.request("/metrics")
        self.assertEqual(status, 200)
        self.assertIn("success_rate", body)
        status, text = self.request("/metrics?format=prometheus")
        self.assertEqual(status, 200)
        self.assertIn("success_rate", text if isinstance(text, str) else "")

    def test_recent_task_listing(self) -> None:
        self.register("gpu0", "0")
        status, created = self.request("/v1/tasks", "POST", {"model": "demo", "input": {"prompt": "listed"}})
        self.assertEqual(status, 202)
        status, listing = self.request("/v1/tasks?limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(listing["count"], 1)
        self.assertEqual(listing["tasks"][0]["task_id"], created["task_id"])
        status, filtered = self.request("/v1/tasks?status=succeeded")
        self.assertEqual(status, 200)
        self.assertEqual(filtered["count"], 0)

    def test_idempotency_and_task_lifecycle(self) -> None:
        self.register("gpu0", "0")
        payload = {"idempotency_key": "same", "model": "demo", "input": {"prompt": "hello"}}
        status1, first = self.request("/v1/tasks", "POST", payload)
        status2, second = self.request("/v1/tasks", "POST", payload)
        self.assertEqual(status1, 202)
        self.assertEqual(status2, 200)
        self.assertTrue(second["idempotent_replay"])
        self.assertEqual(first["task_id"], second["task_id"])
        status, conflict = self.request("/v1/tasks", "POST", {**payload, "input": {"prompt": "different"}})
        self.assertEqual(status, 409)
        self.assertEqual(conflict["error"]["code"], "conflict")
        status, claimed = self.request("/v1/tasks/claim", "POST", {"node_id": "gpu0"})
        self.assertEqual(status, 200)
        self.assertEqual(claimed["task"]["status"], "running")
        self.assertEqual(self.request("/v1/tasks/claim", "POST", {"node_id": "gpu0"})[1]["task"], None)
        status, result = self.request(f"/v1/tasks/{first['task_id']}/result", "POST", {"node_id": "gpu0", "attempt": claimed["task"]["attempt"], "ok": True, "result": "ok"})
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "succeeded")

    def test_model_and_memory_routing(self) -> None:
        self.register("gpu0", "0", model="model-a", memory=100)
        self.register("gpu1", "1", model="model-b", memory=1000)
        status, task = self.request("/v1/tasks", "POST", {"model": "model-b", "input": {"prompt": "route"}, "min_memory_mb": 500})
        self.assertEqual(status, 202)
        self.assertEqual(task["assigned_node_id"], "gpu1")
        status, claimed = self.request("/v1/tasks/claim", "POST", {"node_id": "gpu1"})
        self.assertEqual(status, 200)
        self.assertEqual(claimed["task"]["worker_id"], "gpu1")

    def test_cancel_and_timeout(self) -> None:
        status, task = self.request("/v1/tasks", "POST", {"model": "unknown", "input": {"prompt": "cancel"}, "deadline_ms": 5000})
        self.assertEqual(status, 202)
        status, cancelled = self.request(f"/v1/tasks/{task['task_id']}/cancel", "POST", {})
        self.assertEqual(status, 200)
        self.assertEqual(cancelled["status"], "cancelled")
        status, expiring = self.request("/v1/tasks", "POST", {"model": "unknown", "input": {"prompt": "timeout"}, "deadline_ms": 30})
        self.assertEqual(status, 202)
        time.sleep(0.08)
        status, expired = self.request(f"/v1/tasks/{expiring['task_id']}")
        self.assertEqual(status, 200)
        self.assertEqual(expired["status"], "timeout")

    def test_worker_offline_requeues_running_task(self) -> None:
        self.register("gpu0", "0")
        self.register("gpu1", "1")
        _, task = self.request("/v1/tasks", "POST", {"model": "demo", "input": {"prompt": "recover"}, "preferred_gpu": "0", "max_retries": 1, "deadline_ms": 5000})
        _, claimed = self.request("/v1/tasks/claim", "POST", {"node_id": "gpu0"})
        self.assertEqual(claimed["task"]["worker_id"], "gpu0")
        self.server.state.workers["gpu0"]["last_heartbeat"] = time.time() - 2
        self.server.state.heartbeat("gpu1", {"status": "ready"})
        self.server.state.reconcile()
        self.assertEqual(self.server.state.tasks[task["task_id"]]["status"], "queued")
        status, retried = self.request("/v1/tasks/claim", "POST", {"node_id": "gpu1"})
        self.assertEqual(status, 200)
        self.assertEqual(retried["task"]["retries"], 1)
        self.assertEqual(retried["task"]["worker_id"], "gpu1")


if __name__ == "__main__":
    unittest.main()
