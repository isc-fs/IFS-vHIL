"""bin/vhil-clone: the desktop app's view of your own clone against GitHub.

A bare remote and two clones: a teammate pushes, yours falls behind; the app
runs the script as `bash -c <script>` (main.rs clone_cmd), as here.
"""
import subprocess

import pytest

from vhil.system import REPO

SCRIPT = (REPO / "bin/vhil-clone").read_text()


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.com",
                           *args], check=True, capture_output=True, text=True).stdout.strip()


def clone(*args):
    return subprocess.run(["bash", "-c", SCRIPT, "vhil-clone", *args], capture_output=True,
                          text=True, timeout=60)


def status(ws):
    r = clone("status", str(ws), "dev")
    assert r.returncode == 0, r.stderr
    return dict(line.split("=", 1) for line in r.stdout.splitlines())


def commit(ws, name):
    (ws / name).write_text(name)
    git(ws, "add", name)
    git(ws, "commit", "-q", "-m", name)


@pytest.fixture
def repos(tmp_path):
    seed = tmp_path / "seed"
    seed.mkdir()
    git(seed, "init", "-q", "-b", "dev")
    commit(seed, "a")
    bare = tmp_path / "remote.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(bare)], check=True)
    mine, theirs = tmp_path / "mine", tmp_path / "theirs"
    for d in (mine, theirs):
        subprocess.run(["git", "clone", "-q", str(bare), str(d)], check=True)
    return mine, theirs


def test_up_to_date(repos):
    mine, _ = repos
    assert status(mine) == {"branch": "dev", "fetched": "1", "upstream": "origin/dev",
                            "ahead": "0", "behind": "0"}


def test_behind_then_update_fast_forwards(repos):
    mine, theirs = repos
    commit(theirs, "b")
    git(theirs, "push", "-q")
    assert status(mine)["behind"] == "1"
    r = clone("update", str(mine))
    assert r.returncode == 0, r.stderr
    assert status(mine)["behind"] == "0" and (mine / "b").exists()


def test_diverged_is_left_alone(repos):
    mine, theirs = repos
    commit(theirs, "b")
    git(theirs, "push", "-q")
    commit(mine, "c")
    st = status(mine)
    assert (st["ahead"], st["behind"]) == ("1", "1")
    assert clone("update", str(mine)).returncode != 0  # no merge, ever
    assert not (mine / "b").exists()


def test_a_branch_merged_into_dev_offers_dev(repos):
    """The case that bit us: a clone left on a feature branch merged long ago."""
    mine, theirs = repos
    git(mine, "switch", "-q", "-c", "feat/x")
    commit(mine, "x")
    git(mine, "push", "-q", "-u", "origin", "feat/x")
    git(theirs, "pull", "-q")
    git(theirs, "fetch", "-q", "origin", "feat/x")
    git(theirs, "merge", "-q", "--no-ff", "-m", "merge", "FETCH_HEAD")
    commit(theirs, "y")
    git(theirs, "push", "-q")
    st = status(mine)
    assert st["branch"] == "feat/x" and st["behind"] == "0" and st["merged"] == "2"
    r = clone("switch", str(mine), "dev")
    assert r.returncode == 0, r.stderr
    assert git(mine, "branch", "--show-current") == "dev" and (mine / "y").exists()
    assert "merged" not in status(mine)


def test_dirty_and_detached(repos):
    mine, _ = repos
    (mine / "a").write_text("changed")
    assert status(mine)["dirty"] == "1"
    git(mine, "checkout", "-q", "--detach")
    assert status(mine) == {"detached": "1"}


def test_offline_still_answers(repos, tmp_path):
    mine, _ = repos
    git(mine, "remote", "set-url", "origin", str(tmp_path / "gone.git"))
    st = status(mine)
    assert "fetched" not in st and st["behind"] == "0"


def test_the_app_carries_its_own_copy():
    main = (REPO / "app/src-tauri/src/main.rs").read_text()
    assert 'include_str!("../../../bin/vhil-clone")' in main
    assert 'clone_cmd(&["update", &ws])' in main and 'clone_cmd(&["switch", &ws, BASE_BRANCH])' in main
    ui = (REPO / "app/ui/app.js").read_text()
    for task in ('task: "update-clone"', 'task: "switch-clone"', 'invoke("clone_status")'):
        assert task in ui


def test_the_app_never_auto_opens_its_copy_on_an_old_release():
    """After an app update its copy is still at the previous release. The
    page used to auto-open the vHIL as soon as doctor was green, and start()
    then skipped moving the copy (a task was running): a teammate's app ran
    v0.2.1's scripts under a v0.2.4 app. Auto-open now waits for the move."""
    ui = (REPO / "app/ui/app.js").read_text()
    assert "const cloneSettled = info.managed ? info.synced :" in ui
    assert 'if (info.managed && info.present && !info.synced && !running) runTask("workspace");' in ui
