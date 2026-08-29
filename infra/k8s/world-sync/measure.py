#!/usr/bin/env python3
"""M1: measure frozen delta extraction plus candidate cold boot.

Run this in a short-lived pod with candidate PVC B mounted at DEST_WORLD. The
script refuses to publish a measurement unless the source world crosses the
configured realistic-size floor, players are already drained, RCON succeeds,
and Paper B reaches its real readiness endpoint.
"""

import argparse
import json
import os
from pathlib import Path
import socket
import struct
import sys
import tarfile
import time
import urllib.parse
import urllib.request


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def tree_size(root: Path) -> int:
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


def transfer(source: str, destination: Path, *, delta: bool) -> int:
    parsed = urllib.parse.urlparse(source)
    if parsed.scheme != "http" or not parsed.hostname or parsed.path != "/stream":
        raise RuntimeError("SOURCE_SYNC_URL must be an internal HTTP /stream endpoint")
    query = "?delta=1" if delta else ""
    request = urllib.request.Request(source + query, data=b"", method="POST")
    started = time.monotonic_ns()
    destination.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(request, timeout=900) as response:
        if response.status == 204:
            return int((time.monotonic_ns() - started) / 1_000_000)
        if response.headers.get_content_type() != "application/x-tar":
            raise RuntimeError("world-sync sender did not return application/x-tar")
        with tarfile.open(fileobj=response, mode="r|") as archive:
            archive.extractall(path=destination, filter="data")
    return int((time.monotonic_ns() - started) / 1_000_000)


def receive_exact(connection: socket.socket, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = connection.recv(remaining)
        if not chunk:
            raise RuntimeError("RCON connection closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class Rcon:
    def __init__(self, host: str, port: int, password: str):
        self.connection = socket.create_connection((host, port), timeout=10)
        self.connection.settimeout(30)
        self.request_id = 1
        self._send_packet(3, password)
        response_id, _ = self._receive()
        if response_id == -1:
            self.close()
            raise RuntimeError("RCON authentication failed")

    def _send_packet(self, packet_type: int, body: str) -> None:
        payload = struct.pack("<ii", self.request_id, packet_type) + body.encode() + b"\x00\x00"
        self.connection.sendall(struct.pack("<i", len(payload)) + payload)

    def _receive(self) -> tuple[int, str]:
        size = struct.unpack("<i", receive_exact(self.connection, 4))[0]
        payload = receive_exact(self.connection, size)
        request_id, _packet_type = struct.unpack("<ii", payload[:8])
        return request_id, payload[8:-2].decode("utf-8", errors="replace")

    def command(self, body: str) -> str:
        self.request_id += 1
        self._send_packet(2, body)
        response_id, response = self._receive()
        if response_id != self.request_id:
            raise RuntimeError("RCON response id mismatch")
        return response

    def close(self) -> None:
        self.connection.close()


def post(url: str) -> None:
    request = urllib.request.Request(url, data=b"", method="POST")
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"candidate start returned HTTP {response.status}")


def wait_ready(url: str, timeout_seconds: int) -> int:
    started = time.monotonic_ns()
    deadline = time.monotonic() + timeout_seconds
    last_error = "not ready"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if 200 <= response.status < 300:
                    return int((time.monotonic_ns() - started) / 1_000_000)
                last_error = f"HTTP {response.status}"
        except Exception as error:  # readiness is expected to fail during boot
            last_error = str(error)
        time.sleep(0.25)
    raise TimeoutError(f"candidate never became ready: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", help="write the measured JSON record to this path")
    parser.add_argument("--ready-timeout-seconds", type=int, default=300)
    args = parser.parse_args()

    if os.environ.get("PLAYERS_DRAINED") != "true":
        raise RuntimeError("PLAYERS_DRAINED=true is required before the freeze starts")

    source = env("SOURCE_SYNC_URL")
    destination = Path(env("DEST_WORLD"))
    minimum_bytes = int(os.environ.get("MIN_REALISTIC_WORLD_BYTES", str(1024**3)))
    password = Path(env("RCON_PASSWORD_FILE")).read_text(encoding="utf-8").strip()
    rcon = Rcon(env("RCON_HOST"), int(os.environ.get("RCON_PORT", "25575")), password)

    presync_ms = transfer(source, destination, delta=False)
    world_bytes = tree_size(destination)
    if world_bytes < minimum_bytes:
        raise RuntimeError(
            f"world is too small for M1: {world_bytes} bytes; minimum is {minimum_bytes}"
        )

    delta_before = world_bytes
    freeze_started = time.monotonic_ns()
    try:
        rcon.command("save-off")
        rcon.command("save-all flush")
        delta_ms = transfer(source, destination, delta=True)
    finally:
        rcon.command("save-on")
        rcon.close()

    delta_bytes = max(0, tree_size(destination) - delta_before)
    post(env("CANDIDATE_START_URL"))
    cold_boot_ms = wait_ready(env("CANDIDATE_READY_URL"), args.ready_timeout_seconds)
    freeze_ms = int((time.monotonic_ns() - freeze_started) / 1_000_000)
    result = {
        "status": "measured",
        "protocol": "world-sync-http-tar-v1",
        "world_bytes": world_bytes,
        "delta_bytes_lower_bound": delta_bytes,
        "presync_ms": presync_ms,
        "delta_sync_ms": delta_ms,
        "cold_boot_ms": cold_boot_ms,
        "player_visible_freeze_ms": freeze_ms,
        "conditions": {
            "players_drained": True,
            "save_order": ["save-off", "save-all flush", "delta", "save-on"],
            "candidate_ready_url": urllib.parse.urlparse(env("CANDIDATE_READY_URL")).path,
        },
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    encoded = json.dumps(result, sort_keys=True)
    print(encoded)
    if args.output:
        Path(args.output).write_text(encoded + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "unmeasured", "error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
