#!/usr/bin/env python3
"""Small Linux Unix-socket proxy that enforces SO_PEERCRED before HTTP forwarding."""
import os
import grp
import pwd
import re
import signal
import socket
import stat
import threading
from pathlib import Path


def resolve_uid(value):
    try:
        return int(value)
    except ValueError:
        return pwd.getpwnam(value).pw_uid


def resolve_gid(value):
    try:
        return int(value)
    except ValueError:
        return grp.getgrnam(value).gr_gid

FRONT = os.environ['OMNIS_PEER_FRONT_SOCKET']
BACK = os.environ['OMNIS_PEER_BACK_SOCKET']
PEER_UID = resolve_uid(os.environ['OMNIS_PEER_UID'])
PEER_GID = resolve_gid(os.environ['OMNIS_PEER_GID'])
SOCKET_GID = resolve_gid(os.environ['OMNIS_PEER_SOCKET_GID'])
ROUTES = frozenset(os.environ['OMNIS_PEER_ALLOWED_PATHS'].split(','))
TOKEN_FILE = os.environ.get('OMNIS_PEER_INJECT_BROKER_TOKEN_FILE')
INJECT_TOKEN = Path(TOKEN_FILE).read_text(encoding='utf-8').strip() if TOKEN_FILE else None
MAX_REQUEST = 64 * 1024
MAX_RESPONSE = 128 * 1024
MAX_CONNECTIONS = 8

stop = threading.Event()
slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)


def prepare_front_socket():
    parent = Path(FRONT).parent
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise RuntimeError('front socket parent must be a real directory')
    if info.st_mode & 0o022:
        raise RuntimeError('front socket parent is group/world writable')
    if info.st_uid not in (0, os.geteuid()):
        raise RuntimeError('front socket parent has unexpected owner')
    try:
        existing = os.lstat(FRONT)
    except FileNotFoundError:
        existing = None
    if existing:
        if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.geteuid():
            raise RuntimeError('refusing to replace unowned or non-socket path')
        os.unlink(FRONT)
    listener.bind(FRONT)
    os.chown(FRONT, os.geteuid(), SOCKET_GID)
    os.chmod(FRONT, 0o660)
    listener.listen(32)
    listener.settimeout(0.5)


def reject(client):
    try:
        client.sendall(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    except OSError:
        pass


def read_request(client):
    client.settimeout(2.0)
    data = bytearray()
    while b'\r\n\r\n' not in data:
        chunk = client.recv(4096)
        if not chunk:
            raise ValueError('truncated headers')
        data.extend(chunk)
        if len(data) > 8192:
            raise ValueError('headers too large')
    split = data.index(b'\r\n\r\n') + 4
    headers = bytes(data[:split])
    match = re.fullmatch(rb'(GET|POST) ([^ ]+) HTTP/1\.[01]\r\n', headers.split(b'\r\n', 1)[0] + b'\r\n')
    if not match:
        raise ValueError('unsupported request line')
    header_lines = headers.split(b'\r\n')[1:-2]
    if any(not line or line[:1] in (b' ', b'\t') or b':' not in line for line in header_lines):
        raise ValueError('malformed or folded header')
    route = match.group(2).decode('ascii')
    if route not in ROUTES:
        raise PermissionError('route not allowlisted')
    lower = headers.lower()
    if b'transfer-encoding:' in lower or b'upgrade:' in lower or b'connection: upgrade' in lower:
        raise ValueError('unsupported transfer mode')
    lengths = re.findall(rb'(?im)^content-length:\s*(\d+)\s*\r$', headers)
    if len(lengths) > 1:
        raise ValueError('duplicate content length')
    length = int(lengths[0]) if lengths else 0
    if length > MAX_REQUEST:
        raise ValueError('request body too large')
    expected = split + length
    while len(data) < expected:
        chunk = client.recv(min(4096, expected - len(data)))
        if not chunk:
            raise ValueError('truncated body')
        data.extend(chunk)
    if len(data) != expected:
        raise ValueError('pipelined request prohibited')
    payload = bytes(data)
    if INJECT_TOKEN:
        header_lines = payload[:split - 4].split(b'\r\n')
        header_lines = [
            line for line in header_lines
            if not line.lower().startswith((b'authorization:', b'x-omnis-service-identity:'))
        ]
        header_lines.extend([
            f'Authorization: Bearer {INJECT_TOKEN}'.encode(),
            b'X-Omnis-Service-Identity: omnis-synthetic-broker',
        ])
        payload = b'\r\n'.join(header_lines) + b'\r\n\r\n' + payload[split:]
    return payload


def relay(client):
    try:
        peer_pid, peer_uid, peer_gid = struct_peer(client)
        if peer_uid != PEER_UID or peer_gid != PEER_GID:
            reject(client)
            return
        payload = read_request(client)
        backend = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        backend.settimeout(2.0)
        backend.connect(BACK)
        backend.sendall(payload)
        total = 0
        while True:
            chunk = backend.recv(4096)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_RESPONSE:
                raise ValueError('response too large')
            client.sendall(chunk)
        backend.close()
    except (OSError, ValueError, PermissionError):
        reject(client)
    finally:
        client.close()
        slots.release()


def struct_peer(client):
    if not hasattr(socket, 'SO_PEERCRED'):
        raise OSError('SO_PEERCRED unavailable')
    import struct
    raw = client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
    return struct.unpack('3i', raw)


def shutdown(_sig, _frame):
    stop.set()
    listener.close()


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)
prepare_front_socket()
try:
    while not stop.is_set():
        try:
            client, _ = listener.accept()
        except (TimeoutError, socket.timeout):
            continue
        except OSError:
            if stop.is_set():
                break
            raise
        if not slots.acquire(blocking=False):
            reject(client)
            client.close()
            continue
        threading.Thread(target=relay, args=(client,), daemon=True).start()
finally:
    try:
        listener.close()
    except OSError:
        pass
    try:
        os.unlink(FRONT)
    except FileNotFoundError:
        pass
