#!/usr/bin/env python3
"""KadrStudio - lokalny serwer.

* serwuje pliki aplikacji (index.html, js, css ...)
* POST /api/save?name=...       zapisuje wyeksportowany film w folderze Filmy/
* POST /api/transcode?kind=...  konwertuje plik (ffmpeg), gdy przegladarka go nie odczyta
* GET  /api/open-folder         otwiera folder Filmy w Eksploratorze
* GET  /api/ping                informacja o serwerze

Serwer slucha tylko na 127.0.0.1 (ten komputer), na dwoch portach:
* 5180 - dla tego komputera (Edge --app). Zapis filmow i ffmpeg dzialaja tylko tu.
* 5199 - "publiczny": na niego kieruje Tailscale Funnel (telefon przez https).
  Wlacza sie tylko w glownej instancji (port 5180) albo gdy ustawiono KADR_PUBLIC_PORT.
  Kazde zapytanie na tym porcie jest traktowane jako obce: tylko pliki aplikacji,
  bez /api/save, /api/transcode, /api/open-folder, bez folderu Filmy i bez listingu katalogow.
"""
import http.server
import ipaddress
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(ROOT, "Filmy")
# pliki tymczasowe na tym samym dysku co program (dysk C: bywa pelny)
TMP_DIR = os.path.join(ROOT, ".tmp")
os.makedirs(TMP_DIR, exist_ok=True)
tempfile.tempdir = TMP_DIR
SPEECH_DIR = os.path.join(ROOT, "mowa")
SPEECH_PY = os.path.join(SPEECH_DIR, ".venv", "Scripts", "python.exe") if sys.platform.startswith("win") \
    else os.path.join(SPEECH_DIR, ".venv", "bin", "python")
SPEECH_MODEL = os.environ.get("KADR_WHISPER_MODEL", "small")
# pliki projektów (filmy, zdjęcia, muzyka) – na dysku D:, zamiast w pamięci przeglądarki na C:
MEDIA_DIR = os.path.join(ROOT, "Projekty")
PRIVATE_DIRS = (OUT_DIR, SPEECH_DIR, TMP_DIR, MEDIA_DIR)
ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
EXT_RE = re.compile(r"^[a-z0-9]{1,6}$")


def media_path(pid, mid=None, ext=None):
    if not ID_RE.match(pid or "") or (mid is not None and not ID_RE.match(mid)) or (ext is not None and not EXT_RE.match(ext)):
        raise ValueError("Nieprawidlowa nazwa pliku")
    folder = os.path.join(MEDIA_DIR, pid)
    return folder if mid is None else os.path.join(folder, f"{mid}.{ext}")
PORT = int(os.environ.get("KADR_PORT", "5180"))
PUBLIC_PORT = int(os.environ.get("KADR_PUBLIC_PORT", "5199"))
PHONE_HTTPS_PORT = int(os.environ.get("KADR_PHONE_PORT", "8443"))
HOST = os.environ.get("KADR_HOST", "127.0.0.1")
VERSION = "1.1"
MAX_UPLOAD = 8 * 1024 * 1024 * 1024  # 8 GB
LOCAL_HOSTS = ("127.0.0.1", "localhost", "[::1]", "::1")
PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".woff2": "font/woff2",
}


def ffmpeg_bin():
    return shutil.which("ffmpeg")


def safe_name(name, default="film"):
    name = os.path.basename(name or "").strip()
    name = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", name)
    name = re.sub(r"[^\w \-\.\(\)ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]", "_", name, flags=re.UNICODE)
    name = name.strip(" .")[:80]
    return name or default


def tailscale_bin():
    found = shutil.which("tailscale")
    if found:
        return found
    for p in (os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Tailscale", "tailscale.exe"),
              "/usr/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        if os.path.exists(p):
            return p
    return None


_phone_cache = {"t": 0.0, "url": None, "funnel": False}
_phone_lock = threading.Lock()


def phone_info():
    """Adres https dla telefonu (Tailscale Funnel) - odswiezany co minute."""
    with _phone_lock:
        if time.time() - _phone_cache["t"] < 60:
            return _phone_cache["url"], _phone_cache["funnel"]
        url, funnel = None, False
        ts = tailscale_bin()
        if ts:
            flags = subprocess.CREATE_NO_WINDOW if sys.platform.startswith("win") else 0
            try:
                r = subprocess.run([ts, "status", "--json"], capture_output=True, text=True, timeout=6,
                                   creationflags=flags)
                dns = (json.loads(r.stdout).get("Self") or {}).get("DNSName", "").rstrip(".")
                if dns:
                    url = f"https://{dns}:{PHONE_HTTPS_PORT}/"
                    s = subprocess.run([ts, "funnel", "status"], capture_output=True, text=True, timeout=6,
                                       creationflags=flags)
                    out = s.stdout or ""
                    funnel = f":{PHONE_HTTPS_PORT}" in out and f"127.0.0.1:{PUBLIC_PORT}" in out
            except Exception:
                pass
        _phone_cache.update(t=time.time(), url=url, funnel=funnel)
        return url, funnel


class SpeechWorker:
    """Rozpoznawanie mowy w osobnym procesie (mowa/.venv + faster-whisper), uruchamiane przy pierwszym uzyciu."""

    IDLE_SECONDS = 600  # po 10 min bez uzycia zamknij proces (zwalnia ok. 1 GB pamieci)

    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()
        self.seq = 0
        self.busy = False
        self.last = time.time()
        threading.Thread(target=self._reaper, daemon=True).start()

    def _reaper(self):
        while True:
            time.sleep(60)
            if self.proc and not self.busy and time.time() - self.last > self.IDLE_SECONDS:
                with self.lock:
                    if self.proc and self.proc.poll() is None:
                        try:
                            self.proc.terminate()
                        except Exception:
                            pass
                    self.proc = None

    def available(self):
        return os.path.exists(SPEECH_PY) and os.path.exists(os.path.join(SPEECH_DIR, "worker.py"))

    def model_dir(self):
        return os.path.join(SPEECH_DIR, "models", SPEECH_MODEL)

    def model_ready(self):
        return os.path.exists(os.path.join(self.model_dir(), "model.bin"))

    def downloaded_mb(self):
        total = 0
        for base, _dirs, files in os.walk(self.model_dir()):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(base, f))
                except OSError:
                    pass
        return round(total / 1e6, 1)

    def _start(self):
        flags = subprocess.CREATE_NO_WINDOW if sys.platform.startswith("win") else 0
        log = open(os.path.join(SPEECH_DIR, "worker.log"), "ab")
        env = dict(os.environ, KADR_WHISPER_MODEL=SPEECH_MODEL, PYTHONIOENCODING="utf-8", TMP=TMP_DIR, TEMP=TMP_DIR,
                   HF_HOME=os.path.join(SPEECH_DIR, "hf"))
        self.proc = subprocess.Popen([SPEECH_PY, "-u", os.path.join(SPEECH_DIR, "worker.py")],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, cwd=SPEECH_DIR,
                                     env=env, creationflags=flags, text=True, encoding="utf-8", bufsize=1)
        if not self.proc.stdout.readline():
            self.proc = None
            raise RuntimeError("Nie udalo sie uruchomic rozpoznawania mowy (mowa/worker.log)")

    def request(self, payload):
        with self.lock:
            self.busy = True
            try:
                if self.proc is None or self.proc.poll() is not None:
                    self._start()
                self.seq += 1
                payload["id"] = self.seq
                self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                self.proc.stdin.flush()
                while True:
                    line = self.proc.stdout.readline()
                    if not line:
                        self.proc = None
                        raise RuntimeError("Rozpoznawanie mowy przerwane (mowa/worker.log)")
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    if msg.get("id") == payload["id"]:
                        return msg
            finally:
                self.busy = False
                self.last = time.time()


SPEECH = SpeechWorker()


def unique_path(folder, base, ext):
    path = os.path.join(folder, base + ext)
    i = 2
    while os.path.exists(path):
        path = os.path.join(folder, f"{base} ({i}){ext}")
        i += 1
    return path


class Handler(http.server.SimpleHTTPRequestHandler):
    public = False  # True dla portu, na ktory kieruje Tailscale Funnel

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # cicho
        if os.environ.get("KADR_DEBUG"):
            super().log_message(fmt, *args)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext) or super().guess_type(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    # --- pomocnicze ---------------------------------------------------
    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _is_local(self):
        """Czy zapytanie przyszlo z tego komputera (a nie przez Tailscale / inny proxy)."""
        if self.public:
            return False
        try:
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                return False
        except ValueError:
            return False
        host = re.sub(r":\d+$", "", (self.headers.get("Host") or "").strip()).lower()
        if host not in LOCAL_HOSTS:
            return False
        for name in self.headers.keys():
            n = name.lower()
            if n in PROXY_HEADERS or n.startswith("tailscale-"):
                return False
        return True

    def _trusted(self):
        """Tylko ten komputer + naglowek X-Kadr (ochrona przed CSRF / DNS rebinding)."""
        return self._is_local() and self.headers.get("X-Kadr") == "1"

    def _blocked_static(self):
        """Foldery Filmy, mowa i .tmp nie sa serwowane jako pliki (prywatne filmy, model mowy)."""
        try:
            real = os.path.normcase(os.path.realpath(self.translate_path(self.path)))
            for d in PRIVATE_DIRS:
                dd = os.path.normcase(os.path.realpath(d))
                if real == dd or real.startswith(dd + os.sep):
                    return True
            return False
        except Exception:
            return True

    def list_directory(self, path):  # bez listingu katalogow
        self.send_error(404, "Not found")
        return None

    def send_head(self):
        ext = os.path.splitext(urllib.parse.urlparse(self.path).path)[1].lower()
        if self._blocked_static() or (self.public and ext in (".py", ".pyc", ".cmd", ".bat", ".md", ".part", ".lnk")):
            self.send_error(404, "Not found")
            return None
        return super().send_head()

    def _read_body_to(self, path):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD:
            raise ValueError("Nieprawidlowy rozmiar pliku")
        left = length
        with open(path, "wb") as f:
            while left > 0:
                chunk = self.rfile.read(min(1024 * 1024, left))
                if not chunk:
                    raise ValueError("Przerwane wysylanie")
                f.write(chunk)
                left -= len(chunk)
        return length

    def _serve_media(self, u, head=False):
        """Plik projektu z obsługą zakresów (Range) – <video> przewija bez wczytywania całości."""
        if not self._is_local():
            return self._json({"ok": False}, 403)
        try:
            _, _, _, pid, fname = u.path.split("/", 4)
            mid, ext = fname.rsplit(".", 1)
            path = media_path(pid, mid, ext.lower())
        except ValueError:
            return self._json({"ok": False}, 400)
        if not os.path.isfile(path):
            return self._json({"ok": False, "error": "brak pliku"}, 404)
        size = os.path.getsize(path)
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            mt = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if mt:
                s, e = mt.groups()
                if s == "" and e:
                    start = max(0, size - int(e))
                else:
                    start = int(s or 0)
                    end = min(int(e), size - 1) if e else size - 1
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                code = 206
        length = end - start + 1
        self.send_response(code)
        self.send_header("Content-Type", MIME.get("." + ext.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head:
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(1024 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_HEAD(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/api/media/"):
            return self._serve_media(u, head=True)
        return super().do_HEAD()

    # --- GET ------------------------------------------------------------
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/api/media/"):
            return self._serve_media(u)
        if u.path == "/api/ping":
            local = self._is_local()
            if local and "refresh" in u.query:
                _phone_cache["t"] = 0.0
            info = {"ok": True, "app": "KadrStudio", "version": VERSION, "local": local,
                    "ffmpeg": local and bool(ffmpeg_bin()), "storage": local}
            if local:
                url, funnel = phone_info()
                info.update(folder=OUT_DIR, phoneUrl=url, phoneFunnel=funnel)
            return self._json(info)
        if u.path == "/api/open-folder":
            if not self._trusted():
                return self._json({"ok": False}, 403)
            os.makedirs(OUT_DIR, exist_ok=True)
            try:
                if sys.platform.startswith("win"):
                    os.startfile(OUT_DIR)  # noqa
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", OUT_DIR])
                else:
                    subprocess.Popen(["xdg-open", OUT_DIR])
            except Exception as e:  # pragma: no cover
                return self._json({"ok": False, "error": str(e)}, 500)
            return self._json({"ok": True})
        if u.path == "/api/speech":
            if not self._is_local():
                return self._json({"ok": False, "available": False}, 403)
            return self._json({"ok": True, "available": SPEECH.available(), "model": SPEECH_MODEL,
                               "modelReady": SPEECH.model_ready(), "downloadedMB": SPEECH.downloaded_mb(),
                               "busy": SPEECH.busy})
        if u.path == "/api/samples":
            folder = os.path.join(ROOT, "samples")
            files = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
            return self._json({"files": [f for f in files if not f.startswith(".")]})
        return super().do_GET()

    # --- POST -----------------------------------------------------------
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if not self._trusted():
            return self._json({"ok": False, "error": "forbidden"}, 403)
        if u.path == "/api/save":
            return self._save(q)
        if u.path == "/api/transcode":
            return self._transcode(q)
        if u.path == "/api/transcribe":
            return self._transcribe(q)
        if u.path == "/api/media":
            return self._media_upload(q)
        if u.path == "/api/media-delete":
            return self._media_delete(q)
        if u.path == "/api/media-transcode":
            return self._media_transcode(q)
        if u.path == "/api/project-delete":
            try:
                folder = media_path(q.get("project", [""])[0])
            except ValueError:
                return self._json({"ok": False}, 400)
            shutil.rmtree(folder, ignore_errors=True)
            return self._json({"ok": True})
        return self._json({"ok": False, "error": "not found"}, 404)

    # --- pliki projektów ----------------------------------------------
    def _media_upload(self, q):
        try:
            path = media_path(q.get("project", [""])[0], q.get("id", [""])[0], q.get("ext", ["bin"])[0].lower())
        except ValueError as e:
            return self._json({"ok": False, "error": str(e)}, 400)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".part"
        try:
            size = self._read_body_to(tmp)
            os.replace(tmp, path)
        except Exception as e:
            if os.path.exists(tmp):
                os.remove(tmp)
            return self._json({"ok": False, "error": str(e)}, 400)
        return self._json({"ok": True, "size": size})

    def _media_delete(self, q):
        try:
            pid, mid = q.get("project", [""])[0], q.get("id", [""])[0]
            folder = media_path(pid)
            media_path(pid, mid, "x")
        except ValueError:
            return self._json({"ok": False}, 400)
        if os.path.isdir(folder):
            for f in os.listdir(folder):
                if f.rsplit(".", 1)[0] == mid:
                    try:
                        os.remove(os.path.join(folder, f))
                    except OSError:
                        pass
        return self._json({"ok": True})

    def _media_transcode(self, q):
        """Konwersja pliku zapisanego w projekcie (ffmpeg) – wynik zostaje na dysku D:."""
        ff = ffmpeg_bin()
        if not ff:
            return self._json({"ok": False, "error": "Brak ffmpeg"}, 501)
        kind = q.get("kind", ["video"])[0]
        try:
            pid, mid = q.get("project", [""])[0], q.get("id", [""])[0]
            src = media_path(pid, mid, q.get("ext", ["bin"])[0].lower())
            out_ext = "m4a" if kind == "audio" else "mp4"
            out = media_path(pid, mid, out_ext)
        except ValueError as e:
            return self._json({"ok": False, "error": str(e)}, 400)
        if not os.path.isfile(src):
            return self._json({"ok": False, "error": "brak pliku"}, 404)
        tmp_out = os.path.join(TMP_DIR, f"{mid}_konw.{out_ext}")
        if kind == "audio":
            cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-c:a", "aac", "-b:a", "192k", tmp_out]
        else:
            cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
                   "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
                   "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp_out]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60 * 60)
        if r.returncode != 0 or not os.path.exists(tmp_out):
            return self._json({"ok": False, "error": (r.stderr or "ffmpeg error")[-400:]}, 422)
        os.replace(tmp_out, out)
        if os.path.normcase(src) != os.path.normcase(out):
            try:
                os.remove(src)
            except OSError:
                pass
        return self._json({"ok": True, "ext": out_ext, "size": os.path.getsize(out),
                           "mime": "audio/mp4" if kind == "audio" else "video/mp4"})

    def _transcribe(self, q):
        if not SPEECH.available():
            return self._json({"ok": False, "error": "Brak modulu rozpoznawania mowy (mowa/.venv)"}, 501)
        fd, path = tempfile.mkstemp(suffix=".wav", dir=TMP_DIR)
        os.close(fd)
        try:
            self._read_body_to(path)
            lang = re.sub(r"[^a-z]", "", q.get("lang", ["pl"])[0].lower())[:5] or None
            res = SPEECH.request({"wav": path, "lang": lang})
            return self._json(res, 200 if res.get("ok") else 500)
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 500)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    def _save(self, q):
        os.makedirs(OUT_DIR, exist_ok=True)
        ext = ".webm" if (q.get("ext", ["mp4"])[0] == "webm") else ".mp4"
        base = safe_name(q.get("name", ["film"])[0])
        path = unique_path(OUT_DIR, base, ext)
        tmp = path + ".part"
        try:
            self._read_body_to(tmp)
            os.replace(tmp, path)
        except Exception as e:
            if os.path.exists(tmp):
                os.remove(tmp)
            return self._json({"ok": False, "error": str(e)}, 400)
        return self._json({"ok": True, "file": os.path.basename(path), "path": path})

    def _transcode(self, q):
        ff = ffmpeg_bin()
        if not ff:
            return self._json({"ok": False, "error": "Brak ffmpeg"}, 501)
        kind = q.get("kind", ["video"])[0]
        tmpdir = tempfile.mkdtemp(prefix="kadr_")
        src = os.path.join(tmpdir, "wejscie.bin")
        try:
            self._read_body_to(src)
            if kind == "audio":
                out = os.path.join(tmpdir, "wyjscie.m4a")
                cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
                       "-vn", "-c:a", "aac", "-b:a", "192k", out]
                mime = "audio/mp4"
            else:
                out = os.path.join(tmpdir, "wyjscie.mp4")
                cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
                       "-map", "0:v:0", "-map", "0:a:0?",
                       "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                       "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
                       "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]
                mime = "video/mp4"
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60 * 60)
            if r.returncode != 0 or not os.path.exists(out):
                return self._json({"ok": False, "error": (r.stderr or "ffmpeg error")[-400:]}, 422)
            size = os.path.getsize(out)
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(out, "rb") as f:
                shutil.copyfileobj(f, self.wfile, 1024 * 1024)
        except Exception as e:
            try:
                self._json({"ok": False, "error": str(e)}, 400)
            except Exception:
                pass
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class PublicHandler(Handler):
    public = True


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # na Windows SO_REUSEADDR pozwala dwom serwerom zajac ten sam port - wolimy jasny blad
    allow_reuse_address = not sys.platform.startswith("win")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    # port dla telefonu tylko w glownej instancji - testowe kopie (np. KADR_PORT=5181) go nie zajmuja
    if PORT == 5180 or "KADR_PUBLIC_PORT" in os.environ:
        try:
            public = Server(("127.0.0.1", PUBLIC_PORT), PublicHandler)
            threading.Thread(target=public.serve_forever, daemon=True).start()
            print(f"Port dla telefonu (Tailscale Funnel): 127.0.0.1:{PUBLIC_PORT}")
        except OSError as e:
            print(f"Uwaga: port {PUBLIC_PORT} zajety ({e}) - KadrStudio na telefonie nie bedzie dzialac.")
    with Server((HOST, PORT), Handler) as httpd:
        print(f"KadrStudio dziala: http://{'localhost' if HOST == '127.0.0.1' else HOST}:{PORT}/")
        print("Zamknij to okno, aby wylaczyc program.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
