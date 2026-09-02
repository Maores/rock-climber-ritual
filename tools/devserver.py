#!/usr/bin/env python3
"""Dev server for Rock Climber: The Ritual.

Static files from the project root (bound on all interfaces so the iPhone can join
over the LAN), CORS + no-cache headers, and one write endpoint:

  POST /api/event  {json}  -> appended as one line to .claude-events/events.jsonl

Pages use it for "Send to Claude" buttons; a Monitor in the Claude session watches
the file. Nothing else is writable.
"""
import json, os, sys, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENTS = os.path.join(ROOT, '.claude-events', 'events.jsonl')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
                      '.hdr': 'application/octet-stream', '.json': 'application/json',
                      '.webmanifest': 'application/manifest+json'}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204); self.end_headers()

    def do_POST(self):
        if self.path.split('?')[0] != '/api/event':
            self.send_response(404); self.end_headers(); return
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else b'{}'
        try:
            data = json.loads(body.decode('utf-8') or '{}')
        except Exception:
            data = {'raw': body.decode('utf-8', 'replace')}
        if not isinstance(data, dict):
            data = {'value': data}
        data['_ts'] = round(time.time(), 3)
        data['_ip'] = self.client_address[0]
        os.makedirs(os.path.dirname(EVENTS), exist_ok=True)
        with open(EVENTS, 'a', encoding='utf-8') as f:
            f.write(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
        out = b'{"ok":true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, fmt, *args):
        line = fmt % args
        if self.command == 'POST' or ' 404 ' in line or ' 500 ' in line:
            sys.stderr.write('%s %s\n' % (self.address_string(), line))


if __name__ == '__main__':
    ThreadingHTTPServer.allow_reuse_address = True
    srv = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print('dev server on http://0.0.0.0:%d  root=%s' % (PORT, ROOT), flush=True)
    srv.serve_forever()
