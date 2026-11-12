"""
Banco D1 FALSO para testar relay/worker.js na sua maquina: expoe um SQLite em memoria por HTTP, com
a mesma forma de resposta do D1 (first / all / run). Usado por tests/worker-test.js.
Uso:   python tests/d1-shim.py 8802
Python 3, so biblioteca padrao.
"""
import json
import os
import sqlite3
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, '..', 'relay', 'schema.sql')
DB = sqlite3.connect(':memory:', check_same_thread=False)
DB.row_factory = sqlite3.Row
LOCK = threading.Lock()
with open(SCHEMA, 'r', encoding='utf-8') as f:
    DB.executescript(f.read())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, obj, status=200):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('access-control-allow-origin', '*')
        self.send_header('access-control-allow-methods', 'POST, OPTIONS')
        self.send_header('access-control-allow-headers', 'content-type')
        self.send_header('access-control-allow-private-network', 'true')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send({}, 204)

    def do_GET(self):
        self._send({'versao_sqlite': sqlite3.sqlite_version})

    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        body = json.loads(self.rfile.read(n) or b'{}')
        sql = body.get('sql', '')
        params = body.get('params', [])
        mode = body.get('mode', 'run')
        try:
            with LOCK:
                cur = DB.execute(sql, params)
                rows = [dict(r) for r in cur.fetchall()]
                changes = cur.rowcount
                DB.commit()
        except Exception as e:  # erro de SQL: o D1 tambem rejeita a promessa
            return self._send({'error': str(e)}, 500)
        if mode == 'first':
            return self._send({'row': rows[0] if rows else None})
        if mode == 'all':
            return self._send({'results': rows, 'success': True, 'meta': {'changes': max(changes, 0)}})
        return self._send({'success': True, 'meta': {'changes': max(changes, 0)}})


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8802
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('D1 de teste (SQLite %s) em http://127.0.0.1:%d' % (sqlite3.sqlite_version, port), flush=True)
    srv.serve_forever()
