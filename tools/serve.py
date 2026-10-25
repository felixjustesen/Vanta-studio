#!/usr/bin/env python3
"""Lokal testserver, der efterligner Vercels cleanUrls: /metode -> metode.html, /ydelser -> ydelser/index.html.
Kør: python3 tools/serve.py [port]"""
import http.server, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def translate_path(self, path):
        p = super().translate_path(path)
        if os.path.isdir(p) and os.path.exists(os.path.join(p, "index.html")):
            return os.path.join(p, "index.html")
        if not os.path.exists(p) and os.path.exists(p + ".html"):
            return p + ".html"
        return p


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
print(f"http://127.0.0.1:{port}/")
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
