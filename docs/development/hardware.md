# Hardware: what a laptop needs to run the tests

Measured with `scripts/hw-profile.sh` on two hosts. Both ran every job in its
own container through `scripts/vhil-docker.sh`, as a teammate runs them
([setup.md](setup.md#docker-any-host-nothing-installed-natively)).

- **GitHub runner:** `ubuntu-latest`, x86-64, 4 cores, 16 GB
  ([run 43664754282](https://github.com/isc-fs/IFS-vHIL/actions/runs/43664754282),
  `dev` at ad60240).
- **M1 Max laptop:** 10 cores, Docker Desktop, aarch64.

## Spec

| | Minimum | Recommended |
|---|---|---|
| CPU | 2 cores, x86-64 or Apple silicon | 4 or more cores |
| RAM | 8 GB | 16 GB |
| Docker VM (macOS, Windows) | 2 CPUs, 4 GB | 4 CPUs, 8 GB (the `vm` default is 8 / 8) |
| Free disk | 20 GB, SSD | 40 GB, SSD |

Why:

- **CPU.** A test job runs one emulator at a time and keeps about 1.3–1.9
  cores busy (peaks to about 3.5). A second core makes it 1.1× faster on
  the runner and 1.3–1.8× on the laptop. Above 2 cores a single job gains
  little: `sim` ECU + AMS drops from 44 s to 34 s at 4 cores, the smoke
  suites not at all. Only the firmware
  build uses all cores. The extra cores in the recommended spec are for
  everything else open at the same time: an editor, a browser, the system
  editor or the web app.
- **RAM.** No test job's working set exceeds 1.1 GB. The firmware build is
  the largest at 1.6 GB. `memory.peak` is a little higher because it counts
  page cache the kernel can drop. A 4 GB VM leaves room for the guest OS and
  Docker. 8 GB on the host is enough for the tests alone; 16 GB is
  comfortable alongside an IDE and a browser. Until #408 the whole `sim` run
  peaked at 6.7 GB; it now peaks at its heaviest file.
- **Disk.** One checkout's images are 3.5 GB (`ifs-vhil`) plus 1.9 GB that
  the editor image doesn't share with it. Every image key you use (a branch
  that changes `docker/`, a release) adds another set until you prune it
  (`docker image prune`). The `vhil-data` volume (IFS_HIL checkout, firmware
  builds) is about 0.4 GB. 20 GB holds two image sets; the Colima VM's disk
  is 40 GB.
- **vcan.** IFS_HIL's suites (`ifs-hil`) need the kernel's vcan module.
  Docker Desktop's kernel has none, so on macOS use the Colima VM
  (`scripts/vhil-docker.sh vm`). On Linux, load vcan. Every other job also
  runs on Docker Desktop (`VHIL_DOCKER_CONTEXT=desktop-linux`).

## Measurements

Times are wall clock. "Cores busy" is the container's CPU time per second:
the mean over the job, and the 95th percentile and maximum over 0.5 s
samples. "Working set" is `memory.current` minus inactive page cache, as
`docker stats` shows it.

### GitHub runner (x86-64, 4 cores)

Every suite once, with every core:

| Job | Wall | CPU time | Cores busy (mean / p95 / max) | Working set peak | memory.peak |
|---|---:|---:|---|---:|---:|
| `fw ecu ams udv` | 32 s | 86 s | 2.7 / 4.0 / 4.0 | 1.56 GB | 1.66 GB |
| `unit` | 1.7 min | 86 s | 0.8 / 1.0 / 1.0 | 0.44 GB | 0.63 GB |
| `scenarios` | 4.4 min | 8.3 min | 1.9 / 2.4 / 3.5 | 0.48 GB | 0.51 GB |
| `sim` (695 tests) | 35.4 min | 56.7 min | 1.6 / 2.2 / 3.1 | 1.07 GB | 1.47 GB |
| `ifs-hil smoke` (ECU) | 1.8 min | 35 s | 0.3 / 0.4 / 1.8 | 0.33 GB | 0.37 GB |

The same jobs at 1, 2 and 4 cores (`VHIL_DOCKER_CPUS`), wall time:

| Job | 1 core | 2 cores | 4 cores | Working set peak |
|---|---:|---:|---:|---:|
| `smoke ecu` | 26 s | 24 s | 23 s | 0.51 GB |
| `smoke ams` | 28 s | 26 s | 26 s | 0.49 GB |
| `sim` ECU boot | 25 s | 23 s | 19 s | 0.89 GB |
| `sim` AMS boot | 17 s | 15 s | 12 s | 0.61 GB |
| `sim` ECU + AMS | 46 s | 44 s | 34 s | 0.38 GB |
| `sim` ECU + AMS + uDV | 7 s | 6 s | 6 s | 0.42 GB |

### M1 Max laptop (Docker Desktop, 10 cores)

| Job | Wall | Cores busy (mean / max) | Working set peak |
|---|---:|---|---:|
| `fw ecu ams udv` | 42 s | 2.5 / 9.9 | 1.31 GB |
| `unit` | 2.0 min | 0.8 / 1.0 | 0.41 GB |
| `scenarios` | 8.8 min | 1.5 / 5.1 | 0.51 GB |
| `sim` (695 tests, after #408) | 60.7 min | 1.3 / 3.5 | 1.07 GB |

The same jobs at 1 core vs 2 or more: 1.3–1.8× faster at 2, no gain above.
Run alone, each `tests/sim` file peaks at 0.3–1.05 GB; `test_debugger`
(two ECU + AMS systems alive at once) is the heaviest.

The whole `sim` run takes 1.7× as long here as on the runner. Profile your
own host before taking this laptop as the floor.

## Measure a host

```sh
VHIL_PROFILE_HOST=my-laptop scripts/hw-profile.sh all 1 2 4   # full + sweep: 52 min on the runner
VHIL_PROFILE_HOST=my-laptop scripts/hw-profile.sh files       # each tests/sim file in its own container
python3 scripts/hw-profile-report.py                          # tables of results/profile/*.jsonl
```

`scripts/cgroup-profile.py` records each job from inside its container.
Prefix any job with `VHIL_PROFILE=<label>` to profile it on its own. On
GitHub, dispatch **Hardware profile** (`.github/workflows/hw-profile.yml`) on
`dev`; its summary has the tables and its artifact the logs.
