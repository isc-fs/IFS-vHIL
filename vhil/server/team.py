"""The team store: systems, scenarios and catalogue entries teammates share.

The store is the repository itself. A teammate's work is a branch named
shared/<login>/<name> on GitHub, saved the usual way (vhil/server/gitstore.py:
a commit, no checkout moves) and pushed by Share. Sync fetches every such
branch into refs/remotes/origin/shared/*, and the editor lists them (the Team
section): each with who shared it, when, and which systems, scenarios and
catalogue files it changes against the base branch. A teammate's system opens
read from their branch (GitStore.parent reads origin/<branch>), and an edit of
it saves to a branch of your own built on their commit (a save's `base`), so
nobody moves another member's branch; Propose opens a PR into the base branch
as for any branch (systems_write.pull_request).

Who you are: the signed-in member in github mode; on a desktop (dev mode) the
GitHub account the app signed in with: VHIL_TEAM_LOGIN, else the login of
VHIL_GITHUB_TOKEN (GitHub's /user, looked up once). Without one you can sync
and read, not share.
"""
from __future__ import annotations

import os
import re
import subprocess
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from vhil.server.gitstore import GitStore
from vhil.server.githost import GitHubHost, HostError, HostUnavailable, _scrub, git_auth_env

router = APIRouter()

PREFIX = "shared/"
_LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_SYSTEM = re.compile(r"^systems/([a-z0-9][a-z0-9-]{0,63})\.yaml$")
_SCENARIO = re.compile(r"^systems/([a-z0-9][a-z0-9-]{0,63})\.scenarios/([^/]+)\.ya?ml$")
FETCH_TIMEOUT_S = 60


def mine(login: str) -> str:
    """The branch prefix of `login`'s shared work."""
    return f"{PREFIX}{login}/"


def owner_of(branch: str) -> str | None:
    """The login a shared/<login>/<name> branch belongs to, else None."""
    parts = branch.split("/")
    if len(parts) >= 3 and parts[0] + "/" == PREFIX and _LOGIN.match(parts[1]):
        return parts[1]
    return None


def _token(request: Request) -> str | None:
    from vhil.server.systems_write import _host
    host = _host(request)
    tok = getattr(host, "token", None)
    if callable(tok):
        try:
            return tok()
        except Exception:  # noqa: BLE001 - the App's own errors, network
            return None
    return tok or None


def _github_login(token: str) -> str | None:
    import httpx
    try:
        r = httpx.get("https://api.github.com/user", timeout=15,
                      headers={"Authorization": f"Bearer {token}",
                               "Accept": "application/vnd.github+json"})
    except httpx.HTTPError:
        return None
    login = r.json().get("login") if r.status_code == 200 else None
    return login if isinstance(login, str) and _LOGIN.match(login) else None


def login(request: Request) -> str | None:
    """Who shares from this request (the module docstring), or None."""
    st = request.app.state
    if st.settings.auth != "dev":
        found = (getattr(request.state, "user", None) or {}).get("login")
        return found if isinstance(found, str) and _LOGIN.match(found) else None
    if getattr(st, "team_login", None) is None:
        env = os.environ.get("VHIL_TEAM_LOGIN", "")
        if _LOGIN.match(env):
            st.team_login = env
        else:
            token = _token(request)
            st.team_login = (_github_login(token) if token else None) or ""
    return st.team_login or None


def _refs(store: GitStore) -> dict[str, dict]:
    """{branch: {local, remote}} of every shared branch, local and fetched."""
    out = store.git("for-each-ref", "--format=%(refname)%00%(objectname)",
                    "refs/heads/shared", "refs/remotes/origin/shared")
    found: dict[str, dict] = {}
    for line in out.splitlines():
        ref, _, sha = line.partition("\0")
        if ref.startswith("refs/heads/"):
            found.setdefault(ref.removeprefix("refs/heads/"), {})["local"] = sha
        elif ref.startswith("refs/remotes/origin/"):
            found.setdefault(ref.removeprefix("refs/remotes/origin/"), {})["remote"] = sha
    return {b: r for b, r in found.items() if owner_of(b)}


def _state(store: GitStore, local: str | None, remote: str | None) -> str:
    """local (never shared), shared (as on GitHub), ahead (saved since the
    last share), remote (a teammate's, or yours from another machine) or
    diverged."""
    if not remote:
        return "local"
    if not local or local == remote:
        return "shared" if local else "remote"
    if subprocess.run(["git", "-C", str(store.root), "merge-base", "--is-ancestor", remote, local],
                      capture_output=True).returncode == 0:
        return "ahead"
    return "diverged"


def item(store: GitStore, branch: str, refs: dict, me: str | None) -> dict:
    """What the Team list shows of one shared branch."""
    local, remote = refs.get("local"), refs.get("remote")
    sha = local or remote
    base = store.base_commit()
    fork = store.git("merge-base", base, sha, check=False) or base
    systems, scenarios, catalog, other = [], [], [], []
    for path in store.git("diff", "--name-only", "--no-renames", fork, sha).splitlines():
        if m := _SYSTEM.match(path):
            systems.append(m.group(1))
        elif m := _SCENARIO.match(path):
            scenarios.append({"system": m.group(1), "name": m.group(2)})
        elif path.startswith("catalog/"):
            catalog.append(path)
        else:
            other.append(path)
    date, subject = store.git("log", "-1", "--format=%cI%x00%s", sha).split("\0", 1)
    owner = owner_of(branch)
    return {"branch": branch, "owner": owner, "mine": bool(me) and owner.lower() == me.lower(),
            "saved_by": store.owner(sha) or owner, "sha": sha, "date": date, "subject": subject,
            "state": _state(store, local, remote),
            "behind": int(store.git("rev-list", "--count", f"{sha}..{base}") or 0),
            "systems": systems, "scenarios": scenarios, "catalog": catalog, "other": other}


def listing(request: Request) -> dict:
    from vhil.server.systems_write import _store
    store = _store(request)
    me = login(request)
    refs = _refs(store)
    items = sorted((item(store, b, r, me) for b, r in refs.items()),
                   key=lambda i: i["date"], reverse=True)
    st = request.app.state
    return {"me": me, "prefix": mine(me) if me else None, "base": store.base,
            "can_share": bool(me) and bool(_token(request)),
            "synced_at": getattr(st, "team_synced_at", None), "items": items}


def fetch(store: GitStore, token: str | None) -> None:
    """Every shared branch of origin into refs/remotes/origin/shared/*,
    dropping ones deleted there. The repository is public: no token is
    needed to read it, but one is used when there is."""
    out = subprocess.run(["git", "-C", str(store.root), "-c", "credential.helper=", "fetch",
                          "--quiet", "--prune", "origin",
                          "+refs/heads/shared/*:refs/remotes/origin/shared/*"],
                         capture_output=True, text=True, env=git_auth_env(token),
                         timeout=FETCH_TIMEOUT_S)
    if out.returncode != 0:
        raise HostError(_scrub(f"sync failed: {out.stderr.strip()}", token))


@router.get("/api/team")
def team(request: Request):
    return listing(request)


@router.post("/api/team/sync")
def sync(request: Request):
    from vhil.server.systems_write import _store
    try:
        fetch(_store(request), _token(request))
    except HostError as e:
        raise HTTPException(502, str(e))
    except subprocess.TimeoutExpired:
        raise HTTPException(504, f"sync took longer than {FETCH_TIMEOUT_S} s")
    request.app.state.team_synced_at = time.time()
    return listing(request)


class Share(BaseModel):
    branch: str


@router.post("/api/team/share")
def share(body: Share, request: Request):
    """Push one of your shared/<you>/... branches to GitHub."""
    from vhil.server.systems_write import _host, _store
    me = login(request)
    if not me:
        raise HTTPException(409, "sign in with GitHub to share (the desktop app's Sign in)")
    if not body.branch.lower().startswith(mine(me).lower()):
        raise HTTPException(422, {"errors": [f"only your own branches are shared: "
                                             f"{mine(me)}<name>, not '{body.branch}'"]})
    store = _store(request)
    if store.rev(f"refs/heads/{body.branch}") is None:
        raise HTTPException(404, f"no saved branch '{body.branch}': save first")
    try:
        _host(request).push(store.root, body.branch)
    except HostUnavailable as e:
        raise HTTPException(409, str(e))
    except HostError as e:
        raise HTTPException(502, str(e))
    # What origin now has, without another fetch.
    store.git("update-ref", f"refs/remotes/origin/{body.branch}",
              store.rev(f"refs/heads/{body.branch}"))
    refs = _refs(store).get(body.branch, {})
    return item(store, body.branch, refs, me)
