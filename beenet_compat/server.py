"""Small, dependency-free BeeNet protocol compatibility server.

This is a clean-room protocol implementation based on the static contract in
``beenet-api-contract.md``. It does not execute or embed the original client.
The model backend is intentionally deterministic; set ``BEENET_REPLY_PREFIX``
or replace ``ChatBackend.reply`` when connecting a real inference service.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterable


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


@dataclass
class State:
    port: int
    localapi_on: bool = False
    local_token: str = ""
    accounts: dict[str, dict[str, str]] = field(default_factory=dict)
    lock: threading.RLock = field(default_factory=threading.RLock)

    def local_base(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def rotate_token(self) -> str:
        # The client uses a separate bn-local credential.  The exact random
        # format is not a public contract, so use a URL-safe 32-byte value.
        self.local_token = "bn-local-" + secrets.token_urlsafe(24)
        return self.local_token


class ChatBackend:
    """Deterministic backend used by the compatibility layer."""

    def reply(self, model: str, messages: list[dict[str, Any]], body: dict[str, Any]) -> str:
        text = ""
        for message in reversed(messages):
            if message.get("role") == "user":
                value = message.get("content", "")
                text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                break
        prefix = os.environ.get("BEENET_REPLY_PREFIX", "BeeNet compatibility response: ")
        return prefix + text


class BeeNetHandler(BaseHTTPRequestHandler):
    server_version = "BeeNetCompat/0.1"
    protocol_version = "HTTP/1.1"

    @property
    def state(self) -> State:
        return self.server.state  # type: ignore[attr-defined]

    @property
    def backend(self) -> ChatBackend:
        return self.server.backend  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        if os.environ.get("BEENET_QUIET") != "1":
            super().log_message(format, *args)

    def _send_json(self, value: Any, status: int = 200, headers: dict[str, str] | None = None) -> None:
        payload = _json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        for key, item in (headers or {}).items():
            self.send_header(key, item)
        self.end_headers()
        self.wfile.write(payload)

    def _send_error(self, status: int, message: str) -> None:
        self._send_json({"error": message}, status)

    def _read_json(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 8 * 1024 * 1024:
                return None
            value = json.loads(self.rfile.read(length).decode("utf-8"))
            return value if isinstance(value, dict) else None
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _fabric_ok(self) -> bool:
        return self.headers.get("X-Fabric") == "1"

    def _local_auth_ok(self) -> bool:
        authorization = self.headers.get("Authorization", "")
        token = authorization.removeprefix("Bearer ").strip()
        with self.state.lock:
            return self.state.localapi_on and bool(token) and secrets.compare_digest(token, self.state.local_token)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/localapi":
            with self.state.lock:
                result: dict[str, Any] = {"on": self.state.localapi_on}
                if self.state.localapi_on:
                    result.update(base=self.state.local_base(), token=self.state.local_token)
            self._send_json(result)
            return
        if self.path == "/v1/models":
            if not self._local_auth_ok():
                self._send_error(401, "invalid local API token")
                return
            self._send_json({"object": "list", "data": [{"id": "auto", "object": "model", "owned_by": "beenet"}]})
            return
        if self.path == "/v1/account":
            if not self._local_auth_ok():
                self._send_error(401, "invalid local API token")
                return
            self._send_json({"account": "local", "authenticated": True})
            return
        self._send_error(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/localapi":
            self._post_localapi()
            return
        if self.path == "/api/signup":
            self._post_signup()
            return
        if self.path == "/api/chat":
            self._post_chat()
            return
        if self.path == "/v1/chat/completions":
            self._post_openai_chat()
            return
        if self.path == "/v1/messages":
            self._post_anthropic_messages()
            return
        self._send_error(404, "not found")

    def _require_fabric(self) -> bool:
        if self._fabric_ok():
            return True
        self._send_error(400, "missing X-Fabric header")
        return False

    def _post_localapi(self) -> None:
        if not self._require_fabric():
            return
        body = self._read_json()
        if body is None or not isinstance(body.get("on"), bool):
            self._send_error(400, "on must be a boolean")
            return
        with self.state.lock:
            self.state.localapi_on = body["on"]
            if self.state.localapi_on and (body.get("renew") or not self.state.local_token):
                self.state.rotate_token()
            result: dict[str, Any] = {"on": self.state.localapi_on}
            if self.state.localapi_on:
                result.update(base=self.state.local_base(), token=self.state.local_token)
        self._send_json(result)

    def _post_signup(self) -> None:
        if not self._require_fabric():
            return
        body = self._read_json()
        invite = body.get("invite_code") if body else None
        account = body.get("account") if body else None
        if not isinstance(invite, str) or not invite.strip() or not isinstance(account, str) or not account.strip():
            self._send_error(400, "invite_code and account are required")
            return
        account = account.strip()
        with self.state.lock:
            if account in self.state.accounts:
                self._send_error(409, "account already exists")
                return
            recovery = secrets.token_urlsafe(18)
            self.state.accounts[account] = {"invite_code": invite, "recovery_code": recovery}
        self._send_json({"account": account, "recovery_code": recovery}, 200)

    def _parse_chat(self, body: dict[str, Any] | None) -> tuple[str, list[dict[str, Any]], bool] | None:
        if body is None:
            return None
        model = body.get("model")
        if not isinstance(model, str) or not model.strip():
            return None
        messages = body.get("messages")
        if not isinstance(messages, list) or any(not isinstance(item, dict) for item in messages):
            return None
        stream = body.get("stream", True)
        if not isinstance(stream, bool):
            return None
        return model, messages, stream

    def _post_chat(self) -> None:
        body = self._read_json()
        parsed = self._parse_chat(body)
        if parsed is None:
            self._send_error(400, "model and messages are required")
            return
        model, messages, stream = parsed
        reply = self.backend.reply(model, messages, body or {})
        created = _now_iso()
        if stream:
            chunks = [reply[i : i + 32] for i in range(0, len(reply), 32)] or [""]
            self._send_ndjson(
                [
                    {"model": model, "created_at": created, "message": {"role": "assistant", "content": part}, "done": False}
                    for part in chunks
                ]
                + [{"model": model, "created_at": created, "done": True, "done_reason": "stop", "total_duration": 0, "eval_count": 0}]
            )
            return
        self._send_json({"model": model, "created_at": created, "message": {"role": "assistant", "content": reply}, "done": True, "done_reason": "stop", "total_duration": 0, "eval_count": len(reply)})

    def _send_ndjson(self, values: Iterable[dict[str, Any]]) -> None:
        payload = b"".join(_json_bytes(value) + b"\n" for value in values)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _post_openai_chat(self) -> None:
        if not self._local_auth_ok():
            self._send_error(401, "invalid local API token")
            return
        body = self._read_json()
        if body is None or not isinstance(body.get("model"), str) or not isinstance(body.get("messages"), list):
            self._send_error(400, "model and messages are required")
            return
        model = body["model"]
        reply = self.backend.reply(model, body["messages"], body)
        response_id = "chatcmpl-" + uuid.uuid4().hex
        self._send_json({"id": response_id, "object": "chat.completion", "created": int(time.time()), "model": model, "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 0, "completion_tokens": len(reply), "total_tokens": len(reply)}})

    def _post_anthropic_messages(self) -> None:
        if not self._local_auth_ok():
            self._send_error(401, "invalid local API token")
            return
        body = self._read_json()
        if body is None or not isinstance(body.get("messages"), list):
            self._send_error(400, "messages are required")
            return
        model = body.get("model", "auto")
        reply = self.backend.reply(str(model), body["messages"], body)
        self._send_json({"id": "msg_" + uuid.uuid4().hex, "type": "message", "role": "assistant", "model": model, "content": [{"type": "text", "text": reply}], "stop_reason": "end_turn", "usage": {"input_tokens": 0, "output_tokens": len(reply)}})


class BeeNetServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], state: State, backend: ChatBackend | None = None):
        super().__init__(address, BeeNetHandler)
        self.state = state
        self.backend = backend or ChatBackend()


def run(host: str = "127.0.0.1", port: int = 18650) -> None:
    state = State(port=port)
    server = BeeNetServer((host, port), state)
    print(f"BeeNet compatibility server listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run(port=int(os.environ.get("BEENET_PORT", "18650")))
