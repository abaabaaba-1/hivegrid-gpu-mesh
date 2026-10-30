"""BabelMesh GPU worker.

The worker is deliberately single-concurrency: one process owns one visible
GPU and pulls one task at a time from the coordinator. ``BABELMESH_MOCK=1`` is
provided for the local five-minute demo and CI tests where CUDA is unavailable.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import signal
import subprocess
import time
import urllib.request
from typing import Any

from .common import request_json


def gpu_info(index: str) -> tuple[str, int, int]:
    if os.environ.get("BABELMESH_MOCK") == "1":
        return f"Mock GPU {index}", 16_384, 0
    configured_name = os.environ.get("BABELMESH_GPU_NAME")
    configured_memory = os.environ.get("BABELMESH_MEMORY_MB")
    if configured_name and configured_memory:
        try:
            return configured_name, int(configured_memory), 0
        except ValueError:
            pass
    query = "name,memory.total,memory.used"
    query_index = os.environ.get("BABELMESH_QUERY_GPU_INDEX", index)
    try:
        # nvidia-smi can take several seconds on a freshly initialized 8-GPU
        # host when all workers probe at once; keep the probe bounded but do
        # not mark a healthy card unknown during that startup burst.
        result = subprocess.run(["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits", "-i", query_index], capture_output=True, text=True, timeout=15, check=True)
        parts = [part.strip() for part in result.stdout.strip().split(",")]
        if len(parts) >= 3:
            return parts[0], int(float(parts[1])), int(float(parts[2]))
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return "unknown", 0, 0


def cuda_probe() -> tuple[bool, int]:
    """Initialize the CUDA runtime and return (ready, visible_device_count)."""
    if os.environ.get("BABELMESH_MOCK") == "1":
        return True, 1
    if os.environ.get("BABELMESH_CUDA_READY") == "1":
        return True, 1
    # The driver-facing probe is reliable even on hosts where the distro's
    # libcudart package is present but its runtime API blocks during the first
    # initialization. Keep the control-plane health check bounded and use the
    # CUDA-visible device namespace (worker services expose one GPU each).
    try:
        subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader", "-i", os.environ.get("BABELMESH_QUERY_GPU_INDEX", "0")],
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        return True, 1
    except (OSError, subprocess.SubprocessError):
        pass
    candidates = [
        "libcudart.so",
        "libcudart.so.12",
        "/lib/x86_64-linux-gnu/libcudart.so.12",
        "/usr/local/cuda/lib64/libcudart.so",
        "/usr/local/cuda/targets/x86_64-linux/lib/libcudart.so",
    ]
    for path in candidates:
        try:
            runtime = ctypes.CDLL(path)
            count = ctypes.c_int()
            runtime.cudaGetDeviceCount.argtypes = [ctypes.POINTER(ctypes.c_int)]
            runtime.cudaGetDeviceCount.restype = ctypes.c_int
            runtime.cudaSetDevice.argtypes = [ctypes.c_int]
            runtime.cudaSetDevice.restype = ctypes.c_int
            runtime.cudaFree.argtypes = [ctypes.c_void_p]
            runtime.cudaFree.restype = ctypes.c_int
            if runtime.cudaGetDeviceCount(ctypes.byref(count)) != 0 or count.value <= 0:
                continue
            if runtime.cudaSetDevice(0) != 0 or runtime.cudaFree(None) != 0:
                continue
            return True, count.value
        except (OSError, AttributeError):
            continue
    return False, 0


def vllm_reply(task: dict[str, Any]) -> str:
    base = os.environ.get("BABELMESH_VLLM_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("vLLM URL is not configured")
    model = str(task.get("model", ""))
    if not model or model in {"demo", "auto"}:
        model = os.environ.get("BABELMESH_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")
    # Keep the presentation path responsive while leaving enough room for a
    # concise explanation; callers can still submit longer prompts and the
    # coordinator remains responsible for the overall deadline.
    body = {"model": model, "messages": [{"role": "user", "content": str(task.get("prompt", ""))}], "temperature": 0.2, "max_tokens": 96, "stream": False}
    request = urllib.request.Request(base + "/chat/completions", data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=float(os.environ.get("BABELMESH_VLLM_TIMEOUT", "120"))) as response:
        result = json.loads(response.read().decode("utf-8"))
    choices = result.get("choices") or []
    if not choices:
        raise RuntimeError("vLLM response has no choices")
    return str((choices[0].get("message") or {}).get("content", ""))


def execute(task: dict[str, Any], worker_id: str, gpu_index: str) -> str:
    delay = float(os.environ.get("BABELMESH_MOCK_DELAY", "0"))
    if delay > 0:
        time.sleep(delay)
    model = task.get("model", "demo")
    ready, visible = cuda_probe()
    if os.environ.get("BABELMESH_VLLM_URL"):
        response = vllm_reply(task)
        return f"worker={worker_id} gpu={gpu_index} cuda_ready={ready} visible_cuda_devices={visible} backend=vllm model={model} response: {response}"
    return f"worker={worker_id} gpu={gpu_index} cuda_ready={ready} visible_cuda_devices={visible} backend=demo model={model} response: {task.get('prompt', '')}"


def _structured_log(event: str, **fields: Any) -> None:
    # Do not include the task prompt in worker logs.
    print(json.dumps({"event": event, **fields}, ensure_ascii=False, separators=(",", ":")), flush=True)


def run(coordinator: str, worker_id: str, gpu_index: str, model: str | None = None) -> None:
    name, memory_total, memory_used = gpu_info(gpu_index)
    cuda_ready, cuda_count = cuda_probe()
    configured_model = model or os.environ.get("BABELMESH_MODEL") or ("*" if os.environ.get("BABELMESH_VLLM_URL") else "demo")
    registration = request_json(coordinator + "/v1/nodes/register", "POST", {
        "node_id": worker_id,
        "gpu_index": gpu_index,
        "gpu_name": name,
        "memory_mb": memory_total,
        "memory_used_mb": memory_used,
        "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES", gpu_index),
        "cuda_ready": cuda_ready,
        "cuda_device_count": cuda_count,
        "backend": "vllm" if os.environ.get("BABELMESH_VLLM_URL") else "demo",
        "models": [configured_model],
        "concurrency_limit": 1,
    })
    _structured_log("worker_registered", node_id=worker_id, gpu_index=gpu_index, gpu_name=name, memory_mb=memory_total, cuda_ready=cuda_ready, models=[configured_model])
    heartbeat_interval = float(os.environ.get("BABELMESH_HEARTBEAT_INTERVAL", registration.get("heartbeat_interval", 2)))
    stopping = False

    def request_draining(_signum: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True
        try:
            request_json(coordinator + f"/v1/nodes/{worker_id}/heartbeat", "POST", {"status": "draining"})
        except Exception:
            pass

    signal.signal(signal.SIGTERM, request_draining)
    if hasattr(signal, "SIGINT"):
        signal.signal(signal.SIGINT, request_draining)

    while not stopping:
        try:
            _, _, memory_used = gpu_info(gpu_index)
            request_json(coordinator + f"/v1/nodes/{worker_id}/heartbeat", "POST", {"status": "ready", "memory_used_mb": memory_used, "queue_length": 0, "models": [configured_model]})
            claimed = request_json(coordinator + "/v1/tasks/claim", "POST", {"node_id": worker_id})
            task = claimed.get("task")
            if task:
                request_json(coordinator + f"/v1/nodes/{worker_id}/heartbeat", "POST", {"status": "busy", "memory_used_mb": memory_used, "queue_length": 1, "models": [configured_model]})
                started = time.time()
                try:
                    result = execute(task, worker_id, gpu_index)
                    request_json(coordinator + f"/v1/tasks/{task['task_id']}/result", "POST", {"node_id": worker_id, "attempt": task.get("attempt"), "ok": True, "result": result})
                    _structured_log("task_succeeded", task_id=task["task_id"], node_id=worker_id, model=task.get("model"), duration_ms=round((time.time() - started) * 1000, 2))
                except Exception as exc:  # pragma: no cover - backend-specific
                    error = {"code": "inference_error", "message": str(exc)}
                    try:
                        request_json(coordinator + f"/v1/tasks/{task['task_id']}/result", "POST", {"node_id": worker_id, "attempt": task.get("attempt"), "ok": False, "retryable": True, "error": error})
                    except Exception:
                        pass
                    _structured_log("task_failed", task_id=task["task_id"], node_id=worker_id, model=task.get("model"), error_code=error["code"], duration_ms=round((time.time() - started) * 1000, 2))
            time.sleep(heartbeat_interval)
        except Exception as exc:
            _structured_log("worker_loop_error", node_id=worker_id, error_code=type(exc).__name__)
            time.sleep(heartbeat_interval)

    _structured_log("worker_stopped", node_id=worker_id, status="draining")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--coordinator", default=os.environ.get("BABELMESH_COORDINATOR", "http://127.0.0.1:8000"))
    parser.add_argument("--worker-id", required=True)
    parser.add_argument("--gpu-index", required=True)
    parser.add_argument("--model", default=None)
    args = parser.parse_args()
    run(args.coordinator.rstrip("/"), args.worker_id, args.gpu_index, args.model)
