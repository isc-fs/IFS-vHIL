// vHIL desktop app (#373): a window and a set-up wizard around `bin/vhil`.
//
// The app does no emulation itself. It keeps a checkout of the repository
// (the workspace: cloned by the app, or a developer's own clone), runs
// `bin/vhil` in it for checks, set-up and the web app, and shows the web app
// (`vhil ui`, http://localhost:8080) in its window. Everything the app does is
// a `bin/vhil` command a teammate could run by hand.
//
// Where `bin/vhil` runs (`Host`):
//   macOS, Linux  natively: the workspace is a local path, Docker is Colima
//                 (macOS) or Docker Engine (Linux).
//   Windows       inside WSL2 (`wsl.exe`): `bin/vhil` is bash, so the
//                 workspace is a path in the default WSL distribution and
//                 Docker is Docker Desktop's WSL integration (or an engine in
//                 the distribution). WSL forwards localhost:8080 to Windows.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_updater::UpdaterExt;

const REPO_URL: &str = "https://github.com/isc-fs/IFS-vHIL.git";
const APP_URL: &str = "http://localhost:8080/";
const APP_ADDR: &str = "127.0.0.1:8080";
const UI_TIMEOUT: Duration = Duration::from_secs(300);

const PLATFORM: &str = if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(windows) {
    "windows"
} else {
    "linux"
};
const WSL: bool = cfg!(windows);

/// The ref an app-managed workspace follows: a release build's tag (set at
/// build time, `VHIL_APP_REF=vX.Y.Z`), else `dev`.
fn workspace_ref() -> &'static str {
    option_env!("VHIL_APP_REF").unwrap_or("dev")
}

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    /// A developer's own clone (a WSL path on Windows). None: the app's own.
    workspace: Option<String>,
    /// The ref the app's own clone was last moved to. After an update the
    /// app's ref is newer, and the set-up page moves the clone first.
    #[serde(default)]
    synced_ref: Option<String>,
}

#[derive(Default)]
struct AppState {
    /// One long task at a time (install, clone, set-up, VM).
    busy: Mutex<bool>,
    /// `bin/vhil ui`, while the app's containers are up.
    ui: Mutex<Option<Child>>,
}

// --- processes ----------------------------------------------------------------

/// A GUI app on macOS starts with launchd's PATH, which has neither Homebrew
/// nor /usr/local: put them first so docker, colima, git and brew resolve.
fn search_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    if cfg!(windows) {
        return base;
    }
    format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{base}")
}

/// A command with the app's PATH and, on Windows, no console window.
fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(program);
    c.env("PATH", search_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// A POSIX shell script with arguments ($1, $2, ...), natively or in WSL.
fn shell(script: &str, args: &[&str]) -> Command {
    let mut c = if WSL {
        let mut c = command("wsl.exe");
        c.args(["-e", "sh", "-c", script, "sh"]);
        c
    } else {
        let mut c = command("/bin/sh");
        c.args(["-c", script, "sh"]);
        c
    };
    c.args(args);
    c
}

/// `bin/vhil <args>` in the workspace.
fn vhil(ws: &str, args: &[&str]) -> Command {
    let mut c = if WSL {
        let mut c = command("wsl.exe");
        c.args(["--cd", ws, "-e", "./bin/vhil"]);
        c
    } else {
        let mut c = command(Path::new(ws).join("bin/vhil"));
        c.current_dir(ws);
        c
    };
    c.args(args);
    c
}

fn succeeds(mut c: Command) -> bool {
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c.status().map(|s| s.success()).unwrap_or(false)
}

/// A tool where `bin/vhil` runs (in WSL on Windows).
fn has_tool(tool: &str) -> bool {
    if WSL {
        return succeeds(shell("command -v \"$1\"", &[tool]));
    }
    search_path().split(':').any(|d| Path::new(d).join(tool).is_file())
}

fn wsl_ready() -> bool {
    WSL && succeeds(shell("true", &[]))
}

fn open_url(url: &str) -> Result<(), String> {
    let mut c = if cfg!(target_os = "macos") {
        command("open")
    } else if cfg!(windows) {
        let mut c = command("cmd.exe");
        c.args(["/C", "start", ""]);
        c
    } else {
        command("xdg-open")
    };
    c.arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// --- settings and the workspace -----------------------------------------------

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

/// The app's own clone: its data directory, or ~/IFS-vHIL in WSL (the WSL
/// filesystem: bash scripts, LF line endings and fast file access).
fn managed_workspace(app: &AppHandle) -> Result<String, String> {
    if WSL {
        static HOME: OnceLock<Option<String>> = OnceLock::new();
        let home = HOME.get_or_init(|| {
            let out = shell("printf %s \"$HOME\"", &[]).output().ok()?;
            let h = String::from_utf8(out.stdout).ok()?;
            (out.status.success() && h.starts_with('/')).then_some(h)
        });
        return home
            .as_ref()
            .map(|h| format!("{h}/IFS-vHIL"))
            .ok_or_else(|| "WSL is not set up: install it first".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("IFS-vHIL");
    Ok(dir.to_string_lossy().into_owned())
}

fn workspace(app: &AppHandle) -> Result<String, String> {
    match load_settings(app).workspace {
        Some(p) => Ok(p),
        None => managed_workspace(app),
    }
}

fn is_checkout(ws: &str) -> bool {
    if WSL {
        return succeeds(shell("test -x \"$1/bin/vhil\"", &[ws]));
    }
    Path::new(ws).join("bin/vhil").is_file()
}

// --- long tasks ---------------------------------------------------------------

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
fn spawn_task(app: &AppHandle, task: &str, cmd: Command) -> Result<(), String> {
    spawn_task_then(app, task, cmd, |_| {})
}

/// spawn_task, and `ok` runs (before the `done` event) when the task succeeds.
fn spawn_task_then(
    app: &AppHandle,
    task: &str,
    mut cmd: Command,
    ok: impl FnOnce(&AppHandle) + Send + 'static,
) -> Result<(), String> {
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
        if code == 0 {
            ok(&app);
        }
        *app.state::<AppState>().busy.lock().unwrap() = false;
        let _ = app.emit("done", Done { task, code });
    });
    Ok(())
}

// --- commands -----------------------------------------------------------------

#[derive(Serialize)]
struct Info {
    version: &'static str,
    platform: &'static str,
    workspace: Option<String>,
    managed: bool,
    present: bool,
    /// The app's own clone is at the app's ref (always true for your own clone).
    synced: bool,
    workspace_ref: &'static str,
    tools: Tools,
}

#[derive(Serialize)]
struct Tools {
    /// Windows: WSL installed with a distribution that starts.
    wsl: bool,
    git: bool,
    docker: bool,
    colima: bool,
    brew: bool,
}

#[tauri::command]
async fn info(app: AppHandle) -> Result<Info, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let wsl = wsl_ready();
        let usable = !WSL || wsl;
        let ws = if usable { workspace(&app).ok() } else { None };
        let settings = load_settings(&app);
        Ok(Info {
            synced: settings.workspace.is_some()
                || settings.synced_ref.as_deref() == Some(workspace_ref()),
            version: env!("CARGO_PKG_VERSION"),
            platform: PLATFORM,
            present: ws.as_deref().map(is_checkout).unwrap_or(false),
            managed: settings.workspace.is_none(),
            workspace: ws,
            workspace_ref: workspace_ref(),
            tools: Tools {
                wsl,
                git: usable && has_tool("git"),
                docker: usable && has_tool("docker"),
                colima: cfg!(target_os = "macos") && has_tool("colima"),
                brew: cfg!(target_os = "macos") && has_tool("brew"),
            },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// None: back to the app's own clone.
#[tauri::command]
async fn set_workspace(app: AppHandle, path: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = match path.map(|p| p.trim().trim_end_matches('/').to_string()).filter(|p| !p.is_empty()) {
            Some(p) => {
                if !is_checkout(&p) {
                    return Err(format!("{p} has no bin/vhil: not a vHIL checkout"));
                }
                Some(p)
            }
            None => None,
        };
        let mut s = load_settings(&app);
        s.workspace = workspace;
        save_settings(&app, &s)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `bin/vhil doctor --json`.
#[tauri::command]
async fn doctor(app: AppHandle) -> Result<serde_json::Value, String> {
    let ws = workspace(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = vhil(&ws, &["doctor", "--json"]).output().map_err(|e| e.to_string())?;
        serde_json::from_slice(&out.stdout)
            .map_err(|_| format!("doctor: {}", String::from_utf8_lossy(&out.stderr).trim()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The long tasks: `tools` (macOS: Homebrew installs colima and docker),
/// `workspace` (clone, or move the app's clone to its ref), `vm` (macOS) and
/// `setup`.
#[tauri::command]
fn run(app: AppHandle, task: String) -> Result<(), String> {
    let cmd = match task.as_str() {
        "tools" => {
            if !cfg!(target_os = "macos") {
                return Err("install the tools as the set-up page says".into());
            }
            let mut c = command("brew");
            c.args(["install", "colima", "docker"]);
            c
        }
        "workspace" => {
            if load_settings(&app).workspace.is_some() {
                return Err("the workspace is your own clone: update it with git".into());
            }
            let ws = managed_workspace(&app)?;
            // A tag or a branch, always detached: nobody commits in the app's clone.
            shell(
                r#"set -e
                if [ ! -d "$1/.git" ]; then
                    mkdir -p "$(dirname "$1")"
                    git clone --quiet "$2" "$1"
                fi
                cd "$1"
                git fetch --quiet --tags origin
                git -c advice.detachedHead=false checkout --detach "origin/$3" 2>/dev/null \
                    || git -c advice.detachedHead=false checkout --detach "$3"
                git log --oneline -1"#,
                &[&ws, REPO_URL, workspace_ref()],
            )
        }
        "vm" => vhil(&workspace(&app)?, &["vm"]),
        "setup" => vhil(&workspace(&app)?, &["setup"]),
        _ => return Err(format!("unknown task {task}")),
    };
    if task == "workspace" {
        return spawn_task_then(&app, &task, cmd, |app| {
            let mut s = load_settings(app);
            s.synced_ref = Some(workspace_ref().to_string());
            let _ = save_settings(app, &s);
        });
    }
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
        let _ = app.emit("done", Done { task: "ui".into(), code: 0 });
        return Ok(());
    }
    let ws = workspace(&app)?;
    let state: State<AppState> = app.state();
    let mut ui = state.ui.lock().unwrap();
    let running = ui.as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false);
    if !running {
        let mut child = vhil(&ws, &["ui", "--no-browser"])
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

#[derive(Serialize)]
struct Update {
    version: String,
    notes: Option<String>,
}

/// A newer release on the team's update channel (iskapps' vhil/latest.json),
/// or None: none, offline, or no manifest yet. Never an error to the page.
#[tauri::command]
async fn check_update(app: AppHandle) -> Option<Update> {
    let update = app.updater().ok()?.check().await.ok()??;
    Some(Update { version: update.version.clone(), notes: update.body.clone() })
}

/// Downloads the update, checks its signature against the key built into
/// the app (tauri.conf.json), installs it and restarts. The app's containers
/// stop first; the clone moves to the new ref on the next start.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("no update")?;
    let stop = app.clone();
    tauri::async_runtime::spawn_blocking(move || stop_containers(&stop)).await.map_err(|e| e.to_string())?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

/// Links `vhil` where a terminal finds it: Homebrew's bin on macOS,
/// ~/.local/bin on Linux and in WSL.
#[tauri::command]
async fn install_cli(app: AppHandle) -> Result<String, String> {
    let ws = workspace(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !is_checkout(&ws) {
            return Err("download the vHIL first".into());
        }
        let dirs: &[&str] = if cfg!(target_os = "macos") {
            &["/opt/homebrew/bin", "/usr/local/bin"]
        } else {
            &["$HOME/.local/bin"]
        };
        for dir in dirs {
            let script = format!(
                "d=\"{dir}\"; mkdir -p \"$d\" 2>/dev/null; [ -w \"$d\" ] && ln -sf \"$1/bin/vhil\" \"$d/vhil\" && printf %s \"$d\""
            );
            let out = shell(&script, &[&ws]).output().map_err(|e| e.to_string())?;
            if out.status.success() {
                let d = String::from_utf8_lossy(&out.stdout).into_owned();
                let where_ = if WSL { " (in WSL)" } else { "" };
                return Ok(format!("`vhil` is in {d}{where_}: open a new terminal"));
            }
        }
        Err(format!("no writable bin directory: add {ws}/bin to your PATH"))
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- window, menu, quit -------------------------------------------------------

/// The bundled set-up page, from the web app or anywhere else.
/// A download the vHIL's page starts (a run exported as a .vhilrun file,
/// vhil/server/bundle.py): saved to Downloads, never over another file, and
/// shown in the file manager when it is in.
fn on_download(app: AppHandle) -> impl Fn(tauri::Webview, tauri::webview::DownloadEvent) -> bool {
    let saving: Arc<Mutex<Option<PathBuf>>> = Arc::default();
    move |_, event| {
        use tauri::webview::DownloadEvent;
        match event {
            DownloadEvent::Requested { url, destination } => {
                let Ok(dir) = app.path().download_dir() else { return false };
                let name = destination
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .or_else(|| url.path_segments().and_then(|s| s.last()).map(str::to_string))
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "download".into());
                let path = free_path(&dir, &name);
                *destination = path.clone();
                *saving.lock().unwrap() = Some(path);
                true
            }
            DownloadEvent::Finished { success, .. } => {
                if let Some(path) = saving.lock().unwrap().take() {
                    if success {
                        reveal(&path);
                    }
                }
                true
            }
            _ => true,
        }
    }
}

/// dir/name, or dir/<stem> (2).<ext> and on while that exists.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Shows a file in the file manager (Linux: its folder).
fn reveal(path: &Path) {
    let mut c = if cfg!(target_os = "macos") {
        let mut c = command("open");
        c.arg("-R");
        c
    } else if cfg!(windows) {
        let mut c = command("explorer.exe");
        c.arg("/select,");
        c
    } else {
        command("xdg-open")
    };
    let target = if cfg!(any(target_os = "macos", windows)) {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    let _ = c.arg(target).spawn();
}

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
        if is_checkout(&ws) {
            let _ = succeeds(vhil(&ws, &["stop"]));
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            info,
            set_workspace,
            doctor,
            run,
            open_app,
            check_update,
            install_update,
            install_cli
        ])
        .setup(|app| {
            let handle = app.handle();
            // The window is built here (tauri.conf.json: create false) to
            // save the page's downloads (on_download). Its file drops go to
            // the page (dragDropEnabled false): the Runs list imports them.
            let conf = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("no main window in tauri.conf.json")?;
            tauri::WebviewWindowBuilder::from_config(handle, &conf)?
                .on_download(on_download(handle.clone()))
                .build()?;
            app.set_menu(menu(handle)?)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "setup" => show_setup(app),
                "app" => {
                    let _ = open_app(app.clone());
                }
                "browser" => {
                    let _ = open_url(APP_URL);
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
                        let _ = succeeds({
                            let mut c = command("colima");
                            c.args(["stop", "vhil"]);
                            c
                        });
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
