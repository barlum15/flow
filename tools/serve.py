#!/usr/bin/env python3
"""Local development server for flow that never lets the browser cache files.

`python -m http.server` allows browsers to keep old copies of the JavaScript and
CSS files, so changes only show up after a hard reload (or in a private
window). This server sends "Cache-Control: no-store" with every file, so a
normal reload always shows the current version.

Usage (in the project folder):
    python tools/serve.py          # http://localhost:8000
    python tools/serve.py 8080     # another port
"""

import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"Serving {ROOT} at http://localhost:{port}  (no browser cache, Ctrl+C to stop)")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
