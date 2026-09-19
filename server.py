#!/usr/bin/env python3
"""Jev Playground (OpenRouter) backend: stdlib-only HTTP server + OpenRouter Decisions proxy.

Run:  python3 server.py            (listens on http://127.0.0.1:3001)
Flags: --port, --host, --endpoint <url>   (override the Decisions endpoint)
"""
import argparse
import datetime
import email.utils
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
PRESETS_DIR = ROOT / "presets"

DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
MODEL_INFO_ENDPOINT = "https://openrouter.ai/api/v1/models/{model}/endpoints"
DEFAULT_MODEL = "typesafe/jev-1.13"
UPSTREAM_TIMEOUT = 60          # seconds per attempt
RETRY_STATUSES = {429, 529}
RETRY_BACKOFF = [1.0, 3.0]     # at most 2 retries
MODEL_INFO_TTL = 600           # 10 minutes
MAX_RETRY_WAIT = 30            # seconds; a longer Retry-After is reported instead of waited for
MAX_BODY = 5 * 1024 * 1024     # bytes; request bodies above this are rejected with 413

CONFIG = {"endpoint": DECISIONS_ENDPOINT}
_model_cache = {}              # model id -> (expires_at, status, body)
_model_cache_lock = threading.Lock()

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

# --------------------------------------------------------------------------
# Validation (section 6)
# --------------------------------------------------------------------------
ENTRY_TYPES = (str, dict, list, type(None))
QUESTION_TYPES = ("noul", "choice", "score")


class ValidationError(Exception):
    def __init__(self, path, message):
        super().__init__(message)
        self.path = path
        self.message = message


def _is_entry(v):
    # bool is a subclass of int, but neither int nor bool is in ENTRY_TYPES.
    return isinstance(v, ENTRY_TYPES)


def validate_decide(body):
    if not isinstance(body, dict):
        raise ValidationError("$", "request body must be a JSON object")
    model = body.get("model")
    if not isinstance(model, str) or not model.strip():
        raise ValidationError("model", "must be a non-empty string")
    if "state" not in body:
        raise ValidationError("state", "is required")
    state = body["state"]
    if state is None or not isinstance(state, (str, dict, list)):
        raise ValidationError("state", "must be a string, object or array (not null)")
    if isinstance(state, str) and not state.strip():
        raise ValidationError("state", "must be a non-empty string")
    questions = body.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise ValidationError("questions", "must be a non-empty object")
    for qid, q in questions.items():
        p = f"questions.{qid}"
        if not qid.strip():
            raise ValidationError("questions", "question ids must be non-empty")
        if not isinstance(q, dict):
            raise ValidationError(p, "must be an object")
        qtype = q.get("type")
        if qtype not in QUESTION_TYPES:
            raise ValidationError(f"{p}.type", "must be one of noul, choice, score")
        if "instructions" not in q:
            raise ValidationError(f"{p}.instructions", "is required")
        if not _is_entry(q["instructions"]) or q["instructions"] is None:
            raise ValidationError(f"{p}.instructions",
                                  "must be a string, object or array (null, numbers and booleans are "
                                  "rejected by OpenRouter)")
        if isinstance(q["instructions"], str) and not q["instructions"].strip():
            raise ValidationError(f"{p}.instructions", "must not be empty")
        crit = q.get("criteria")
        if qtype == "choice":
            if not isinstance(crit, dict) or len(crit) < 2:
                raise ValidationError(f"{p}.criteria", "must be an object with at least 2 options")
            for k, v in crit.items():
                if not k.strip():
                    raise ValidationError(f"{p}.criteria", "option keys must be non-empty")
                if not _is_entry(v):
                    raise ValidationError(f"{p}.criteria.{k}",
                                          "must be a string, object, array or null")
        elif qtype == "score":
            if not isinstance(crit, list) or len(crit) < 2:
                raise ValidationError(f"{p}.criteria", "must be an array with at least 2 levels")
            for i, v in enumerate(crit):
                if not _is_entry(v) or v is None:
                    raise ValidationError(f"{p}.criteria[{i}]",
                                          "must be a string, object or array (null is rejected by OpenRouter)")
                if isinstance(v, str) and not v.strip():
                    raise ValidationError(f"{p}.criteria[{i}]", "must not be empty")
        else:  # noul
            if "criteria" in q:
                if not isinstance(crit, dict):
                    raise ValidationError(f"{p}.criteria", "must be an object with true/false keys")
                extra = set(crit) - {"true", "false"}
                if extra:
                    raise ValidationError(f"{p}.criteria",
                                          f"only 'true' and 'false' keys are allowed (got {sorted(extra)})")
                missing = {"true", "false"} - set(crit)
                if missing:
                    raise ValidationError(f"{p}.criteria",
                                          f"OpenRouter requires both 'true' and 'false' when criteria is "
                                          f"present (missing {sorted(missing)}); omit criteria entirely instead")
                for k, v in crit.items():
                    if not _is_entry(v) or v is None:
                        raise ValidationError(f"{p}.criteria.{k}",
                                              "must be a string, object or array (null is rejected by OpenRouter)")
    return {"model": model, "state": state, "questions": questions}


# --------------------------------------------------------------------------
# Upstream calls
# --------------------------------------------------------------------------
def _headers():
    key = os.environ.get("OPENROUTER_API_KEY", "")
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://127.0.0.1:3001",
        "X-Title": "Jev Playground",
    }


def _http(method, url, data=None, timeout=UPSTREAM_TIMEOUT):
    """Returns (status, headers, parsed_json_or_text). Raises on transport errors."""
    req = urllib.request.Request(url, data=data, method=method, headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, resp.headers, _parse(raw)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, e.headers, _parse(raw)


def _parse(raw):
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"message": text[:2000]}


def call_decisions(payload):
    """Forward to OpenRouter with retry policy. Returns dict per section 6."""
    if not os.environ.get("OPENROUTER_API_KEY"):
        return {"ok": False, "status": 0, "attempts": 0,
                "error": {"message": "OPENROUTER_API_KEY is not set in the server environment. "
                                     "Export it and restart: export OPENROUTER_API_KEY=sk-or-..."}}
    data = json.dumps(payload).encode("utf-8")
    t0 = time.monotonic()
    attempts = 0
    last = None
    while True:
        attempts += 1
        try:
            status, headers, body = _http("POST", CONFIG["endpoint"], data)
        except Exception as e:  # transport failure
            status, headers, body = 0, {}, {"message": f"{type(e).__name__}: {e}"}
        last = (status, headers, body)
        if 200 <= status < 300:
            return {"ok": True, "latency_ms": int((time.monotonic() - t0) * 1000),
                    "attempts": attempts, "response": body}
        if status in RETRY_STATUSES and attempts <= len(RETRY_BACKOFF):
            delay = RETRY_BACKOFF[attempts - 1]
            ra = _retry_after_seconds(headers.get("Retry-After") if headers else None)
            if ra is not None:
                delay = max(delay, ra)
            if delay > MAX_RETRY_WAIT:
                # Honor the header by not retrying early; report instead of blocking the UI.
                note = {"message": f"upstream asked to wait {int(delay)} s (Retry-After) before retrying; "
                                   f"giving up after {attempts} attempt(s)", "retry_after_s": delay}
                return {"ok": False, "status": status, "attempts": attempts,
                        "latency_ms": int((time.monotonic() - t0) * 1000),
                        "error": body if isinstance(body, dict) else {"message": str(body)},
                        "retry_note": note}
            time.sleep(delay)
            continue
        break
    status, _, body = last
    # "error" carries the upstream JSON body verbatim (usually {"error": {...}}); the UI unwraps it.
    return {"ok": False, "status": status, "attempts": attempts,
            "latency_ms": int((time.monotonic() - t0) * 1000),
            "error": body if isinstance(body, dict) else {"message": str(body)}}


def _retry_after_seconds(value):
    """Retry-After as seconds (int) or HTTP-date; None when absent or unparsable."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        dt = email.utils.parsedate_to_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return max(0.0, (dt - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
    except (TypeError, ValueError, IndexError):
        return None


def model_info(model):
    now = time.time()
    with _model_cache_lock:
        hit = _model_cache.get(model)
        if hit and hit[0] > now:
            return hit[1], hit[2], True
    if not os.environ.get("OPENROUTER_API_KEY"):
        return 500, {"error": {"message": "OPENROUTER_API_KEY is not set"}}, False
    url = MODEL_INFO_ENDPOINT.format(model=quote(model, safe="/"))
    try:
        status, _, body = _http("GET", url, timeout=30)
    except Exception as e:
        return 502, {"error": {"message": f"{type(e).__name__}: {e}"}}, False
    if 200 <= status < 300:
        with _model_cache_lock:
            _model_cache[model] = (now + MODEL_INFO_TTL, status, body)
    return status, body, False


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "JevPlayground/1.0"
    protocol_version = "HTTP/1.1"
    timeout = 30                   # socket read deadline: a client that withholds body bytes is dropped

    def log_message(self, fmt, *args):  # silence default logging; we log ourselves
        pass

    def _log(self, status, t0, tokens="-", cost="-"):
        ms = int((time.monotonic() - t0) * 1000)
        print(f"{self.command} {self.path} {status} {ms}ms tokens={tokens} cost={cost}", flush=True)

    def _send(self, status, data, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, obj, status=200):
        self._send(status, json.dumps(obj, indent=2, ensure_ascii=False))

    def _body_length(self):
        """Validated Content-Length, or raises ValidationError (status carried in .path)."""
        if "Transfer-Encoding" in self.headers:
            raise ValidationError("411", "chunked request bodies are not supported; send Content-Length")
        raw = self.headers.get("Content-Length")
        if raw is None:
            return 0
        try:
            length = int(raw)
        except ValueError:
            raise ValidationError("400", "invalid Content-Length header")
        if length < 0:
            raise ValidationError("400", "invalid Content-Length header")
        if length > MAX_BODY:
            raise ValidationError("413", f"request body larger than {MAX_BODY} bytes")
        return length

    def _drain_body(self):
        """Consume a (bounded) request body so keep-alive framing stays intact; else close."""
        try:
            n = self._body_length()
            if n:
                self.rfile.read(n)
        except ValidationError:
            self.close_connection = True

    def _read_json(self):
        length = self._body_length()
        raw = self.rfile.read(length) if length else b""
        if length and len(raw) != length:
            raise ValidationError("400", f"incomplete request body ({len(raw)} of {length} bytes)")
        if not raw:
            raise ValidationError("$", "empty request body")
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValidationError("$", f"invalid JSON: {e}")

    def _serve_file(self, path: Path, t0, base: Path = STATIC_DIR):
        try:
            resolved = path.resolve()
            resolved.relative_to(base.resolve())
            data = resolved.read_bytes()
        except (FileNotFoundError, ValueError, IsADirectoryError, PermissionError):
            self._json({"error": "not found"}, 404)
            self._log(404, t0)
            return
        ctype = MIME.get(resolved.suffix, "application/octet-stream")
        self._send(200, data, ctype)
        self._log(200, t0)

    # GET ------------------------------------------------------------------
    def do_GET(self):
        t0 = time.monotonic()
        url = urlparse(self.path)
        path = url.path
        if path == "/" or path == "/index.html":
            return self._serve_file(STATIC_DIR / "index.html", t0)
        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            return self._serve_file(STATIC_DIR / rel, t0)
        if path == "/presets":
            names = sorted(p.stem for p in PRESETS_DIR.glob("*.json"))
            self._json({"presets": names})
            return self._log(200, t0)
        if path.startswith("/presets/"):
            name = path[len("/presets/"):]
            if name.endswith(".json"):
                name = name[:-5]
            if not name or "/" in name or ".." in name:
                self._json({"error": "bad preset name"}, 400)
                return self._log(400, t0)
            f = PRESETS_DIR / f"{name}.json"
            if not f.is_file():
                self._json({"error": f"preset '{name}' not found"}, 404)
                return self._log(404, t0)
            try:
                self._json(json.loads(f.read_text("utf-8")))
                return self._log(200, t0)
            except json.JSONDecodeError as e:
                self._json({"error": f"preset '{name}' is not valid JSON: {e}"}, 500)
                return self._log(500, t0)
        if path == "/api/model-info":
            q = parse_qs(url.query)
            model = (q.get("model") or [DEFAULT_MODEL])[0].strip() or DEFAULT_MODEL
            status, body, cached = model_info(model)
            self._json({"ok": 200 <= status < 300, "status": status, "cached": cached,
                        "model": model, "response": body}, 200)
            return self._log(status, t0)
        if path == "/api/config":
            self._json({"endpoint": CONFIG["endpoint"], "default_model": DEFAULT_MODEL,
                        "has_key": bool(os.environ.get("OPENROUTER_API_KEY"))})
            return self._log(200, t0)
        self._json({"error": "not found", "path": path}, 404)
        self._log(404, t0)

    def do_HEAD(self):
        self.do_GET()

    # POST -----------------------------------------------------------------
    def do_POST(self):
        t0 = time.monotonic()
        url = urlparse(self.path)
        if url.path != "/api/decide":
            self._drain_body()
            self._json({"error": "not found", "path": url.path}, 404)
            return self._log(404, t0)
        try:
            body = self._read_json()
            payload = validate_decide(body)
        except ValidationError as e:
            status = int(e.path) if e.path in ("400", "411", "413") else 400
            if status != 400 or e.path == "400":   # framing problem: body may be unread
                self.close_connection = True
            self._json({"ok": False, "status": status, "attempts": 0,
                        "error": {"message": e.message, "path": None if e.path in ("400", "411", "413") else e.path,
                                  "code": status}}, status)
            return self._log(status, t0)
        result = call_decisions(payload)
        if result["ok"]:
            usage = (result["response"] or {}).get("usage", {}) if isinstance(result["response"], dict) else {}
            self._json(result, 200)
            self._log(200, t0, usage.get("input_tokens", "-"), usage.get("cost", "-"))
        else:
            # Keep our HTTP status 200 so the browser reads the JSON envelope;
            # the upstream status lives in result["status"].
            self._json(result, 200)
            self._log(result["status"], t0)


def main():
    ap = argparse.ArgumentParser(description="Jev Playground (OpenRouter) server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=3001)
    ap.add_argument("--endpoint", default=DECISIONS_ENDPOINT,
                    help="override the OpenRouter Decisions endpoint URL")
    args = ap.parse_args()
    CONFIG["endpoint"] = args.endpoint
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("WARNING: OPENROUTER_API_KEY is not set; /api/decide will return an error.", flush=True)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"Jev Playground (OpenRouter) listening on http://{args.host}:{args.port}  (endpoint: {CONFIG['endpoint']})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
