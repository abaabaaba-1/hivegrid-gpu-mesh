"""BabelMesh coordinator for the V0.1 single-host multi-GPU demo.

The service exposes the PRD's ``/v1`` API and keeps the previous short routes
as compatibility aliases. State is intentionally in memory for the demo, but
the task lifecycle and scheduling rules are explicit so the control plane can
later be backed by a durable store.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
import uuid
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


VERSION = "0.2.0"
DEFAULT_PORT = 8000
DEFAULT_HEARTBEAT_TIMEOUT = 6.0
DEFAULT_DEADLINE_MS = 120_000
DEFAULT_MAX_RETRIES = 1


def _now() -> float:
    return time.time()


class ConflictError(Exception):
    pass


class CoordinatorState:
    """In-memory worker, task, idempotency and metrics state."""

    def __init__(self) -> None:
        self.workers: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, dict[str, Any]] = {}
        self.idempotency: dict[str, str] = {}
        self.lock = threading.RLock()
        self.heartbeat_timeout = float(os.environ.get("BABELMESH_HEARTBEAT_TIMEOUT", DEFAULT_HEARTBEAT_TIMEOUT))
        self.monitor_interval = float(os.environ.get("BABELMESH_MONITOR_INTERVAL", "0.5"))
        self.requests_total = 0
        self.completed_durations_ms: list[float] = []
        self.stop_event = threading.Event()
        self.monitor_thread = threading.Thread(target=self._monitor, name="babelmesh-reconciler", daemon=True)
        self.monitor_thread.start()

    def close(self) -> None:
        self.stop_event.set()
        if self.monitor_thread.is_alive():
            self.monitor_thread.join(timeout=2)

    def _monitor(self) -> None:
        while not self.stop_event.wait(self.monitor_interval):
            self.reconcile()

    def record_request(self) -> None:
        with self.lock:
            self.requests_total += 1

    def _is_live_locked(self, worker: dict[str, Any], now: float | None = None) -> bool:
        now = _now() if now is None else now
        return now - float(worker.get("last_heartbeat", 0)) <= self.heartbeat_timeout

    def _normalise_status(self, status: Any, default: str = "ready") -> str:
        value = str(status or default).lower()
        return {"idle": "ready"}.get(value, value)

    def _worker_models(self, body: dict[str, Any]) -> list[str]:
        models = body.get("models")
        if isinstance(models, str):
            models = [models]
        if not isinstance(models, list):
            model = body.get("model")
            models = [model] if model else []
        return [str(model) for model in models if str(model).strip()]

    def register_worker(self, body: dict[str, Any]) -> dict[str, Any]:
        node_id = str(body.get("node_id") or body.get("worker_id") or "").strip()
        if not node_id:
            raise ValueError("node_id is required")
        now = _now()
        models = self._worker_models(body)
        record = {
            "node_id": node_id,
            "worker_id": node_id,
            "gpu_index": body.get("gpu_index"),
            "gpu_name": body.get("gpu_name", "unknown"),
            "memory_mb": int(body.get("memory_mb") or 0),
            "memory_used_mb": int(body.get("memory_used_mb") or 0),
            "cuda_visible_devices": body.get("cuda_visible_devices", ""),
            "cuda_ready": bool(body.get("cuda_ready", False)),
            "cuda_device_count": int(body.get("cuda_device_count") or 0),
            "driver_version": body.get("driver_version"),
            "cuda_version": body.get("cuda_version"),
            "backend": body.get("backend", "demo"),
            "models": models,
            "status": "ready",
            "queue_length": 0,
            "active_tasks": 0,
            "concurrency_limit": max(1, int(body.get("concurrency_limit") or 1)),
            "last_heartbeat": now,
            "registered_at": now,
        }
        with self.lock:
            old = self.workers.get(node_id)
            if old:
                record["registered_at"] = old.get("registered_at", now)
            self.workers[node_id] = record
        return {
            "ok": True,
            "node_id": node_id,
            "worker_id": node_id,
            "worker_token": secrets.token_urlsafe(16),
            "heartbeat_interval": 2,
            "version": VERSION,
        }

    def heartbeat(self, node_id: str, body: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            worker = self.workers.get(node_id)
            if worker is None:
                raise KeyError("worker not registered")
            worker["last_heartbeat"] = _now()
            worker["status"] = self._normalise_status(body.get("status"), worker.get("status", "ready"))
            for key in ("memory_used_mb", "cuda_ready", "cuda_device_count"):
                if key in body:
                    worker[key] = body[key]
            if "models" in body:
                worker["models"] = self._worker_models(body)
            if worker["status"] == "offline":
                worker["status"] = "ready"
        return {"ok": True, "node_id": node_id}

    def _eligible_workers_locked(self, model: str, min_memory_mb: int = 0) -> list[dict[str, Any]]:
        now = _now()
        candidates: list[dict[str, Any]] = []
        for worker in self.workers.values():
            if not self._is_live_locked(worker, now):
                continue
            if worker.get("status") not in {"ready", "idle"}:
                continue
            if int(worker.get("active_tasks", 0)) >= int(worker.get("concurrency_limit", 1)):
                continue
            models = {str(item) for item in worker.get("models", [])}
            if model and models and model not in models and "*" not in models:
                continue
            total = int(worker.get("memory_mb", 0) or 0)
            used = int(worker.get("memory_used_mb", 0) or 0)
            if min_memory_mb and total and total - used < min_memory_mb:
                continue
            candidates.append(worker)
        candidates.sort(key=lambda item: (int(item.get("queue_length", 0)), float(item.get("last_heartbeat", 0))))
        return candidates

    def _select_worker_locked(self, task: dict[str, Any]) -> str | None:
        candidates = self._eligible_workers_locked(str(task.get("model", "")), int(task.get("min_memory_mb", 0) or 0))
        preferred = task.get("preferred_gpu")
        if preferred is not None:
            candidates = [worker for worker in candidates if str(worker.get("gpu_index")) == str(preferred)]
        return str(candidates[0]["node_id"]) if candidates else None

    def submit_task(self, body: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        prompt = body.get("prompt")
        request_input = body.get("input")
        if prompt is None and isinstance(request_input, dict):
            prompt = request_input.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("input.prompt is required")
        model = str(body.get("model") or "demo")
        key = body.get("idempotency_key")
        max_retries = max(0, min(5, int(body.get("max_retries", DEFAULT_MAX_RETRIES))))
        deadline_ms = max(1, min(3_600_000, int(body.get("deadline_ms", DEFAULT_DEADLINE_MS))))
        now = _now()
        with self.lock:
            if key:
                key = str(key)
                existing_id = self.idempotency.get(key)
                if existing_id:
                    existing = self.tasks[existing_id]
                    if existing.get("prompt") != prompt or existing.get("model") != model:
                        raise ConflictError("idempotency_key already belongs to a different task")
                    return dict(existing), True
            task_id = "task_" + uuid.uuid4().hex[:16]
            task = {
                "task_id": task_id,
                "idempotency_key": key,
                "prompt": prompt,
                "input": request_input if isinstance(request_input, dict) else {"prompt": prompt},
                "model": model,
                "preferred_gpu": body.get("preferred_gpu"),
                "min_memory_mb": int(body.get("min_memory_mb", 0) or 0),
                "deadline_ms": deadline_ms,
                "deadline_at": now + deadline_ms / 1000.0,
                "max_retries": max_retries,
                "attempt": 0,
                "retries": 0,
                "status": "queued",
                "assigned_node_id": self._select_worker_locked({"model": model, "preferred_gpu": body.get("preferred_gpu"), "min_memory_mb": body.get("min_memory_mb", 0)}),
                "created_at": now,
                "queued_at": now,
            }
            self.tasks[task_id] = task
            if key:
                self.idempotency[key] = task_id
            if task["assigned_node_id"]:
                self.workers[task["assigned_node_id"]]["queue_length"] = int(self.workers[task["assigned_node_id"]].get("queue_length", 0)) + 1
            return dict(task), False

    def _finish_task_locked(self, task: dict[str, Any], status: str, error: Any = None) -> None:
        task["status"] = status
        task["finished_at"] = _now()
        if error is not None:
            task["error"] = error
        started = task.get("started_at")
        if started is not None:
            self.completed_durations_ms.append(max(0.0, (task["finished_at"] - float(started)) * 1000.0))

    def _release_worker_locked(self, worker_id: str) -> None:
        worker = self.workers.get(worker_id)
        if not worker:
            return
        worker["queue_length"] = max(0, int(worker.get("queue_length", 0)) - 1)
        worker["active_tasks"] = max(0, int(worker.get("active_tasks", 0)) - 1)
        if worker.get("status") not in {"offline", "draining"}:
            worker["status"] = "ready"

    def claim_task(self, node_id: str) -> dict[str, Any] | None:
        with self.lock:
            self.reconcile_locked()
            worker = self.workers.get(node_id)
            if worker is None:
                raise KeyError("worker not registered")
            if not self._is_live_locked(worker) or worker.get("status") not in {"ready", "idle"}:
                return None
            for task in sorted(self.tasks.values(), key=lambda item: item.get("created_at", 0)):
                if task.get("status") != "queued":
                    continue
                if _now() >= float(task.get("deadline_at", 0)):
                    self._finish_task_locked(task, "timeout", {"code": "deadline_exceeded", "message": "task deadline exceeded"})
                    continue
                assigned = task.get("assigned_node_id")
                if assigned and assigned != node_id:
                    continue
                if not assigned:
                    assigned = self._select_worker_locked(task)
                    if assigned != node_id:
                        continue
                    task["assigned_node_id"] = node_id
                task.update({"status": "running", "worker_id": node_id, "started_at": _now(), "attempt": int(task.get("attempt", 0)) + 1})
                worker["active_tasks"] = int(worker.get("active_tasks", 0)) + 1
                worker["status"] = "busy"
                return dict(task)
        return None

    def complete_task(self, task_id: str, node_id: str, body: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            task = self.tasks.get(task_id)
            if task is None:
                raise KeyError("task not found")
            if task.get("status") != "running" or task.get("worker_id") != node_id:
                raise ConflictError("task assignment is no longer active")
            if body.get("attempt") is not None and int(body["attempt"]) != int(task.get("attempt", 0)):
                raise ConflictError("stale task attempt")
            self._release_worker_locked(node_id)
            ok = bool(body.get("ok", True))
            if ok:
                task["result"] = body.get("result")
                self._finish_task_locked(task, "succeeded")
            else:
                error = body.get("error") or {"code": "worker_error", "message": "worker execution failed"}
                retryable = bool(body.get("retryable", True))
                if retryable and int(task.get("retries", 0)) < int(task.get("max_retries", DEFAULT_MAX_RETRIES)) and _now() < float(task.get("deadline_at", 0)):
                    task.update({"status": "queued", "assigned_node_id": None, "worker_id": None, "preferred_gpu": None, "queued_at": _now(), "retries": int(task.get("retries", 0)) + 1, "error": error})
                else:
                    self._finish_task_locked(task, "failed", error)
            return dict(task)

    def cancel_task(self, task_id: str) -> dict[str, Any]:
        with self.lock:
            task = self.tasks.get(task_id)
            if task is None:
                raise KeyError("task not found")
            if task.get("status") == "queued":
                if task.get("assigned_node_id"):
                    worker = self.workers.get(str(task["assigned_node_id"]))
                    if worker:
                        worker["queue_length"] = max(0, int(worker.get("queue_length", 0)) - 1)
                task["assigned_node_id"] = None
                self._finish_task_locked(task, "cancelled", {"code": "cancelled", "message": "task cancelled"})
                return dict(task)
            if task.get("status") in {"succeeded", "failed", "timeout", "cancelled"}:
                return dict(task)
            raise ConflictError("only queued tasks can be cancelled")

    def reconcile_locked(self) -> None:
        now = _now()
        offline_nodes: set[str] = set()
        for node_id, worker in self.workers.items():
            if worker.get("status") != "offline" and not self._is_live_locked(worker, now):
                worker["status"] = "offline"
                worker["queue_length"] = 0
                worker["active_tasks"] = 0
                offline_nodes.add(node_id)
        for task in self.tasks.values():
            if task.get("status") == "running" and task.get("worker_id") in offline_nodes:
                if int(task.get("retries", 0)) < int(task.get("max_retries", DEFAULT_MAX_RETRIES)) and now < float(task.get("deadline_at", 0)):
                    task.update({"status": "queued", "assigned_node_id": None, "worker_id": None, "preferred_gpu": None, "queued_at": now, "retries": int(task.get("retries", 0)) + 1, "error": {"code": "worker_offline", "message": "worker heartbeat timed out"}})
                else:
                    self._finish_task_locked(task, "failed", {"code": "worker_offline", "message": "worker heartbeat timed out"})
            elif task.get("status") == "queued" and now >= float(task.get("deadline_at", 0)):
                if task.get("assigned_node_id"):
                    worker = self.workers.get(str(task["assigned_node_id"]))
                    if worker:
                        worker["queue_length"] = max(0, int(worker.get("queue_length", 0)) - 1)
                self._finish_task_locked(task, "timeout", {"code": "deadline_exceeded", "message": "task deadline exceeded"})
            elif task.get("status") == "running" and now >= float(task.get("deadline_at", 0)):
                self._release_worker_locked(str(task.get("worker_id")))
                self._finish_task_locked(task, "timeout", {"code": "deadline_exceeded", "message": "task deadline exceeded"})

    def reconcile(self) -> None:
        with self.lock:
            self.reconcile_locked()

    def nodes(self, model: str | None = None) -> list[dict[str, Any]]:
        self.reconcile()
        with self.lock:
            result = [dict(worker) for worker in self.workers.values()]
        if model:
            result = [worker for worker in result if model in worker.get("models", []) or "*" in worker.get("models", [])]
        return result

    def task_list(self, status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        """Return recent tasks for operators and the dashboard.

        Task detail remains available through ``/v1/tasks/{id}``; this endpoint
        deliberately returns a bounded, newest-first view so a dashboard can
        render live activity without knowing task ids in advance.
        """
        self.reconcile()
        limit = max(1, min(200, int(limit or 50)))
        with self.lock:
            tasks = [dict(task) for task in self.tasks.values()]
        if status:
            tasks = [task for task in tasks if str(task.get("status")) == status]
        tasks.sort(key=lambda task: float(task.get("created_at", 0)), reverse=True)
        return tasks[:limit]

    def metrics(self) -> dict[str, Any]:
        self.reconcile()
        with self.lock:
            statuses = Counter(str(task.get("status")) for task in self.tasks.values())
            durations = sorted(self.completed_durations_ms)

            def percentile(percent: float) -> float:
                if not durations:
                    return 0.0
                index = min(len(durations) - 1, max(0, int(round((percent / 100.0) * (len(durations) - 1)))))
                return round(durations[index], 2)

            terminal = sum(statuses[key] for key in ("succeeded", "failed", "timeout", "cancelled"))
            succeeded = statuses["succeeded"]
            return {
                "version": VERSION,
                "requests_total": self.requests_total,
                "tasks_total": len(self.tasks),
                "tasks_queued": statuses["queued"],
                "tasks_running": statuses["running"],
                "tasks_succeeded": succeeded,
                "tasks_failed": statuses["failed"],
                "tasks_timeout": statuses["timeout"],
                "tasks_cancelled": statuses["cancelled"],
                "success_rate": round(succeeded / terminal, 4) if terminal else 0.0,
                "task_latency_ms_p50": percentile(50),
                "task_latency_ms_p95": percentile(95),
                "queue_length": statuses["queued"],
                "online_nodes": sum(1 for worker in self.workers.values() if self._is_live_locked(worker) and worker.get("status") != "offline"),
                "node_count": len(self.workers),
            }


class Handler(BaseHTTPRequestHandler):
    server_version = f"BabelMeshCoordinator/{VERSION}"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(15)

    @property
    def state(self) -> CoordinatorState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("BABELMESH_QUIET") != "1":
            super().log_message(fmt, *args)

    def _json(self, value: Any, status: int = 200) -> None:
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _error(self, message: str, status: int = 400, code: str = "bad_request") -> None:
        self._json({"error": {"code": code, "message": message}}, status)

    def _body(self) -> dict[str, Any] | None:
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > 4 * 1024 * 1024:
                return {}
            value = json.loads(self.rfile.read(size).decode("utf-8"))
            return value if isinstance(value, dict) else None
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            return None

    def do_GET(self) -> None:  # noqa: N802
        self.state.record_request()
        parsed = urlparse(self.path)
        path = parsed.path
        if path in {"/", "/dashboard.html"}:
            self._dashboard()
        elif path in {"/healthz", "/health"}:
            metrics = self.state.metrics()
            self._json({"status": "ok", "ok": True, "service": "coordinator", "version": VERSION, "time": _now(), "online_nodes": metrics["online_nodes"]})
        elif path in {"/v1/nodes", "/workers"}:
            model = parse_qs(parsed.query).get("model", [None])[0]
            nodes = self.state.nodes(model)
            if path == "/workers":
                nodes = [node for node in nodes if node.get("status") != "offline"]
            self._json({"nodes": nodes, "workers": nodes})
        elif path in {"/v1/tasks", "/tasks"}:
            query = parse_qs(parsed.query)
            status = query.get("status", [None])[0]
            limit = query.get("limit", ["50"])[0]
            try:
                tasks = self.state.task_list(status=status, limit=int(limit))
            except (TypeError, ValueError):
                self._error("limit must be an integer", 400)
                return
            self._json({"tasks": tasks, "count": len(tasks)})
        elif path == "/metrics":
            if parse_qs(parsed.query).get("format", [""])[0] == "prometheus" or "text/plain" in self.headers.get("Accept", ""):
                self._prometheus()
            else:
                self._json(self.state.metrics())
        elif path.startswith("/v1/tasks/") or path.startswith("/tasks/"):
            task_id = path.split("/")[-1]
            # Reconcile before reading a task so deadline transitions are
            # deterministic for clients polling immediately after expiry.
            self.state.reconcile()
            with self.state.lock:
                task = self.state.tasks.get(task_id)
            if task is None:
                self._error("task not found", 404, "not_found")
            else:
                self._json(dict(task))
        else:
            self._error("not found", 404, "not_found")

    def _prometheus(self) -> None:
        metrics = self.state.metrics()
        lines = [f"babelmesh_{key} {value}" for key, value in metrics.items() if isinstance(value, (int, float))]
        data = ("\n".join(lines) + "\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _dashboard(self) -> None:
        path = Path(__file__).with_name("dashboard.html")
        try:
            data = path.read_bytes()
        except OSError:
            self._error("dashboard unavailable", 500, "dashboard_unavailable")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        self.state.record_request()
        body = self._body()
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path in {"/v1/nodes/register", "/register"}:
                self._json(self.state.register_worker(body or {}))
                return
            if path in {"/v1/tasks", "/submit"}:
                task, replay = self.state.submit_task(body or {})
                self._json({**task, "idempotent_replay": replay}, 200 if replay else 202)
                return
            if path in {"/v1/tasks/claim", "/claim"}:
                node_id = str((body or {}).get("node_id") or (body or {}).get("worker_id") or "")
                task = self.state.claim_task(node_id)
                self._json({"task": task})
                return
            if path in {"/v1/tasks/result", "/result"}:
                task_id = str((body or {}).get("task_id") or "")
                node_id = str((body or {}).get("node_id") or (body or {}).get("worker_id") or "")
                self._json(self.state.complete_task(task_id, node_id, body or {}))
                return
            parts = [part for part in path.split("/") if part]
            if len(parts) == 4 and parts[:2] == ["v1", "nodes"] and parts[3] == "heartbeat":
                self._json(self.state.heartbeat(parts[2], body or {}))
                return
            if path == "/heartbeat":
                node_id = str((body or {}).get("node_id") or (body or {}).get("worker_id") or "")
                self._json(self.state.heartbeat(node_id, body or {}))
                return
            if len(parts) == 4 and parts[:2] == ["v1", "tasks"] and parts[3] == "cancel":
                self._json(self.state.cancel_task(parts[2]))
                return
            if len(parts) == 4 and parts[:2] == ["v1", "tasks"] and parts[3] == "result":
                node_id = str((body or {}).get("node_id") or (body or {}).get("worker_id") or "")
                self._json(self.state.complete_task(parts[2], node_id, body or {}))
                return
            self._error("not found", 404, "not_found")
        except ValueError as exc:
            self._error(str(exc), 400)
        except KeyError as exc:
            self._error(str(exc).strip("'"), 404, "not_found")
        except ConflictError as exc:
            self._error(str(exc), 409, "conflict")
        except (TypeError, OverflowError) as exc:
            self._error(str(exc), 400)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, host: str, port: int):
        super().__init__((host, port), Handler)
        self.state = CoordinatorState()

    def server_close(self) -> None:
        self.state.close()
        super().server_close()


def run(host: str = "0.0.0.0", port: int = DEFAULT_PORT) -> None:
    server = Server(host, port)
    print(f"BabelMesh coordinator listening on http://{host}:{port} (v{VERSION})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run(host=os.environ.get("BABELMESH_COORDINATOR_HOST", "0.0.0.0"), port=int(os.environ.get("BABELMESH_COORDINATOR_PORT", str(DEFAULT_PORT))))
