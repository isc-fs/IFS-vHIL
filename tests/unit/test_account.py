"""vhil.server.account: the desktop's GitHub account, live, and the editor's sign-in.

Signing in or out changes what the running server does at once (no restart):
the account file is read on each use. The device flow runs against a fake
GitHub.
"""
import os
import stat
import subprocess

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from vhil.server import account, create_app  # noqa: E402
from vhil.server.config import Settings  # noqa: E402
from vhil.server.githost import GitHubHost, HostUnavailable  # noqa: E402


@pytest.fixture
def acct(tmp_path, monkeypatch):
    monkeypatch.delenv("VHIL_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("VHIL_TEAM_LOGIN", raising=False)
    f = tmp_path / "cfg" / "vhil" / "github"
    monkeypatch.setenv("VHIL_ACCOUNT_FILE", str(f))
    return f


@pytest.fixture
def client(tmp_path, acct):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    app = create_app(Settings(workspace=tmp_path, db=tmp_path / "vhil.db",
                              results=tmp_path / "runs", auth="dev"))
    return TestClient(app)


def test_the_file_wins_over_env_and_is_read_live(acct, monkeypatch):
    monkeypatch.setenv("VHIL_GITHUB_TOKEN", "env-token")
    assert account.token() == "env-token" and account.file_login() is None
    account.write("ines", "file-token")
    assert account.token() == "file-token" and account.file_login() == "ines"
    assert stat.S_IMODE(os.stat(acct).st_mode) == 0o600
    account.remove()
    assert account.token() == "env-token"


def test_a_bad_file_is_no_account(acct):
    acct.parent.mkdir(parents=True)
    acct.write_text("login=../evil\n")
    assert account.read() == {}


def test_sign_in_and_out_reach_the_running_server(client, acct):
    """No restart: can_open_pr and the push token follow the file."""
    assert client.get("/api/config").json()["can_open_pr"] is False
    host = client.app.state.git_host
    assert isinstance(host, GitHubHost)
    with pytest.raises(HostUnavailable, match="not signed in"):
        host._need_token()
    account.write("raul", "tok")
    assert client.get("/api/config").json()["can_open_pr"] is True
    assert host._need_token() == "tok"
    assert client.get("/api/team").json()["me"] == "raul"
    assert client.post("/api/team/logout").json() == {"me": None}
    assert not acct.exists()
    assert client.get("/api/team").json()["me"] is None


def test_health_says_which_commit_the_server_started_at(client):
    out = client.get("/api/health").json()
    assert "started_ref" in out and out["started_ref"] == out["workspace_ref"]  # "" before a commit


class Reply:
    def __init__(self, status=200, text="", data=None):
        self.status_code, self.text, self._data = status, text, data

    def json(self):
        return self._data


class FakeGitHub:
    """Device code, then pending once, then a token; /user says who."""

    def __init__(self, polls=("error=authorization_pending", "access_token=gho_x&token_type=bearer")):
        self.polls = list(polls)
        self.posts = []

    def post(self, url, data=None, **_):
        self.posts.append((url, data))
        if url.endswith("/login/device/code"):
            assert data["scope"] == "public_repo" and data["client_id"]
            return Reply(text="device_code=dev123&user_code=ABCD-1234&verification_uri="
                              "https%3A%2F%2Fgithub.com%2Flogin%2Fdevice&interval=5&expires_in=900")
        return Reply(text=self.polls.pop(0))

    def get(self, url, headers=None, **_):
        assert url.endswith("/user") and headers["Authorization"] == "Bearer gho_x"
        return Reply(data={"login": "ines"})


def run_flow(gh):
    flow = account.DeviceFlow(http=gh, sleep=lambda s: None)
    out = flow.start()
    assert out["state"] == "pending" and out["code"] == "ABCD-1234"
    assert out["uri"] == "https://github.com/login/device"
    for _ in range(100):
        if flow.state != "pending":
            break
        import time
        time.sleep(0.01)
    return flow


def test_device_flow_writes_the_account(acct):
    flow = run_flow(FakeGitHub())
    assert flow.status()["state"] == "done" and flow.login == "ines"
    assert account.read() == {"login": "ines", "token": "gho_x"}


def test_device_flow_denied_writes_nothing(acct):
    flow = run_flow(FakeGitHub(polls=("error=access_denied",)))
    assert flow.state == "failed" and "cancelled" in flow.error
    assert not acct.exists()


def test_login_endpoints(client, acct, monkeypatch):
    flow = account.DeviceFlow(http=FakeGitHub(), sleep=lambda s: None)
    client.app.state.device_flow = flow
    assert client.get("/api/team/login").json()["state"] == "idle"
    out = client.post("/api/team/login").json()
    assert out["code"] == "ABCD-1234"
    # A page elsewhere can't start or end a sign-in (the auth guard).
    r = client.post("/api/team/logout", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
