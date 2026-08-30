#!/usr/bin/env python3
import os
import socket
import struct
import subprocess
import sys

RCON_HOST = os.environ["RCON_HOST"]
RCON_PORT = int(os.environ.get("RCON_PORT", "25575"))
RCON_PASSWORD_FILE = os.environ.get("RCON_PASSWORD_FILE", "/run/secrets/rcon/password")
SAVE_ON_ONLY = os.environ.get("SAVE_ON_ONLY") == "true"


def recv_exact(connection, length):
    chunks = []
    remaining = length
    while remaining:
        chunk = connection.recv(remaining)
        if not chunk:
            raise ConnectionError("RCON connection closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def packet(request_id, packet_type, body):
    payload = struct.pack("<ii", request_id, packet_type) + body.encode("utf-8") + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload


class Rcon:
    def __init__(self):
        with open(RCON_PASSWORD_FILE, "r", encoding="utf-8") as handle:
            password = handle.read().strip()
        self.connection = socket.create_connection((RCON_HOST, RCON_PORT), timeout=10)
        self.connection.settimeout(30)
        self.request_id = 1
        self.connection.sendall(packet(self.request_id, 3, password))
        response_id, _ = self.read()
        if response_id == -1:
            raise PermissionError("RCON authentication failed")

    def read(self):
        length = struct.unpack("<i", recv_exact(self.connection, 4))[0]
        payload = recv_exact(self.connection, length)
        request_id = struct.unpack("<i", payload[:4])[0]
        body = payload[8:-2].decode("utf-8", errors="replace")
        return request_id, body

    def command(self, command):
        self.request_id += 1
        self.connection.sendall(packet(self.request_id, 2, command))
        response_id, body = self.read()
        if response_id != self.request_id:
            raise RuntimeError("RCON response id mismatch")
        return body

    def close(self):
        self.connection.close()


client = Rcon()
try:
    if SAVE_ON_ONLY:
        client.command("save-on")
        sys.exit(0)
    client.command("save-off")
    client.command("save-all flush")
    subprocess.run(["python3", "/sync/receiver.py"], check=True)
finally:
    try:
        client.command("save-on")
    finally:
        client.close()
