# pi-live-jobs

A small live panel above the [pi](https://pi.dev) editor that answers one question while you work:

> what did **this** session set running — the scripts pi started, and the systemd units and timers
> it started or invoked?

```
⚙ jobs 1 script · 1 unit  ctrl+shift+j
```

Press the shortcut (or run `/jobs`) to expand it:

```
⚙ jobs 3 scripts · 2 units · 1 timer · this session  ctrl+shift+j
  scripts
    ● 12s  npm run dev
      ● 12s  node bin/dev.js
    ↗ 4m   python3 worker.py · detached
  user units
    ● hdmi-autoconfig.service
    ● mc-chat-bridge.service
  timers
    ◷ marketpulse-scan.timer · in 12m
```

Units, timers and jobs are **session-scoped**: a row appears only when this session started the unit
or named it on a command line. A unit that was already running when the session began — started at
boot, or left behind by an earlier session — stays hidden, so the panel never mixes your sessions
together. `JOBS_UNIT_SCOPE` widens that if you do want machine-wide state.

The collapsed form is one line and sits next to pi-subagents' widget instead of fighting it for the
same space: both use `setWidget(..., { placement: "aboveEditor" })` with their own widget key
(`jobs` here, `agents` there), so collapsing or expanding one never moves the other.

## What it shows

| Section | Source | Notes |
|---|---|---|
| `scripts` | `/proc` | Live descendants of the pi process: tool commands, MCP servers, the servers and scripts you started. A `bash -lc "…"` wrapper with a single child is collapsed into that child, and absolute program paths are shortened to the program name. |
| `↗ … detached` | remembered pids, `PI_SESSION_ID` | A process pi started that outlived its parent (`nohup … &`). Recognised either by remembering the pid **and** start time (a reused pid is never shown as the old job) or by the session id in its environment, so a job that detached before the first poll is still found. |
| `user units` / `system units` | `systemctl` | Only units this session touched: one whose activation stamp (`ActiveEnterTimestampMonotonic`) falls inside the session, or one the session named on a command line (`systemctl start …`, `systemd-run --unit=…`, or an explicit `foo.service` / `foo.timer` token). Distribution units stay out either way. |
| `timers` | `systemctl list-timers` | Same session filter as the units, with the next elapse. |
| `jobs` | `systemctl list-jobs` | Queued/running jobs (`start`, `stop`, …) for units this session asked for. Usually empty. |

A process must have lived for `JOBS_MIN_AGE_MS` (default 400 ms) to get a row, so one-line commands
do not flicker through the panel. The expanded panel is capped at 13 lines; the header counts still
say what did not fit, and the sections are ordered by how quickly they change.

## What it does not do

Read-only. It polls `/proc` and asks `systemctl` for state; it never starts, stops, signals or kills
anything. There is no CPU/memory accounting, no history, and no remote host support — this is a
glance, not a process manager.

Every poll is independent and failures are swallowed: no systemd, a permission error or a missing
`/proc` entry simply means an empty section. The panel never interrupts a session.

## Install

```bash
pi install npm:pi-live-jobs        # after the npm release
pi install git:github.com/FurBlood344324/pi-live-jobs
pi install ./pi-live-jobs          # local checkout
```

Try it for one run without installing:

```bash
pi -e ./pi-live-jobs
```

Remove with `pi remove <source>`; reload running sessions with `/reload`.

## Usage

| Action | How |
|---|---|
| Expand / collapse | `ctrl+shift+j` (configurable) or `/jobs` |
| Keep the panel visible while idle | `/jobs on` |
| Hide it | `/jobs off` |
| Force a refresh + counts | `/jobs refresh` |
| One-line status (no widget) | `/jobs status` |

The widget disappears on its own when nothing is active; the expand/collapse choice is remembered
for the session. Polling runs every 3 s for the process tree and every 8 s for systemd state.

## Configuration

All optional, via environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `JOBS_KEY` | `ctrl+shift+j` | Toggle shortcut. Any pi key id (`alt+j`, `ctrl+shift+u`, …). |
| `JOBS_MIN_AGE_MS` | `400` | Minimum process age before it gets a row. |
| `JOBS_UNIT_SCOPE` | `session` | `session` = only units this session started or named · `owner` = every active unit whose file lives in your own systemd config · `all` = every active unit. |
| `JOBS_SYSTEM` | `1` | Include system-scope units from `/etc/systemd/system`. `0` = user scope only. |
| `JOBS_ALL_UNITS` | `0` | Legacy alias for `JOBS_UNIT_SCOPE=all`. |

```bash
JOBS_KEY=alt+j pi
```

## Compatibility

- Linux only (reads `/proc` and calls `systemctl`). On other platforms the extension loads and stays
  inert rather than erroring.
- pi-subagents: separate widget key and the same `aboveEditor` placement, so both widgets stack.
  No status-bar key is shared.
- No new transcript entries, no tool changes, no model context; the panel is pure UI.
- systemd **≥ 250** reports timers with their next elapse; older versions fall back to the plain table, so
timer rows show names only.
- Developed and tested against pi **1.4.0** (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`). Both are peer dependencies supplied by pi and deliberately not bundled.

## Development

```bash
bun test                           # parsing, ownership and session filter, layout (30 tests)
bun test/live.ts                   # real machine smoke check (spawns a sleep, prints the panel)
bunx tsc --noEmit -p tsconfig.json # typecheck against pi's real types
```

`node_modules/@earendil-works/*` in this checkout are symlinks to a local pi install; they are
gitignored and only exist for typecheck/tests.

## Release

Publishing runs in GitHub Actions with **OIDC trusted publishing** — no npm token is stored
anywhere. A `v*` tag is the only trigger:

```bash
npm version patch --no-git-tag-version   # bump package.json
git commit -am "0.1.1"
git push
git tag v0.1.1 && git push origin v0.1.1  # ← publishes
```

The workflow (`.github/workflows/publish.yml`) fails if the tag and `package.json` version disagree,
runs `bun install && bun test`, then publishes with provenance. Pre-release versions (`-rc.1`) go to
the `next` dist-tag.

The first release of a **new** package name still needs one authenticated publish (or an
`npm trust github pi-live-jobs --repo FurBlood344324/pi-live-jobs --file publish.yml --allow-publish`
after that publish). After the trusted publisher is registered, tags are enough.

## License

MIT
