#!/usr/bin/env python3
import os
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROXY = ROOT / 'scripts/platform/broker-peer-proxy.py'
AUTHORIZE_GATEWAY = ROOT / 'infra/systemd/omnis-broker-peer-gateway.service'
uid, gid = os.getuid(), os.getgid()

gateway_config = AUTHORIZE_GATEWAY.read_text(encoding='utf-8')
configured_routes = next(
    line.split('=', 2)[2].split(',')
    for line in gateway_config.splitlines()
    if line.startswith('Environment=OMNIS_PEER_ALLOWED_PATHS=')
)
assert set(configured_routes) == {
    '/internal/broker/v1/admissions',
    '/internal/broker/v1/submissions/begin',
    '/internal/broker/v1/provider-events',
    '/internal/broker/v1/recovery/list',
    '/internal/broker/v1/recovery/claim',
}


def backend_server(path, seen):
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(path))
    server.listen(4)
    server.settimeout(0.2)
    while not seen['stop']:
        try:
            client, _ = server.accept()
        except TimeoutError:
            continue
        with client:
            payload = client.recv(8192)
            seen['requests'].append(payload)
            body = b'{"ok":true}'
            client.sendall(b'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 11\r\n\r\n' + body)
    server.close()


def launch(front, back, peer_uid, peer_gid, inject_token=None):
    env = {
        'PATH': os.defpath,
        'PYTHONNOUSERSITE': '1',
        'OMNIS_PEER_FRONT_SOCKET': str(front),
        'OMNIS_PEER_BACK_SOCKET': str(back),
        'OMNIS_PEER_UID': str(peer_uid),
        'OMNIS_PEER_GID': str(peer_gid),
        'OMNIS_PEER_SOCKET_GID': str(gid),
        'OMNIS_PEER_ALLOWED_PATHS': '/internal/broker/v1/admissions',
    }
    if inject_token:
        token_file = Path(front).parent / 'gateway.token'
        token_file.write_text(inject_token, encoding='utf-8')
        env['OMNIS_PEER_INJECT_BROKER_TOKEN_FILE'] = str(token_file)
    process = subprocess.Popen([sys.executable, str(PROXY)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(100):
        if front.exists():
            return process
        if process.poll() is not None:
            raise RuntimeError(process.stderr.read().decode())
        time.sleep(0.02)
    process.terminate()
    raise TimeoutError('peer proxy did not create its socket')


def exchange(front, route='/internal/broker/v1/admissions', authorization=''):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(2)
    client.connect(str(front))
    auth_header = f'Authorization: {authorization}\r\n' if authorization else ''
    client.sendall(f'POST {route} HTTP/1.1\r\nHost: local\r\n{auth_header}Content-Length: 2\r\nConnection: close\r\n\r\n{{}}'.encode())
    data = bytearray()
    while True:
        try:
            chunk = client.recv(4096)
        except ConnectionResetError:
            return b''
        if not chunk:
            break
        data.extend(chunk)
    client.close()
    return bytes(data)


with tempfile.TemporaryDirectory(prefix='omnis-peer-proxy-') as directory:
    root = Path(directory)
    root.chmod(0o750)
    front, back = root / 'front.sock', root / 'back.sock'
    state = {'stop': False, 'requests': []}
    thread = threading.Thread(target=backend_server, args=(back, state), daemon=True)
    thread.start()
    try:
        for index, (expected_uid, expected_gid, allowed, should_forward) in enumerate([
            (uid, gid, '/internal/broker/v1/admissions', True),
            (uid, gid, '/internal/broker/v1/admissions', True),
            (uid + 1, gid, '/internal/broker/v1/admissions', False),
            (uid, gid + 1, '/internal/broker/v1/admissions', False),
            (uid, gid, '/internal/owner/v1/decisions', False),
        ]):
            injected = 'synthetic-injected-token-not-for-callers' if index == 1 else None
            process = launch(front, back, expected_uid, expected_gid, injected)
            info = front.lstat()
            assert stat.S_ISSOCK(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o660
            result = exchange(front, allowed, 'Bearer forged-caller-token')
            process.terminate()
            process.wait(timeout=2)
            assert not front.exists(), 'socket path must be removed after stop'
            if should_forward:
                assert b'200 OK' in result and b'{"ok":true}' in result
            else:
                assert not (b'200 OK' in result), 'unexpected peer or route must not reach backend'
        assert len(state['requests']) == 2, 'only an allowed peer and route reaches backend'
        assert b'Bearer synthetic-injected-token-not-for-callers' in state['requests'][1]
        assert b'Bearer forged-caller-token' not in state['requests'][1]
    finally:
        state['stop'] = True
        thread.join(timeout=1)
print('PASS SO_PEERCRED UID/GID allow, deny, route allowlist, socket mode and restart cleanup')
