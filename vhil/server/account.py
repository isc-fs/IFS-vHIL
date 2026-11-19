"""Your GitHub account on a desktop (dev mode), read live from its file.

`vhil login` (bin/vhil-account) and the editor's Team view both keep it in
${XDG_CONFIG_HOME:-~/.config}/vhil/github (mode 0600, `login=` and `token=`
lines). The api mounts that directory (docker/compose.yaml, VHIL_ACCOUNT_FILE)
and reads the file on each use, so signing in or out takes effect at once:
no restart. VHIL_GITHUB_TOKEN / VHIL_TEAM_LOGIN still work when no file is
there (a token handed to the server by hand).

Signing in from the editor is GitHub's device flow, run here: POST
/api/team/login asks GitHub for a code, the editor shows it with the link,
and a background thread polls until you enter it, then writes the file.
Only in dev mode (a local checkout); github mode has its own login
(vhil/server/auth.py) and never reads this file. Cross-site POSTs are refused
by the auth guard in both modes.
"""
from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from vhil.server.config import env_secret

router = APIRouter()

# The ISC vHIL OAuth app (isc-fs), device flow on; the same as bin/vhil-account.
CLIENT_ID = os.environ.get("VHIL_DEVICE_CLIENT_ID", "Ov23lijKjGq1XpuDCjJB")
GITHUB_WEB = os.environ.get("VHIL_GITHUB_WEB", "https://github.com")
GITHUB_API = os.environ.get("VHIL_GITHUB_API", "https://api.github.com")
SCOPE = "public_repo"
_LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")


def path() -> Path:
    if p := os.environ.get("VHIL_ACCOUNT_FILE"):
        return Path(p)
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "vhil" / "github"


def read() -> dict[str, str]:
    """{login, token} from the file, else {}."""
    try:
        text = path().read_text()
    except OSError:
        return {}
    out = {}
    for line in text.splitlines():
        k, sep, v = line.partition("=")
        if sep and k in ("login", "token") and v.strip():
            out[k] = v.strip()
    if "login" in out and not _LOGIN.match(out["login"]):
        del out["login"]
    return out if out.get("token") else {}


def token() -> str | None:
    """The file's token, else VHIL_GITHUB_TOKEN, else None."""
    return read().get("token") or env_secret("VHIL_GITHUB_TOKEN") or None


def file_login() -> str | None:
    return read().get("login")


def write(login: str, tok: str) -> None:
    """The file, 0600, owned like its directory (the api may run as root on a
    bind mount; the host's vhil-account must still be able to replace it)."""
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"login={login}\ntoken={tok}\n")
    try:
        st = p.parent.stat()
        os.chown(tmp, st.st_uid, st.st_gid)
    except OSError:
        pass  # not root: the file is already ours
    os.replace(tmp, p)


def remove() -> None:
    try:
        path().unlink()
    except FileNotFoundError:
        pass


def _form(text: str) -> dict[str, str]:
    from urllib.parse import parse_qsl
    return dict(parse_qsl(text))


class DeviceFlow:
    """One sign-in in progress: GitHub's code, then a thread polling for it."""

    def __init__(self, http=None, sleep=time.sleep):
        import httpx
        self.http = http or httpx.Client(timeout=20)
        self.sleep = sleep
        self.state = "idle"     # idle | pending | done | failed
        self.code = self.uri = self.error = None
        self.login = None
        self.expires_at = 0.0

    def status(self) -> dict:
        return {"state": self.state, "code": self.code, "uri": self.uri,
                "error": self.error, "login": self.login}

    def start(self) -> dict:
        if not CLIENT_ID:
            raise RuntimeError("no OAuth client ID (VHIL_DEVICE_CLIENT_ID)")
        r = self.http.post(f"{GITHUB_WEB}/login/device/code",
                           data={"client_id": CLIENT_ID, "scope": SCOPE})
        f = _form(r.text) if r.status_code == 200 else {}
        if not f.get("device_code") or not f.get("user_code"):
            raise RuntimeError(f"GitHub refused the sign-in ({r.status_code})")
        self.state, self.error, self.login = "pending", None, None
        self.code, self.uri = f["user_code"], f.get("verification_uri") or f"{GITHUB_WEB}/login/device"
        interval = int(f.get("interval") or 5)
        self.expires_at = time.time() + int(f.get("expires_in") or 900)
        out = self.status()  # before the thread can move it on
        threading.Thread(target=self._poll, args=(f["device_code"], interval),
                         daemon=True).start()
        return out

    def _poll(self, device: str, interval: int) -> None:
        try:
            while time.time() < self.expires_at and self.state == "pending":
                self.sleep(interval)
                if self.state != "pending":
                    return  # cancelled
                r = self.http.post(f"{GITHUB_WEB}/login/oauth/access_token",
                                   data={"client_id": CLIENT_ID, "device_code": device,
                                         "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
                f = _form(r.text)
                if tok := f.get("access_token"):
                    who = self.http.get(f"{GITHUB_API}/user",
                                        headers={"Authorization": f"Bearer {tok}",
                                                 "Accept": "application/vnd.github+json"})
                    login = who.json().get("login") if who.status_code == 200 else None
                    if not isinstance(login, str) or not _LOGIN.match(login):
                        return self._fail("GitHub did not say who you are")
                    write(login, tok)
                    self.state, self.login, self.code = "done", login, None
                    return
                err = f.get("error")
                if err == "slow_down":
                    interval += 5
                elif err == "authorization_pending" or err is None:
                    continue
                else:
                    return self._fail({"expired_token": "the code expired: sign in again",
                                       "access_denied": "sign-in cancelled on GitHub"}
                                      .get(err, f"GitHub: {err}"))
            if self.state == "pending":
                self._fail("the code expired: sign in again")
        except Exception as e:  # noqa: BLE001 - network, a file we can't write
            self._fail(str(e))

    def _fail(self, why: str) -> None:
        self.state, self.error, self.code = "failed", why, None


def _dev_only(request: Request) -> None:
    if request.app.state.settings.auth != "dev":
        raise HTTPException(404, "sign-in here is for a local vHIL; this one has its own login")


def _flow(request: Request) -> DeviceFlow:
    st = request.app.state
    if getattr(st, "device_flow", None) is None:
        st.device_flow = DeviceFlow()
    return st.device_flow


@router.get("/api/team/login")
def login_status(request: Request):
    _dev_only(request)
    return {**_flow(request).status(), "me": file_login()}


@router.post("/api/team/login")
def login_start(request: Request):
    _dev_only(request)
    try:
        return _flow(request).start()
    except Exception as e:  # noqa: BLE001 - GitHub unreachable or refusing
        raise HTTPException(502, str(e))


@router.post("/api/team/logout")
def logout(request: Request):
    _dev_only(request)
    flow = _flow(request)
    if flow.state == "pending":
        flow._fail("cancelled")
    remove()
    return {"me": None}
