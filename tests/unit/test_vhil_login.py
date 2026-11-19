"""bin/vhil login | whoami | logout: GitHub's device flow against a fake
curl, the account file only its user can read."""
import os
import stat
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# GitHub, as curl sees it: a device code, one "pending" poll, then a token.
CURL = r"""#!/bin/sh
url=""; for a; do case $a in http*) url=$a;; esac; done
case $url in
*/login/device/code) echo "device_code=dev123&expires_in=60&interval=0&user_code=ABCD-1234&verification_uri=https%3A%2F%2Fgithub.com%2Flogin%2Fdevice" ;;
*/login/oauth/access_token)
    if [ -f "$STATE/polled" ]; then echo "access_token=gho_secret&scope=public_repo&token_type=bearer"
    else touch "$STATE/polled"; echo "error=authorization_pending"; fi ;;
*/user) printf '{\n  "login": "ines",\n  "id": 1\n}\n' ;;
*) exit 22 ;;
esac
"""


def vhil(tmp_path, *args, **env):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    (bindir / "curl").write_text(CURL)
    (bindir / "curl").chmod(0o755)
    e = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "STATE": str(tmp_path),
         "XDG_CONFIG_HOME": str(tmp_path / "config"), "VHIL_DEVICE_CLIENT_ID": "Iv1.test", **env}
    return subprocess.run(["bash", str(REPO / "bin/vhil"), *args], env=e,
                          capture_output=True, text=True, timeout=60)


def test_login_keeps_the_account_for_you_alone(tmp_path):
    r = vhil(tmp_path, "login")
    assert r.returncode == 0, r.stderr
    assert "Open https://github.com/login/device and enter ABCD-1234" in r.stdout
    assert "Signed in as ines" in r.stdout
    f = tmp_path / "config/vhil/github"
    assert f.read_text() == "login=ines\ntoken=gho_secret\n"
    assert stat.S_IMODE(f.stat().st_mode) == 0o600
    assert vhil(tmp_path, "whoami").stdout.strip() == "ines"
    assert vhil(tmp_path, "logout").returncode == 0 and not f.exists()
    assert vhil(tmp_path, "whoami").returncode == 1


def test_the_teams_oauth_app_is_the_default():
    """ISC vHIL, isc-fs's OAuth app (docs/team-store.md); empty means none."""
    assert ("device_client_id=${VHIL_DEVICE_CLIENT_ID-Ov23lijKjGq1XpuDCjJB}"
            in (REPO / "bin/vhil-account").read_text())


def test_the_app_signs_in_with_its_own_copy_outside_any_checkout(tmp_path):
    """The desktop app runs its built-in bin/vhil-account as `bash -c <script>`
    (main.rs account_cmd), so a clone from before vhil login still signs in."""
    main = (REPO / "app/src-tauri/src/main.rs").read_text()
    assert 'include_str!("../../../bin/vhil-account")' in main
    assert '"login" => account_cmd("login"),' in main
    script = (REPO / "bin/vhil-account").read_text()
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "curl").write_text(CURL)
    (bindir / "curl").chmod(0o755)
    env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "STATE": str(tmp_path),
           "XDG_CONFIG_HOME": str(tmp_path / "config")}
    env.pop("VHIL_DEVICE_CLIENT_ID", None)
    run = lambda verb: subprocess.run(["bash", "-c", script, "vhil-account", verb], env=env,  # noqa: E731
                                      cwd=tmp_path, capture_output=True, text=True, timeout=60)
    r = run("login")
    assert r.returncode == 0 and "Signed in as ines" in r.stdout, r.stderr
    assert run("whoami").stdout.strip() == "ines"
    assert run("token").stdout.strip() == "gho_secret"


def test_login_without_the_teams_oauth_app_says_so(tmp_path):
    r = vhil(tmp_path, "login", VHIL_DEVICE_CLIENT_ID="")
    assert r.returncode == 2 and "VHIL_DEVICE_CLIENT_ID" in r.stderr


def test_ui_hands_your_account_to_the_stack(tmp_path):
    """vhil ui exports the token and login vhil-account keeps, for compose."""
    cfg = tmp_path / "config/vhil"
    cfg.mkdir(parents=True)
    (cfg / "github").write_text("login=ines\ntoken=gho_secret\n")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "docker.log"
    (bindir / "docker").write_text(
        f'#!/bin/sh\necho "$* | $VHIL_TEAM_LOGIN $VHIL_GITHUB_TOKEN" >> {log}\n')
    (bindir / "docker").chmod(0o755)
    env = {k: v for k, v in os.environ.items() if k not in ("VHIL_GITHUB_TOKEN", "FW_LOCAL")}
    env.update({"PATH": f"{bindir}:{os.environ['PATH']}", "XDG_CONFIG_HOME": str(tmp_path / "config"),
                "VHIL_DOCKER_CONTEXT": "stub", "VHIL_WEB_PORT": "18998"})
    r = subprocess.run(["bash", str(REPO / "bin/vhil"), "ui", "--no-browser"], env=env,
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    up = [l for l in log.read_text().splitlines() if " up " in l]
    assert up and up[-1].endswith("| ines gho_secret"), up
