from __future__ import annotations

import json
import time
import urllib.request
from typing import Any


def request_json(url: str, method: str = "GET", body: dict[str, Any] | None = None, timeout: float = 10) -> dict[str, Any]:
    payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=payload, method=method)
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def now_ms() -> int:
    return int(time.time() * 1000)
