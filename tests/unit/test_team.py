"""vhil.server.team: share, sync and list teammates' shared/<login>/... branches.

A throwaway bare remote seeded with this repo's catalogue and systems; a
teammate is a second clone that pushes to it. Share goes to a fake host.
"""
import shutil
import subprocess

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from vhil.server import create_app  # noqa: E402
from vhil.server.config import Settings  # noqa: E402
from vhil.server.githost import FakeGitHost  # noqa: E402
from vhil.server.team import owner_of  # noqa: E402
from vhil.system import REPO  # noqa: E402


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=seed", "-c",
                           "user.email=seed@example.com", *args],
                          check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.delenv("VHIL_TEAM_LOGIN", raising=False)
    seed = tmp_path / "seed"
    for d in ("catalog", "systems"):
        shutil.copytree(REPO / d, seed / d)
    git(seed, "init", "-q", "-b", "dev")
    git(seed, "add", ".")
    git(seed, "commit", "-q", "-m", "seed")
    bare = tmp_path / "remote.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(bare)], check=True)
    ws = tmp_path / "ws"
    subprocess.run(["git", "clone", "-q", str(bare), str(ws)], check=True)
    app = create_app(Settings(workspace=ws, db=tmp_path / "vhil.db", results=tmp_path / "runs",
                              auth="dev"))
    host = FakeGitHost()
    host.token = "test-token"
    app.state.git_host = host
    app.state.team_login = "raul"
    return type("Env", (), dict(client=TestClient(app), app=app, ws=ws, bare=bare, host=host,
                                tmp=tmp_path))


def teammate_shares(env, branch="shared/ines/ams-faster", files=None):
    """A teammate's clone commits `files` on `branch` and pushes it."""
    other = env.tmp / "ines"
    if not other.exists():
        subprocess.run(["git", "clone", "-q", str(env.bare), str(other)], check=True)
    git(other, "switch", "-q", "-c", branch, "origin/dev")
    for path, text in (files or {"systems/ams.yaml":
                                 (other / "systems/ams.yaml").read_text() + "\n# ines\n"}).items():
        (other / path).parent.mkdir(parents=True, exist_ok=True)
        (other / path).write_text(text)
        git(other, "add", path)
    git(other, "commit", "-q", "-m", "feat: ines's change")
    git(other, "push", "-q", "origin", branch)
    git(other, "switch", "-q", "dev")
    return branch


def test_branch_owner():
    assert owner_of("shared/ines/ams") == "ines"
    assert owner_of("shared/ines/a/b") == "ines"
    assert owner_of("shared/ines") is None
    assert owner_of("feat/x") is None
    assert owner_of("shared/-bad/x") is None


def test_sync_lists_a_teammates_systems_and_catalogue(env):
    teammate_shares(env, files={
        "systems/ams.yaml": (env.ws / "systems/ams.yaml").read_text() + "\n# ines\n",
        "catalog/models/new-part.yaml": "id: new-part\n"})
    git(env.bare, "branch", "feat/not-shared", "dev")
    assert env.client.get("/api/team").json()["items"] == []     # nothing until a sync
    out = env.client.post("/api/team/sync").json()
    assert out["me"] == "raul" and out["prefix"] == "shared/raul/" and out["can_share"]
    assert out["synced_at"]
    [it] = out["items"]
    assert it["branch"] == "shared/ines/ams-faster" and it["owner"] == "ines"
    assert not it["mine"] and it["state"] == "remote" and it["behind"] == 0
    assert it["systems"] == ["ams"] and it["catalog"] == ["catalog/models/new-part.yaml"]
    # It opens in the editor from the teammate's branch.
    flow = env.client.get("/api/systems/ams/dataflow", params={"branch": it["branch"]}).json()
    assert flow["ref"] == it["sha"] and flow["yaml"].endswith("# ines\n")


def test_sync_drops_a_branch_deleted_on_github(env):
    branch = teammate_shares(env)
    assert len(env.client.post("/api/team/sync").json()["items"]) == 1
    git(env.bare, "branch", "-D", branch)
    assert env.client.post("/api/team/sync").json()["items"] == []


def save(env, branch, base=None, note="raul"):
    body = {"yaml": (env.ws / "systems/ams.yaml").read_text() + f"\n# {note}\n",
            "message": "feat(systems): tweak ams", "branch": branch}
    if base:
        body["base"] = base
    r = env.client.put("/api/systems/ams", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_save_then_share_your_own_branch(env):
    save(env, "shared/raul/ams-tweak")
    [it] = env.client.get("/api/team").json()["items"]
    assert it["mine"] and it["state"] == "local" and it["systems"] == ["ams"]
    out = env.client.post("/api/team/share", json={"branch": "shared/raul/ams-tweak"}).json()
    assert env.host.pushed == ["shared/raul/ams-tweak"]
    assert out["state"] == "shared"
    save(env, "shared/raul/ams-tweak", note="raul, again")
    [it] = env.client.get("/api/team").json()["items"]
    assert it["state"] == "ahead"


def test_a_teammates_system_is_edited_on_your_own_branch(env):
    """Their branch never moves: the edit is a branch of yours on their commit."""
    branch = teammate_shares(env)
    [theirs] = env.client.post("/api/team/sync").json()["items"]
    save(env, "shared/raul/ams-from-ines", base=theirs["sha"])
    items = {i["branch"]: i for i in env.client.get("/api/team").json()["items"]}
    assert items[branch]["sha"] == theirs["sha"] and items[branch]["state"] == "remote"
    mine = items["shared/raul/ams-from-ines"]
    assert git(env.ws, "rev-parse", f"{mine['sha']}^") == theirs["sha"]


def test_only_your_own_branches_are_shared(env):
    branch = teammate_shares(env)
    env.client.post("/api/team/sync")
    r = env.client.post("/api/team/share", json={"branch": branch})
    assert r.status_code == 422 and env.host.pushed == []
    r = env.client.post("/api/team/share", json={"branch": "feat/x"})
    assert r.status_code == 422
    r = env.client.post("/api/team/share", json={"branch": "shared/raul/never-saved"})
    assert r.status_code == 404


def test_without_a_github_account_you_sync_but_dont_share(env):
    env.app.state.team_login = ""
    env.host.token = None
    teammate_shares(env)
    out = env.client.post("/api/team/sync").json()
    assert out["me"] is None and not out["can_share"] and len(out["items"]) == 1
    r = env.client.post("/api/team/share", json={"branch": "shared/raul/x"})
    assert r.status_code == 409
