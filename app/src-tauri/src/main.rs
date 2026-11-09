// vHIL desktop app (#373): a window and a set-up wizard around `bin/vhil`.
//
// The app does no emulation itself. It keeps a checkout of the repository
// (the workspace: cloned by the app, or a developer's own clone), runs
// `bin/vhil` in it for checks, set-up and the web app, and shows the web app
// (`vhil ui`, http://localhost:8080) in its window. Everything the app does is
// a `bin/vhil` command a teammate could run by hand.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const REPO_URL: &str = "https://github.com/isc-fs/IFS-vHIL.git";
const RELEASES_API: &str = "https://api.github.com/repos/isc-fs/IFS-vHIL/releases/latest";
const APP_URL: &str = "http://localhost:8080/";
const APP_ADDR: &str = "127.0.0.1:8080";
const UI_TIMEOUT: Duration = Duration::from_secs(300);

/// The ref an app-managed workspace follows: a release build's tag (set at
/// build time, `VHIL_APP_REF=vX.Y.Z`), else `dev`.
fn workspace_ref() -> &'static str {
    option_env!("VHIL_APP_REF").unwrap_or("dev")
}

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    /// A developer's own clone. None: the app's own, under its data directory.
    workspace: Option<PathBuf>,
}

#[derive(Default)]
struct AppState {
    /// One long task at a time (install, clone, set-up, VM).
    busy: Mutex<bool>,
    /// `bin/vhil ui`, while the app's containers are up.
    ui: Mutex<Option<Child>>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = settings_path(app)?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&p, serde_json::to_vec_pretty(s).unwrap()).map_err(|e| e.to_string())
}

fn managed_workspace(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("IFS-vHIL"))
}

fn workspace(app: &AppHandle) -> Result<PathBuf, String> {
    match load_settings(app).workspace {
        Some(p) => Ok(p),
        None => managed_workspace(app),
    }
}

/// A GUI app on macOS starts with launchd's PATH, which has neither Homebrew
/// nor /usr/local: put them first so docker, colima, git and brew resolve.
fn search_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{base}")
}

fn which(tool: &str) -> Option<PathBuf> {
    search_path()
        .split(':')
        .map(|d| Path::new(d).join(tool))
        .find(|p| p.is_file())
}

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(program);
    c.env("PATH", search_path());
    c
}

fn vhil(ws: &Path) -> Command {
    let mut c = command(ws.join("bin/vhil"));
    c.current_dir(ws);
    c
}

#[derive(Clone, Serialize)]
struct LogLine {
    task: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct Done {
    task: String,
    code: i32,
}

fn pipe_lines(app: AppHandle, task: String, out: impl Read + Send + 'static) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let _ = app.emit("log", LogLine { task: task.clone(), line });
        }
    })
}

/// Runs a long task in the background: each output line is a `log` event,
/// the end a `done` event with the exit code.
fn spawn_task(app: &AppHandle, task: &str, mut cmd: Command) -> Result<(), String> {
    let state: State<AppState> = app.state();
    {
        let mut busy = state.busy.lock().unwrap();
        if *busy {
            return Err("another task is running".into());
        }
        *busy = true;
    }
    let mut child = match cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => {
            *state.busy.lock().unwrap() = false;
            return Err(format!("{task}: {e}"));
        }
    };
    let out = pipe_lines(app.clone(), task.into(), child.stdout.take().unwrap());
    let err = pipe_lines(app.clone(), task.into(), child.stderr.take().unwrap());
    let (app, task) = (app.clone(), task.to_string());
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        let _ = (out.join(), err.join());
        *app.state::<AppState>().busy.lock().unwrap() = false;
        let _ = app.emit("done", Done { task, code });
    });
    Ok(())
}

#[derive(Serialize)]
struct Info {
    version: &'static str,
    workspace: PathBuf,
    managed: bool,
    present: bool,
    workspace_ref: &'static str,
    tools: Tools,
}

#[derive(Serialize)]
struct Tools {
    git: bool,
    docker: bool,
    colima: bool,
    brew: bool,
    mac: bool,
}

#[tauri::command]
fn info(app: AppHandle) -> Result<Info, String> {
    let ws = workspace(&app)?;
    Ok(Info {
        version: env!("CARGO_PKG_VERSION"),
        present: ws.join("bin/vhil").is_file(),
        managed: load_settings(&app).workspace.is_none(),
        workspace: ws,
        workspace_ref: workspace_ref(),
        tools: Tools {
            git: which("git").is_some(),
            docker: which("docker").is_some(),
            colima: which("colima").is_some(),
            brew: which("brew").is_some(),
            mac: cfg!(target_os = "macos"),
        },
    })
}

/// None: back to the app's own clone.
#[tauri::command]
fn set_workspace(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let workspace = match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        Some(p) => {
            let p = PathBuf::from(p);
            if !p.join("bin/vhil").is_file() {
                return Err(format!("{} has no bin/vhil: not a vHIL checkout", p.display()));
            }
            Some(p)
        }
        None => None,
    };
    save_settings(&app, &Settings { workspace })
}

/// `bin/vhil doctor --json`.
#[tauri::command]
async fn doctor(app: AppHandle) -> Result<serde_json::Value, String> {
    let ws = workspace(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = vhil(&ws).args(["doctor", "--json"]).output().map_err(|e| e.to_string())?;
        serde_json::from_slice(&out.stdout)
            .map_err(|_| format!("doctor: {}", String::from_utf8_lossy(&out.stderr).trim()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The long tasks: `tools` (Homebrew installs colima and docker), `workspace`
/// (clone, or move the app's clone to its ref), `vm` and `setup`.
#[tauri::command]
fn run(app: AppHandle, task: String) -> Result<(), String> {
    let ws = workspace(&app)?;
    let cmd = match task.as_str() {
        "tools" => {
            let mut c = command(which("brew").ok_or("Homebrew is not installed: https://brew.sh")?);
            c.args(["install", "colima", "docker"]);
            c
        }
        "workspace" => {
            let managed = load_settings(&app).workspace.is_none();
            if !managed {
                return Err("the workspace is your own clone: update it with git".into());
            }
            let mut c = command("/bin/sh");
            // A tag or a branch, always detached: nobody commits in the app's clone.
            c.args(["-c", r#"set -e
                if [ ! -d "$1/.git" ]; then
                    mkdir -p "$(dirname "$1")"
                    git clone --quiet "$2" "$1"
                fi
                cd "$1"
                git fetch --quiet --tags origin
                git -c advice.detachedHead=false checkout --detach "origin/$3" 2>/dev/null \
                    || git -c advice.detachedHead=false checkout --detach "$3"
                git log --oneline -1"#, "sh"]);
            c.arg(&ws).arg(REPO_URL).arg(workspace_ref());
            c
        }
        "vm" => {
            let mut c = vhil(&ws);
            c.arg("vm");
            c
        }
        "setup" => {
            let mut c = vhil(&ws);
            c.arg("setup");
            c
        }
        _ => return Err(format!("unknown task {task}")),
    };
    spawn_task(&app, &task, cmd)
}

/// The vHIL web app answers (through its proxy) once the api is up: 502 before.
fn app_answers() -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&APP_ADDR.parse().unwrap(), Duration::from_secs(1)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    if s.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    if s.read_exact(&mut head).is_err() {
        return false;
    }
    let status = String::from_utf8_lossy(&head[9..12]).to_string();
    matches!(status.as_bytes()[0], b'2' | b'3') || status == "401"
}

fn show_app(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(APP_URL.parse().unwrap());
    }
}

/// Starts `bin/vhil ui --no-browser` (unless it's up) and shows the web app
/// in the window once it answers.
#[tauri::command]
fn open_app(app: AppHandle) -> Result<(), String> {
    if app_answers() {
        show_app(&app);
        return Ok(());
    }
    let ws = workspace(&app)?;
    let state: State<AppState> = app.state();
    let mut ui = state.ui.lock().unwrap();
    let running = ui.as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false);
    if !running {
        let mut child = vhil(&ws)
            .args(["ui", "--no-browser"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("vhil ui: {e}"))?;
        pipe_lines(app.clone(), "ui".into(), child.stdout.take().unwrap());
        pipe_lines(app.clone(), "ui".into(), child.stderr.take().unwrap());
        *ui = Some(child);
    }
    let app = app.clone();
    thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < UI_TIMEOUT {
            if app_answers() {
                show_app(&app);
                let _ = app.emit("done", Done { task: "ui".into(), code: 0 });
                return;
            }
            let exited = app.state::<AppState>().ui.lock().unwrap().as_mut()
                .map(|c| !matches!(c.try_wait(), Ok(None))).unwrap_or(true);
            if exited {
                let _ = app.emit("done", Done { task: "ui".into(), code: 1 });
                return;
            }
            thread::sleep(Duration::from_secs(1));
        }
        let _ = app.emit("done", Done { task: "ui".into(), code: 2 });
    });
    Ok(())
}

/// The latest release's tag, or None when there is none (or no network).
#[tauri::command]
async fn latest_release() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = command("curl").args(["-fsSL", "-m", "5", RELEASES_API]).output().ok()?;
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
        v.get("tag_name")?.as_str().map(str::to_string)
    })
    .await
    .ok()
    .flatten()
}

/// A release's page in the browser (the update banner's link).
#[tauri::command]
fn open_release(tag: String) -> Result<(), String> {
    if !tag.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c)) {
        return Err(format!("bad tag {tag}"));
    }
    let url = format!("https://github.com/isc-fs/IFS-vHIL/releases/tag/{tag}");
    command("open").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Links `vhil` into the first writable directory on PATH that Homebrew or
/// the system uses, so a terminal finds the same CLI the app runs.
#[tauri::command]
fn install_cli(app: AppHandle) -> Result<String, String> {
    let target = workspace(&app)?.join("bin/vhil");
    if !target.is_file() {
        return Err("download the vHIL first".into());
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let dir = Path::new(dir);
        if !dir.is_dir() {
            continue;
        }
        let link = dir.join("vhil");
        let _ = std::fs::remove_file(&link);
        #[cfg(unix)]
        if std::os::unix::fs::symlink(&target, &link).is_ok() {
            return Ok(format!("`vhil` now runs {} ({})", target.display(), link.display()));
        }
    }
    Err(format!(
        "no writable bin directory: add {} to your PATH",
        target.parent().unwrap().display()
    ))
}

/// The bundled set-up page, from the web app or anywhere else.
fn show_setup(app: &AppHandle) {
    let url = if cfg!(windows) {
        "http://tauri.localhost/index.html?stay=1"
    } else {
        "tauri://localhost/index.html?stay=1"
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(url.parse().unwrap());
    }
}

/// On quit: stop the app's containers. The VM keeps running (a quick start
/// next time); the menu stops it.
fn stop_containers(app: &AppHandle) {
    if let Some(mut c) = app.state::<AppState>().ui.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    if let Ok(ws) = workspace(app) {
        if ws.join("bin/vhil").is_file() {
            let _ = vhil(&ws).arg("stop").stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let m = Menu::default(app)?;
    let vhil = Submenu::with_items(
        app,
        "vHIL",
        true,
        &[
            &MenuItem::with_id(app, "setup", "Set-up and Status", true, Some("CmdOrCtrl+,"))?,
            &MenuItem::with_id(app, "app", "Show the vHIL", true, Some("CmdOrCtrl+1"))?,
            &MenuItem::with_id(app, "browser", "Open in Browser", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "stop", "Stop the App's Containers", true, None::<&str>)?,
            &MenuItem::with_id(app, "stop-vm", "Stop the Docker VM", cfg!(target_os = "macos"), None::<&str>)?,
        ],
    )?;
    m.append(&vhil)?;
    Ok(m)
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            info,
            set_workspace,
            doctor,
            run,
            open_app,
            latest_release,
            open_release,
            install_cli
        ])
        .setup(|app| {
            let handle = app.handle();
            app.set_menu(menu(handle)?)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "setup" => show_setup(app),
                "app" => {
                    let _ = open_app(app.clone());
                }
                "browser" => {
                    let _ = command("open").arg(APP_URL).spawn();
                }
                "stop" => {
                    let app = app.clone();
                    thread::spawn(move || {
                        stop_containers(&app);
                        show_setup(&app);
                    });
                }
                "stop-vm" => {
                    let app = app.clone();
                    thread::spawn(move || {
                        stop_containers(&app);
                        let _ = command("colima").args(["stop", "vhil"]).status();
                        show_setup(&app);
                    });
                }
                _ => {}
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("vHIL app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_containers(app);
            }
        });
}
