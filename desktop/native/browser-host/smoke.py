#!/usr/bin/env python3
"""Fixture-only real host smoke: no Chrome install, no user manifest mutation."""

import json
import ctypes
import os
import pathlib
import socket
import struct
import subprocess
import sys
import tempfile
import threading

HOST = pathlib.Path(sys.argv[1]).resolve()
ORIGIN = "chrome-extension://" + "a" * 32 + "/"


def current_executable():
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    buffer = ctypes.create_string_buffer(4096)
    count = libproc.proc_pidpath(os.getpid(), buffer, len(buffer))
    assert count > 0
    return buffer.value.decode()


MAIN_EXE = current_executable()


def frame(message):
    body = json.dumps(message, separators=(",", ":")).encode()
    return struct.pack("=I", len(body)) + body


def read_exact(connection, length):
    data = b""
    while len(data) < length:
        part = connection.recv(length - len(data))
        if not part:
            raise AssertionError("premature socket EOF")
        data += part
    return data


def make_server():
    directory = tempfile.mkdtemp(prefix="eanm-", dir="/tmp")
    os.chmod(directory, 0o700)
    path = os.path.join(directory, "main.sock")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    os.chmod(path, 0o600)
    server.listen(1)
    return directory, path, server


def invoke(path, data, main_exe=None, origin=ORIGIN):
    args = [str(HOST), "--fixture-socket", path, "--fixture-main-exe", main_exe or MAIN_EXE, origin]
    return subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE).communicate(data, timeout=5)


def round_trip():
    directory, path, server = make_server()
    request = frame({"type": "request", "id": 1, "method": "tabs.discover", "params": {}, "deadlineMs": 1000})
    response = frame({"type": "response", "id": 1, "ok": True, "result": {"tabs": []}})
    received = []

    def serve():
        connection, _ = server.accept()
        with connection:
            header = read_exact(connection, 4)
            body = read_exact(connection, struct.unpack("=I", header)[0])
            received.append(header + body)
            connection.sendall(response)

    thread = threading.Thread(target=serve)
    thread.start()
    try:
        out, err = invoke(path, request)
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert received == [request], "host altered browser frame"
        assert out == response, "host altered main frame"
        assert not err, err
    finally:
        server.close()
        os.unlink(path)
        os.rmdir(directory)


def peer_rejection():
    directory, path, server = make_server()

    def serve():
        connection, _ = server.accept()
        connection.close()

    thread = threading.Thread(target=serve)
    thread.start()
    try:
        out, err = invoke(path, b"", "/usr/bin/false")
        thread.join(timeout=5)
        assert b"PEER_IDENTITY_REJECTED" in out
        assert b"PEER_IDENTITY_REJECTED" in err
    finally:
        server.close()
        os.unlink(path)
        os.rmdir(directory)


def missing_main():
    directory = tempfile.mkdtemp(prefix="eanm-", dir="/tmp")
    os.chmod(directory, 0o700)
    try:
        out, err = invoke(os.path.join(directory, "missing.sock"), b"")
        assert b"EMPEROR_NOT_RUNNING" in out
        assert b"EMPEROR_NOT_RUNNING" in err
    finally:
        os.rmdir(directory)


def invalid_origin():
    directory = tempfile.mkdtemp(prefix="eanm-", dir="/tmp")
    os.chmod(directory, 0o700)
    try:
        out, err = invoke(os.path.join(directory, "missing.sock"), b"", origin="chrome-extension://*/")
        assert out == b""
        assert b"EXTENSION_ORIGIN_REJECTED" in err
    finally:
        os.rmdir(directory)


def oversized_browser_frame():
    directory, path, server = make_server()

    def serve():
        connection, _ = server.accept()
        with connection:
            assert connection.recv(1) == b"", "oversized browser frame was forwarded"

    thread = threading.Thread(target=serve)
    thread.start()
    try:
        out, err = invoke(path, struct.pack("=I", 64 * 1024 * 1024 + 1))
        thread.join(timeout=5)
        assert out == b""
        assert b"FRAME_TOO_LARGE" in err
    finally:
        server.close()
        os.unlink(path)
        os.rmdir(directory)


def oversized_main_frame():
    directory, path, server = make_server()

    def serve():
        connection, _ = server.accept()
        with connection:
            connection.sendall(struct.pack("=I", 1024 * 1024 + 1))

    thread = threading.Thread(target=serve)
    thread.start()
    try:
        out, err = invoke(path, b"")
        thread.join(timeout=5)
        assert out == b""
        assert b"FRAME_TOO_LARGE" in err
    finally:
        server.close()
        os.unlink(path)
        os.rmdir(directory)


round_trip()
peer_rejection()
missing_main()
invalid_origin()
oversized_browser_frame()
oversized_main_frame()
print("native host fixture: 6/6 passed")
