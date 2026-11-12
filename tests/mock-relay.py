"""
Servidor de salas FALSO, so para testar o programa na sua maquina (mesmo protocolo de relay/worker.js,
tudo na memoria). Uso:   python tests/mock-relay.py 8801
Python 3, so biblioteca padrao.
"""
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

CODE_RE = re.compile(r'^[A-HJ-NP-Z2-9]{6,12}$')
ID_RE = re.compile(r'^[A-Za-z0-9_-]{6,40}$')
VID_RE = re.compile(r'^[A-Za-z0-9_-]{11}$')
ROOMS = {}
LOCK = threading.Lock()
LOG = []


def now_ms():
    return int(time.time() * 1000)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, obj, status=200):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('cache-control', 'no-store')
        self.send_header('access-control-allow-origin', '*')
        self.send_header('access-control-allow-methods', 'GET, POST, OPTIONS')
        self.send_header('access-control-allow-headers', 'content-type')
        self.send_header('access-control-allow-private-network', 'true')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send({}, 204)

    def _code(self):
        m = re.match(r'^/api/room/([A-Za-z0-9]+)$', urlparse(self.path).path)
        if not m:
            return None
        c = m.group(1).upper()
        return c if CODE_RE.match(c) else None

    def do_GET(self):
        if urlparse(self.path).path == '/log':
            return self._send(LOG[-200:])
        code = self._code()
        if not code:
            return self._send({'error': 'bad_code'}, 400)
        q = parse_qs(urlparse(self.path).query)
        rid = (q.get('id') or [''])[0]
        since = int((q.get('since') or ['-1'])[0])
        now = now_ms()
        with LOCK:
            room = ROOMS.get(code)
            if not room:
                return self._send({'now': now, 'error': 'room_not_found'}, 404)
            if ID_RE.match(rid):
                room['members'][rid] = now
            active = len([t for t in room['members'].values() if now - t < 30000])
            out = {'now': now, 'v': room['v'], 'members': active}
            if since != room['v']:
                out['state'] = room['state']
        self._send(out)

    def do_POST(self):
        code = self._code()
        if not code:
            return self._send({'error': 'bad_code'}, 400)
        n = int(self.headers.get('content-length') or 0)
        try:
            body = json.loads(self.rfile.read(n) or b'{}')
        except ValueError:
            return self._send({'error': 'bad_json'}, 400)
        rid = str(body.get('id') or '')
        if not ID_RE.match(rid):
            return self._send({'error': 'bad_id'}, 400)
        now = now_ms()
        with LOCK:
            if body.get('op') == 'create':
                if code in ROOMS:
                    return self._send({'now': now, 'error': 'exists'}, 409)
                ROOMS[code] = {'v': 0, 'state': None, 'members': {rid: now}}
                return self._send({'now': now, 'v': 0})
            if body.get('op') == 'set':
                room = ROOMS.get(code)
                if not room:
                    return self._send({'now': now, 'error': 'room_not_found'}, 404)
                s = body.get('state') or {}
                vid = s.get('vid')
                if vid is not None and not VID_RE.match(str(vid)):
                    return self._send({'error': 'bad_state'}, 400)
                st = {'vid': vid, 'list': s.get('list'), 'pos': max(0.0, float(s.get('pos') or 0)),
                      'playing': bool(s.get('playing')), 'rate': max(0.07, min(16.0, float(s.get('rate') or 1))),
                      'at': now, 'by': rid}
                room['v'] += 1
                room['state'] = st
                LOG.append({'t': now, 'code': code, 'v': room['v'], 'by': rid[:6], 'state': st})
                return self._send({'now': now, 'v': room['v'], 'state': st})
        self._send({'error': 'bad_op'}, 400)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8801
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('servidor de salas de teste em http://127.0.0.1:%d' % port, flush=True)
    srv.serve_forever()
