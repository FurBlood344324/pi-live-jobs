/**
 * collect.ts — read-only snapshot of what pi is running and what systemd is running.
 *
 * Two sources, both observational: /proc for the live process tree under pi, and `systemctl`
 * queries for active units, timers and jobs. The collector never starts, stops or signals anything.
 *
 * "Scripts" are the processes pi itself spawned (the bash tool, long-running commands), plus the
 * ones that were pi's children earlier and later detached (`nohup … &`) — those are remembered by
 * pid and start time so a reused pid is never mistaken for the old process.
 *
 * Units, timers and jobs are session-scoped by default: a row appears only when this session started
 * the unit (systemd's activation stamp falls inside the session) or named it on a command line
 * (`systemctl start …`). Units left running by an earlier session, or started at boot, stay hidden —
 * the panel answers "what did *this* session set running", not "what is active on the machine".
 */
import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";

/** Linux USER_HZ; `starttime` in /proc/<pid>/stat is counted in these ticks. */
const CLK_TCK = 100;
const EXEC_TIMEOUT_MS = 2000;
const MAX_BUFFER = 4 << 20;
/** Unit/timer/job lists change slowly; scripts are re-read on every poll. */
export const UNIT_REFRESH_MS = 8_000;
/** A process must have lived this long to be worth a row. */
export const DEFAULT_MIN_AGE_MS = 400;

export type Scope = "user" | "system";

/**
 * Which systemd units the panel is allowed to show:
 *   "session" — only units this pi session started or invoked (the default), so units left over from
 *               an earlier session or from boot do not clutter the panel;
 *   "owner"   — every active unit whose unit file lives in the user's own systemd config;
 *   "all"     — every active unit, distribution units included.
 */
export type UnitScope = "session" | "owner" | "all";

/** What `systemctl show` reports for one unit. */
export interface UnitInfo {
	fragmentPath?: string;
	/** Symlink target of the fragment path; dotfile-managed units resolve outside the config dir. */
	realPath?: string;
	/** `ActiveEnterTimestampMonotonic` in µs since boot; undefined when systemd does not report it. */
	activeMonoUs?: number;
}

export interface ScriptJob {
	pid: number;
	ppid: number;
	depth: number;
	command: string;
	elapsedMs: number;
	state: string;
	/** Was pi's child once, now reparented (nohup … &). */
	detached?: boolean;
}

export interface SystemdUnit {
	unit: string;
	scope: Scope;
}

export interface SystemdTimer {
	unit: string;
	scope: Scope;
	/** Epoch milliseconds of the next elapse, null when systemd reports none. */
	nextAt: number | null;
	activates?: string;
}

export interface SystemdJob {
	job: string;
	unit: string;
	type: string;
	state: string;
	scope: Scope;
}

export interface Snapshot {
	at: number;
	scripts: ScriptJob[];
	units: SystemdUnit[];
	timers: SystemdTimer[];
	jobs: SystemdJob[];
	/** How the unit/timer sections were filtered, so the panel can say so. */
	unitScope?: UnitScope;
}

export interface ProcInfo {
	pid: number;
	ppid: number;
	state: string;
	comm: string;
	startTicks: number;
	argv: string[];
}

export interface Remembered {
	startTicks: number;
	command: string;
}

// ---- /proc parsing ----

/**
 * Parse one /proc/<pid>/stat line. The comm field may contain spaces and parentheses, so fields
 * are read from the last ')' instead of splitting the whole line.
 */
export function parseStat(raw: string): Pick<ProcInfo, "comm" | "state" | "ppid" | "startTicks"> | undefined {
	const open = raw.indexOf("(");
	const close = raw.lastIndexOf(")");
	if (open < 0 || close < open) return undefined;
	const comm = raw.slice(open + 1, close);
	const fields = raw.slice(close + 1).trim().split(/\s+/);
	const state = fields[0];
	const ppid = Number(fields[1]);
	// Fields 3.. state=0, ppid=1, …, starttime (field 22) = index 19.
	const startTicks = Number(fields[19]);
	if (!state || !Number.isFinite(ppid) || !Number.isFinite(startTicks)) return undefined;
	return { comm, state, ppid, startTicks };
}

export function elapsedMs(startTicks: number, uptimeSec: number): number {
	return Math.max(0, Math.round(uptimeSec * 1000 - (startTicks / CLK_TCK) * 1000));
}

const SHELL_NAMES = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish", "busybox"]);

function shellCommandIndex(argv: string[]): number {
	if (argv.length < 2) return -1;
	const name = basename(argv[0]).replace(/^-/, "");
	if (!SHELL_NAMES.has(name)) return -1;
	return argv.findIndex((arg, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
}

/** True for `bash -lc …` style wrappers, whose argv hides the interesting command. */
export function isShellWrapper(argv: string[]): boolean {
	return shellCommandIndex(argv) >= 0;
}

/**
 * The interesting part of argv: a shell wrapper is reduced to the command it was asked to run, and
 * an absolute program path is shown by its name so long paths do not eat the row.
 */
export function commandText(argv: string[]): string {
	if (argv.length === 0) return "";
	const at = shellCommandIndex(argv);
	if (at >= 0) {
		const command = joinArgv(argv.slice(at + 1)).trim();
		if (command) return command;
	}
	return joinArgv(argv);
}

function joinArgv(argv: string[]): string {
	if (argv.length === 0) return "";
	const program = argv[0].startsWith("/") ? basename(argv[0]) : argv[0];
	return [program, ...argv.slice(1)].join(" ");
}

interface ProcTable {
	procs: Map<number, ProcInfo>;
	descendants: Set<number>;
	uptimeSec: number;
}

/** Read every pid, then read argv only for pi's descendants (reading all cmdlines would be noise). */
async function readProcTable(rootPid: number): Promise<ProcTable> {
	const [entries, uptimeRaw] = await Promise.all([readdir("/proc"), readFile("/proc/uptime", "utf8")]);
	const uptimeSec = Number.parseFloat(uptimeRaw) || 0;

	const stats = await Promise.all(
		entries
			.filter((name) => /^\d+$/.test(name))
			.map(async (name): Promise<ProcInfo | undefined> => {
				const pid = Number(name);
				try {
					const parsed = parseStat(await readFile(`/proc/${pid}/stat`, "utf8"));
					return parsed ? { pid, ...parsed, argv: [] } : undefined;
				} catch {
					return undefined; // exited between readdir and read
				}
			}),
	);

	const procs = new Map<number, ProcInfo>();
	for (const info of stats) if (info) procs.set(info.pid, info);

	const children = childMap(procs);
	const wanted = new Set<number>(children.get(rootPid) ?? []);
	const queue = [...wanted];
	while (queue.length > 0) {
		const pid = queue.pop() as number;
		for (const child of children.get(pid) ?? []) {
			if (wanted.has(child)) continue;
			wanted.add(child);
			queue.push(child);
		}
	}

	await Promise.all(
		[...wanted].map(async (pid) => {
			const info = procs.get(pid);
			if (!info) return;
			try {
				const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
				info.argv = raw.split("\0").filter((part) => part.length > 0);
			} catch {
				// exited between the two passes; empty argv renders as [pid]
			}
		}),
	);

	return { procs, descendants: wanted, uptimeSec };
}

function childMap(procs: Map<number, ProcInfo>): Map<number, number[]> {
	const children = new Map<number, number[]>();
	for (const info of procs.values()) {
		const list = children.get(info.ppid);
		if (list) list.push(info.pid);
		else children.set(info.ppid, [info.pid]);
	}
	for (const list of children.values()) list.sort((a, b) => a - b);
	return children;
}

/**
 * Depth-first list of live descendants of `rootPid`. A shell wrapper with exactly one child is
 * dropped in favour of that child, so `bash -lc "npm run dev"` does not add a duplicate row.
 */
export function buildScripts(
	procs: Map<number, ProcInfo>,
	rootPid: number,
	opts: { uptimeSec: number; minAgeMs: number; ignore?: ReadonlySet<number> },
): ScriptJob[] {
	const children = childMap(procs);
	const rows: ScriptJob[] = [];

	const walk = (parent: number, childDepth: number) => {
		for (const pid of children.get(parent) ?? []) {
			if (opts.ignore?.has(pid)) continue;
			const info = procs.get(pid);
			if (!info || info.state === "Z") continue;

			const kids = (children.get(pid) ?? []).filter((kid) => !opts.ignore?.has(kid));

			if (isShellWrapper(info.argv) && kids.length === 1) {
				walk(pid, childDepth); // single child inherits this row's depth
				continue;
			}

			const age = elapsedMs(info.startTicks, opts.uptimeSec);
			if (age >= opts.minAgeMs) {
				rows.push({
					pid,
					ppid: info.ppid,
					depth: childDepth,
					command: commandText(info.argv) || `[${info.comm}]`,
					elapsedMs: age,
					state: info.state,
				});
			}
			walk(pid, childDepth + 1);
		}
	};

	walk(rootPid, 1);
	return rows;
}

/**
 * Processes remembered as pi's that are still alive outside pi's process tree. Start time must
 * match, so a recycled pid is dropped instead of being shown as a stale job.
 */
export function detachedJobs(
	remembered: Map<number, Remembered>,
	procs: Map<number, ProcInfo>,
	inside: ReadonlySet<number>,
	uptimeSec: number,
): ScriptJob[] {
	const rows: ScriptJob[] = [];
	for (const [pid, record] of remembered) {
		if (inside.has(pid)) continue;
		const info = procs.get(pid);
		if (!info || info.startTicks !== record.startTicks || info.state === "Z") continue;
		rows.push({
			pid,
			ppid: info.ppid,
			depth: 1,
			command: record.command,
			elapsedMs: elapsedMs(info.startTicks, uptimeSec),
			state: info.state,
			detached: true,
		});
	}
	return rows;
}

// ---- systemd parsing ----

export function scopeArgs(scope: Scope): string[] {
	return scope === "user" ? ["--user"] : [];
}

const UNIT_SUFFIX = /\.(?:service|socket|timer|target|mount|automount|path|swap|slice|scope|device)$/;

/** Units from `list-units --output=json`; older systemd (no JSON output) falls back to the table. */
export function parseUnitNames(raw: string): string[] {
	const text = raw.trim();
	if (!text) return [];
	if (text.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (!Array.isArray(parsed)) return [];
			return parsed
				.map((row) => (row && typeof (row as { unit?: unknown }).unit === "string" ? (row as { unit: string }).unit : undefined))
				.filter((unit): unit is string => !!unit);
		} catch {
			return [];
		}
	}
	// Text table: "unit load active sub description", optionally prefixed with ●/○ markers.
	const units: string[] = [];
	for (const line of text.split("\n")) {
		for (const token of line.trim().split(/\s+/)) {
			if (UNIT_SUFFIX.test(token)) {
				units.push(token);
				break;
			}
		}
	}
	return units;
}

/**
 * Timers from `list-timers --output=json` (next/left/last/passed are microseconds). The text
 * fallback only yields unit names: without JSON there is no reliable locale-independent timestamp.
 */
export function parseTimers(raw: string): Omit<SystemdTimer, "scope">[] {
	const text = raw.trim();
	if (!text) return [];
	if (!text.startsWith("[")) {
		const timers: Omit<SystemdTimer, "scope">[] = [];
		for (const line of text.split("\n")) {
			const unit = line.trim().split(/\s+/).find((token) => token.endsWith(".timer"));
			if (unit) timers.push({ unit, nextAt: null });
		}
		return timers;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!Array.isArray(parsed)) return [];
		const timers: Omit<SystemdTimer, "scope">[] = [];
		for (const row of parsed) {
			if (!row || typeof (row as { unit?: unknown }).unit !== "string") continue;
			const record = row as { unit: string; next?: unknown; activates?: unknown };
			const next = Number(record.next);
			timers.push({
				unit: record.unit,
				nextAt: Number.isFinite(next) && next > 0 ? Math.round(next / 1000) : null,
				activates: typeof record.activates === "string" ? record.activates : undefined,
			});
		}
		return timers;
	} catch {
		return [];
	}
}

/** `systemctl list-jobs` text (JSON output is not produced for jobs by every systemd version). */
export function parseJobs(raw: string, scope: Scope): SystemdJob[] {
	const jobs: SystemdJob[] = [];
	for (const line of raw.split("\n")) {
		const text = line.trim();
		if (!text || /^JOB\s+UNIT\b/i.test(text) || /^No jobs running/i.test(text)) continue;
		const [job, unit, type, state] = text.split(/\s+/);
		if (!unit) continue;
		jobs.push({ job: job ?? "", unit, type: type ?? "", state: state ?? "", scope });
	}
	return jobs;
}

/**
 * Parse `systemctl show -p Id -p FragmentPath -p ActiveEnterTimestampMonotonic` output: units are
 * separated by blank lines, and every property line is optional (an inactive unit has a path but no
 * timestamp).
 */
export function parseUnitInfo(raw: string): Map<string, UnitInfo> {
	const infos = new Map<string, UnitInfo>();
	for (const block of raw.split(/\n\s*\n/)) {
		let id: string | undefined;
		const info: UnitInfo = {};
		for (const line of block.split("\n")) {
			const text = line.trim();
			if (text.startsWith("Id=")) id = text.slice("Id=".length);
			else if (text.startsWith("FragmentPath=")) info.fragmentPath = text.slice("FragmentPath=".length) || undefined;
			else if (text.startsWith("ActiveEnterTimestampMonotonic=")) {
				const value = Number(text.slice("ActiveEnterTimestampMonotonic=".length));
				if (Number.isFinite(value) && value > 0) info.activeMonoUs = value;
			}
		}
		if (id) infos.set(id, info);
	}
	return infos;
}

/** Verbs after which `systemctl` names the units it acts on. */
const SYSTEMCTL_VERBS = new Set([
	"start",
	"stop",
	"restart",
	"try-restart",
	"reload",
	"try-reload-or-restart",
	"reload-or-restart",
	"restart-or-reload",
	"enable",
	"disable",
	"reenable",
	"preset",
	"mask",
	"unmask",
	"isolate",
	"kill",
	"clean",
	"freeze",
	"thaw",
]);

const SEGMENT_BREAK = "\u0000";

/** Split a shell command line into words, keeping a marker where one command ends and the next begins. */
function commandWords(text: string): string[] {
	return text
		.replace(/[;&|()<>`"']/g, ` ${SEGMENT_BREAK} `)
		.split(/\s+/)
		.filter((word) => word.length > 0);
}

/** `mc-autopilot` → `mc-autopilot.service`, but a name that already carries a unit suffix is left alone. */
function asUnitName(word: string): string {
	const clean = word.replace(/^[-=]+/, "").replace(/,$/, "");
	return UNIT_SUFFIX.test(clean) ? clean : `${clean}.service`;
}

/**
 * Unit names a command line starts or otherwise acts on. Read-only is the point of this panel, so the
 * collector never runs these commands — it only watches the ones the agent asked for. Two shapes are
 * recognised: an explicit `<name>.service|timer|…` token anywhere in the line, and the units listed
 * after a `systemctl <verb>` / `systemd-run --unit=<name>`. `systemctl status`, `show` and
 * `list-units` activate nothing and are ignored.
 */
export function unitsInCommand(text: string): string[] {
	const found = new Set<string>();
	if (!text.trim()) return [];
	const words = commandWords(text);

	for (const word of words) {
		if (UNIT_SUFFIX.test(word.replace(/,$/, ""))) found.add(word.replace(/,$/, ""));
	}

	for (let index = 0; index < words.length; index += 1) {
		const program = basename(words[index].replace(/^[-=]+/, ""));
		const isRunner = program === "systemd-run";
		if (!isRunner && program !== "systemctl") continue;

		let verb: string | undefined;
		for (let cursor = index + 1; cursor < words.length; cursor += 1) {
			const word = words[cursor];
			if (word === SEGMENT_BREAK) break;
			if (word.startsWith("--unit=") || word.startsWith("-u=")) {
				found.add(asUnitName(word.slice(word.indexOf("=") + 1)));
				continue;
			}
			if (word.startsWith("-")) continue;
			if (!verb) {
				if (!SYSTEMCTL_VERBS.has(word)) break;
				verb = word;
				continue;
			}
			if (SYSTEMCTL_VERBS.has(word) || word === "--now") break;
			found.add(asUnitName(word));
		}
	}

	return [...found];
}

/**
 * Was the unit activated inside this session's window? Compares systemd's monotonic activation stamp
 * with the session start in the same boot-relative clock, so a wall-clock jump cannot mislead it.
 */
export function startedThisSession(info: UnitInfo | undefined, sessionMonoUs: number | undefined): boolean {
	if (!info || info.activeMonoUs === undefined || sessionMonoUs === undefined) return false;
	return info.activeMonoUs >= sessionMonoUs;
}

function execText(scope: Scope, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			"systemctl",
			[...scopeArgs(scope), ...args],
			{ timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" },
			(_error, stdout) => resolve(typeof stdout === "string" ? stdout : ""),
		);
	});
}

// ---- collector ----

/** Bash-tool commands carry the session id, which survives reparenting. */
export function hasSessionMarker(environ: string, sessionId: string | undefined): boolean {
	if (!sessionId) return false;
	return environ.split("\0").includes(`PI_SESSION_ID=${sessionId}`);
}

export interface CollectorOptions {
	rootPid?: number;
	home?: string;
	minAgeMs?: number;
	includeSystem?: boolean;
	/** Which units to show; `session` (the default) hides anything this session did not touch. */
	unitScope?: UnitScope;
	/** `Date.now()` when the session started; units activated later count as this session's. */
	sessionStartedAt?: number;
	/** Current pi session id, used to recognise detached bash-tool commands. */
	sessionId?: string;
	now?: () => number;
}

/**
 * A unit belongs to the user when its fragment lives in the user's systemd config (or, for the
 * system scope, in /etc/systemd/system) instead of a distribution package directory. Symlinked
 * dotfile units still count; aliases that resolve into /usr/lib are package units and are dropped.
 */
export function isOwnUnit(scope: Scope, reportedPath: string | undefined, resolvedPath: string | undefined, home: string): boolean {
	if (!reportedPath) return false;
	const roots = scope === "user"
		? [join(home, ".config/systemd"), join(home, ".local/share/systemd")]
		: ["/etc/systemd/system"];
	const under = (root: string, path: string) => path === root || path.startsWith(root + sep);
	if (!roots.some((root) => under(root, reportedPath))) return false;
	const target = resolvedPath ?? reportedPath;
	if (target.startsWith("/usr/lib/systemd") || target.startsWith("/usr/share/systemd")) return false;
	return true;
}

export function emptySnapshot(at = Date.now()): Snapshot {
	return { at, scripts: [], units: [], timers: [], jobs: [] };
}

/** `/proc/uptime` in seconds; 0 when it cannot be read (systemd timestamps are then unusable). */
async function readUptimeSec(): Promise<number> {
	try {
		return Number.parseFloat(await readFile("/proc/uptime", "utf8")) || 0;
	} catch {
		return 0;
	}
}

export class JobsCollector {
	private readonly opts: Required<Omit<CollectorOptions, "now" | "sessionId" | "sessionStartedAt">> & {
		now: () => number;
		sessionId?: string;
		sessionStartedAt?: number;
	};
	private readonly remembered = new Map<number, Remembered>();
	/** Pids whose /proc/<pid>/environ was already read; pruned when they exit. */
	private readonly envChecked = new Set<number>();
	/** Units named by this session's tool commands (`systemctl start …`), even if already active. */
	private readonly claimed = new Set<string>();
	/** Session start in the boot-relative monotonic clock systemd stamps activations with. */
	private sessionMonoUs?: number;
	private cache?: { at: number; units: SystemdUnit[]; timers: SystemdTimer[]; jobs: SystemdJob[] };

	/**
	 * Remember the units a tool command acted on. Called by the extension for every tool call, so a
	 * `systemctl start` that found the unit already running still counts as this session's.
	 */
	noteCommand(text: string): void {
		let changed = false;
		for (const unit of unitsInCommand(text)) {
			if (this.claimed.has(unit)) continue;
			this.claimed.add(unit);
			changed = true;
		}
		// A newly claimed unit should show up on the next poll, not after the 8 s unit cache.
		if (changed) this.cache = undefined;
	}

	constructor(options: CollectorOptions = {}) {
		this.opts = {
			rootPid: options.rootPid ?? process.pid,
			home: options.home ?? homedir(),
			minAgeMs: options.minAgeMs ?? DEFAULT_MIN_AGE_MS,
			includeSystem: options.includeSystem ?? true,
			unitScope: options.unitScope ?? "session",
			sessionStartedAt: options.sessionStartedAt,
			sessionId: options.sessionId,
			now: options.now ?? Date.now,
		};
	}

	async collect(force = false): Promise<Snapshot> {
		const at = this.opts.now();
		const { procs, descendants, uptimeSec } = await readProcTable(this.opts.rootPid);
		const scripts = buildScripts(procs, this.opts.rootPid, { uptimeSec, minAgeMs: this.opts.minAgeMs });
		this.remember(scripts, procs);
		await this.adoptSessionJobs(procs, descendants, uptimeSec);
		const detached = detachedJobs(this.remembered, procs, descendants, uptimeSec);

		const cached = this.cache;
		const systemd =
			!force && cached && at - cached.at < UNIT_REFRESH_MS
				? cached
				: { at, ...(await this.readSystemd()) };
		this.cache = systemd;

		return {
			at,
			scripts: [...scripts, ...detached],
			units: systemd.units,
			timers: systemd.timers,
			jobs: systemd.jobs,
			unitScope: this.opts.unitScope,
		};
	}

	private remember(rows: ScriptJob[], procs: Map<number, ProcInfo>): void {
		for (const row of rows) {
			const info = procs.get(row.pid);
			if (info) this.remembered.set(row.pid, { startTicks: info.startTicks, command: row.command });
		}
		for (const [pid, record] of this.remembered) {
			const info = procs.get(pid);
			if (!info || info.startTicks !== record.startTicks) this.remembered.delete(pid);
		}
	}

	/**
	 * Detect processes launched by the agent's bash tool that already left pi's process tree
	 * (`nohup … &`): their environment still names this session. Each pid is inspected once, which
	 * keeps the scan cheap — only newly appeared pids cost a read.
	 */
	private async adoptSessionJobs(procs: Map<number, ProcInfo>, descendants: Set<number>, uptimeSec: number): Promise<void> {
		if (!this.opts.sessionId) return;
		for (const pid of this.envChecked) if (!procs.has(pid)) this.envChecked.delete(pid);

		const rootStart = procs.get(this.opts.rootPid)?.startTicks ?? 0;
		const candidates: number[] = [];
		for (const info of procs.values()) {
			if (info.pid === this.opts.rootPid || info.state === "Z") continue;
			if (descendants.has(info.pid) || this.envChecked.has(info.pid)) continue;
			if (info.startTicks < rootStart) continue;
			candidates.push(info.pid);
		}

		await Promise.all(
			candidates.map(async (pid) => {
				this.envChecked.add(pid);
				let environ: string;
				try {
					environ = await readFile(`/proc/${pid}/environ`, "utf8");
				} catch {
					return;
				}
				if (!hasSessionMarker(environ, this.opts.sessionId)) return;
				const info = procs.get(pid);
				if (!info || elapsedMs(info.startTicks, uptimeSec) < this.opts.minAgeMs) return;
				let argv: string[] = [];
				try {
					argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter((part) => part.length > 0);
				} catch {
					// gone already; the next poll will see it if it survived
				}
				this.remembered.set(pid, { startTicks: info.startTicks, command: commandText(argv) || `[${info.comm}]` });
			}),
		);
	}

	private async readSystemd(): Promise<{ units: SystemdUnit[]; timers: SystemdTimer[]; jobs: SystemdJob[] }> {
		const scopes: Scope[] = this.opts.includeSystem ? ["user", "system"] : ["user"];
		const units: SystemdUnit[] = [];
		const timers: SystemdTimer[] = [];
		const jobs: SystemdJob[] = [];
		const session = this.opts.unitScope === "session";
		const sessionMonoUs = session ? await this.sessionStartMonoUs() : undefined;

		for (const scope of scopes) {
			const [servicesRaw, timersRaw, jobsRaw] = await Promise.all([
				execText(scope, ["list-units", "--type=service", "--state=running", "--output=json", "--no-pager"]),
				execText(scope, ["list-timers", "--output=json", "--no-pager"]),
				execText(scope, ["list-jobs", "--no-pager"]),
			]);

			const services = parseUnitNames(servicesRaw);
			const timersHere = parseTimers(timersRaw).map((timer) => ({ ...timer, scope }));
			const infos = await this.unitInfos(scope, [...services, ...timersHere.map((timer) => timer.unit)]);
			const keep = (unit: string) => this.keepUnit(scope, unit, infos.get(unit), sessionMonoUs);

			for (const unit of services) if (keep(unit)) units.push({ unit, scope });
			for (const timer of timersHere) if (keep(timer.unit)) timers.push(timer);
			// A pending job belongs to this session only when this session asked for that unit.
			jobs.push(...parseJobs(jobsRaw, scope).filter((job) => !session || this.claimed.has(job.unit)));
		}

		units.sort((a, b) => a.unit.localeCompare(b.unit));
		timers.sort((a, b) => (a.nextAt ?? Number.MAX_SAFE_INTEGER) - (b.nextAt ?? Number.MAX_SAFE_INTEGER));
		return { units, timers, jobs };
	}

	/** Session start expressed in systemd's monotonic clock, or undefined when it cannot be derived. */
	private async sessionStartMonoUs(): Promise<number | undefined> {
		if (this.sessionMonoUs !== undefined) return this.sessionMonoUs;
		const startedAt = this.opts.sessionStartedAt;
		if (startedAt === undefined) return undefined;
		const uptimeSec = await readUptimeSec();
		if (uptimeSec <= 0) return undefined;
		const nowUs = uptimeSec * 1_000_000;
		this.sessionMonoUs = nowUs - Math.max(0, this.opts.now() - startedAt) * 1000;
		return this.sessionMonoUs;
	}

	/**
	 * Keep a unit when it fits the configured scope. `session` accepts a unit this session named on a
	 * command line or one systemd activated after the session started; both filters still require the
	 * unit to be the user's own, so a distribution unit that happened to restart is not shown.
	 */
	private keepUnit(scope: Scope, unit: string, info: UnitInfo | undefined, sessionMonoUs: number | undefined): boolean {
		if (this.opts.unitScope === "all") return true;
		const own = !!info && isOwnUnit(scope, info.fragmentPath, info.realPath, this.opts.home);
		if (this.opts.unitScope === "owner") return own;
		if (!own) return false;
		return this.claimed.has(unit) || startedThisSession(info, sessionMonoUs);
	}

	/** Fragment path decides ownership, plus the activation stamp the session filter needs. */
	private async unitInfos(scope: Scope, names: string[]): Promise<Map<string, UnitInfo>> {
		const infos = new Map<string, UnitInfo>();
		const unique = [...new Set(names)];
		if (unique.length === 0) return infos;

		const raw = await execText(scope, [
			"show",
			"--no-pager",
			"-p",
			"Id",
			"-p",
			"FragmentPath",
			"-p",
			"ActiveEnterTimestampMonotonic",
			...unique,
		]);
		for (const [unit, info] of parseUnitInfo(raw)) infos.set(unit, info);

		await Promise.all(
			[...infos.values()].map(async (info) => {
				if (!info.fragmentPath) return;
				try {
					info.realPath = await realpath(info.fragmentPath);
				} catch {
					// deleted or unreadable unit file: judge by the reported path
				}
			}),
		);
		return infos;
	}
}
