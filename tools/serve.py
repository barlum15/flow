#!/usr/bin/env python3
"""Local server for Enerlyza: serves the app and, optionally, external NILM models.

1. Static files with "Cache-Control: no-store", so a normal reload always shows
   the current version of the app (unlike `python -m http.server`).

2. A small model API, used by the load disaggregation panel when external
   (e.g. trained .pkl) models are configured:

       GET  /api/models        -> which models exist and what they need/deliver
       POST /api/disaggregate  -> estimates per device and minute for one model

   The models themselves are reached through an *adapter* (a Python file with
   two functions, see tools/nilm_adapter_template.py). Which adapter to use is
   set in models/config.json:

       {
         "adapter": "models/serve_adapter.py",
         "framework_path": "C:/path/to/the/folder/containing/nilm_framework",
         "settings": { "models_dir": "...", "building": "building_1" }
       }

   "adapter" is relative to the project folder, "framework_path" is optional
   and added to Python's import path, "settings" is passed to the adapter.

   Without models/config.json the API answers "not configured" and the app
   uses its built-in model. The server only listens on localhost.

Usage (in the project folder):
    python tools/serve.py          # http://localhost:8000
    python tools/serve.py 8080     # another port
"""

import functools
import http.server
import importlib.util
import json
import math
import sys
import threading
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "models" / "config.json"
MAX_BODY_BYTES = 20 * 1024 * 1024


class ModelHost:
    """Loads the adapter named in models/config.json (again when the file changes)."""

    def __init__(self):
        self.lock = threading.Lock()  # one prediction at a time; models are not thread-safe
        self.adapter = None
        self.settings = {}
        self.config_mtime = None
        self.error = None

    def ensure(self):
        if not CONFIG_PATH.exists():
            self.adapter, self.error, self.config_mtime = None, f"{CONFIG_PATH.relative_to(ROOT)} not found", None
            return
        mtime = CONFIG_PATH.stat().st_mtime
        if mtime == self.config_mtime:
            return
        self.config_mtime = mtime
        self.adapter, self.error = None, None
        try:
            config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            framework = config.get("framework_path")
            if framework and framework not in sys.path:
                sys.path.insert(0, framework)
            adapter_path = (ROOT / config["adapter"]).resolve()
            spec = importlib.util.spec_from_file_location("enerlyza_nilm_adapter", adapter_path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            for name in ("list_models", "predict"):
                if not callable(getattr(module, name, None)):
                    raise TypeError(f"adapter {adapter_path.name} has no function {name}()")
            self.adapter = module
            self.settings = config.get("settings", {})
            print(f"Model adapter loaded: {adapter_path}")
        except Exception as exc:  # report to the app instead of crashing the server
            self.error = f"could not load the model adapter: {exc}"
            traceback.print_exc()

    def models(self):
        with self.lock:
            self.ensure()
            if not self.adapter:
                return {"available": False, "reason": self.error, "models": []}
            try:
                return {"available": True, "models": self.adapter.list_models(self.settings)}
            except Exception as exc:
                traceback.print_exc()
                return {"available": False, "reason": f"list_models() failed: {exc}", "models": []}

    def predict(self, request):
        import pandas as pd  # only needed when models are used

        with self.lock:
            self.ensure()
            if not self.adapter:
                raise RuntimeError(self.error or "no model adapter configured")
            known = {m["id"]: m for m in self.adapter.list_models(self.settings)}
            info = known.get(request.get("model"))
            if info is None:
                raise LookupError(f"unknown model: {request.get('model')}")
            if info.get("available") is False:
                raise LookupError(f"model {info['id']} is not available: {info.get('reason')}")
            if info.get("needsReactive") and request.get("Q") is None:
                raise ValueError(f"model {info['id']} needs reactive power (Q), which this data does not have")
            p = [math.nan if v is None else float(v) for v in request["P"]]
            q = request.get("Q")
            index = pd.date_range(
                pd.Timestamp(request["start"]).tz_localize(request.get("timezone", "UTC")),
                periods=len(p),
                freq="1min",
            )
            frame = pd.DataFrame({"P": p}, index=index)
            if q is not None:
                frame["Q"] = [math.nan if v is None else float(v) for v in q]

            started = time.perf_counter()
            devices = self.adapter.predict(request["model"], frame, self.settings)
            elapsed = (time.perf_counter() - started) * 1000

        def clean(values):
            if values is None:
                return None
            out = [None if v is None or (isinstance(v, float) and not math.isfinite(v)) else float(v) for v in values]
            if len(out) != len(p):
                raise ValueError(f"adapter returned {len(out)} values for {len(p)} minutes")
            return out

        return {
            "model": request["model"],
            "minutes": len(p),
            "ms": round(elapsed, 1),
            "devices": {
                device: {key: clean(result.get(key)) for key in ("power", "on", "prob")}
                for device, result in devices.items()
            },
        }


HOST = ModelHost()


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/models":
            self.send_json(200, HOST.models())
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/disaggregate":
            self.send_json(404, {"error": "unknown endpoint"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > MAX_BODY_BYTES:
                raise ValueError("request too large")
            request = json.loads(self.rfile.read(length))
            self.send_json(200, HOST.predict(request))
        except (LookupError, ValueError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            traceback.print_exc()
            self.send_json(500, {"error": str(exc)})

    def log_message(self, format, *args):
        if "/api/" in (self.path or ""):
            return  # the app calls the API often; keep the console readable
        super().log_message(format, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"Serving {ROOT} at http://localhost:{port}  (no browser cache, Ctrl+C to stop)")
        HOST.ensure()
        print(f"External NILM models: {'adapter ready' if HOST.adapter else HOST.error}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
