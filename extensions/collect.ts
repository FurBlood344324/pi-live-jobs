/**
 * collect.ts — read-only snapshot of what pi is running and what systemd is running.
 *
 * Two sources, both observational: /proc for the live process tree under pi, and `systemctl`
 * queries for active units, timers and jobs. The collector never starts, stops or signals anything.
 *
 * "Scripts" are the processes pi itself spawned (the bash tool, long-running commands), plus the
 * ones that were pi's children earlier and later detached (`nohup … &`) — those are remembered by
 * pid and start time so a reused pid is never mistaken for the old process.
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

/** The interesting part of argv: a shell wrapper is reduced to the command it was asked to run. */
export function commandText(argv: string[]): string {
	if (argv.length === 0) return "";
	const at = shellCommandIndex(argv);
	if (at >= 0) {
		const command = argv.slice(at + 1).join(" ").trim();
		if (command) return command;
	}
	return argv.join(" ");
}

interface ProcTable {
	procs: Map<number, ProcInfo>;
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

	return { procs, uptimeSec };
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
 * Processes remembered as pi's children that are still alive after being reparented. Start time
 * must match, so a recycled pid is dropped instead of being shown as a stale job.
 */
export function detachedJobs(
	remembered: Map<number, Remembered>,
	procs: Map<number, ProcInfo>,
	seen: ReadonlySet<number>,
	uptimeSec: number,
): ScriptJob[] {
	const rows: ScriptJob[] = [];
	for (const [pid, record] of remembered) {
		if (seen.has(pid)) continue;
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

/** Parse `systemctl show -p Id -p FragmentPath` output: blocks separated by blank lines. */
export function parseFragments(raw: string): Map<string, string> {
	const paths = new Map<string, string>();
	for (const block of raw.split(/\n\s*\n/)) {
		let id: string | undefined;
		let path: string | undefined;
		for (const line of block.split("\n")) {
			const text = line.trim();
			if (text.startsWith("Id=")) id = text.slice("Id=".length);
			else if (text.startsWith("FragmentPath=")) path = text.slice("FragmentPath=".length);
		}
		if (id && path) paths.set(id, path);
	}
	return paths;
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

export interface CollectorOptions {
	rootPid?: number;
	home?: string;
	minAgeMs?: number;
	includeSystem?: boolean;
	/** Show every active unit instead of only units the user defined. */
	allUnits?: boolean;
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

export class JobsCollector {
	private readonly opts: Required<Omit<CollectorOptions, "now">> & { now: () => number };
	private readonly remembered = new Map<number, Remembered>();
	private cache?: { at: number; units: SystemdUnit[]; timers: SystemdTimer[]; jobs: SystemdJob[] };

	constructor(options: CollectorOptions = {}) {
		this.opts = {
			rootPid: options.rootPid ?? process.pid,
			home: options.home ?? homedir(),
			minAgeMs: options.minAgeMs ?? DEFAULT_MIN_AGE_MS,
			includeSystem: options.includeSystem ?? true,
			allUnits: options.allUnits ?? false,
			now: options.now ?? Date.now,
		};
	}

	async collect(force = false): Promise<Snapshot> {
		const at = this.opts.now();
		const { procs, uptimeSec } = await readProcTable(this.opts.rootPid);
		const scripts = buildScripts(procs, this.opts.rootPid, { uptimeSec, minAgeMs: this.opts.minAgeMs });
		const seen = new Set(scripts.map((row) => row.pid));
		const detached = detachedJobs(this.remembered, procs, seen, uptimeSec);
		this.remember(scripts, procs);

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

	private async readSystemd(): Promise<{ units: SystemdUnit[]; timers: SystemdTimer[]; jobs: SystemdJob[] }> {
		const scopes: Scope[] = this.opts.includeSystem ? ["user", "system"] : ["user"];
		const units: SystemdUnit[] = [];
		const timers: SystemdTimer[] = [];
		const jobs: SystemdJob[] = [];

		for (const scope of scopes) {
			const [servicesRaw, timersRaw, jobsRaw] = await Promise.all([
				execText(scope, ["list-units", "--type=service", "--state=running", "--output=json", "--no-pager"]),
				execText(scope, ["list-timers", "--output=json", "--no-pager"]),
				execText(scope, ["list-jobs", "--no-pager"]),
			]);

			const services = parseUnitNames(servicesRaw);
			const timersHere = parseTimers(timersRaw).map((timer) => ({ ...timer, scope }));
			const own = await this.ownUnits(scope, [...services, ...timersHere.map((timer) => timer.unit)]);

			for (const unit of services) if (own.has(unit)) units.push({ unit, scope });
			for (const timer of timersHere) if (own.has(timer.unit)) timers.push(timer);
			jobs.push(...parseJobs(jobsRaw, scope));
		}

		units.sort((a, b) => a.unit.localeCompare(b.unit));
		timers.sort((a, b) => (a.nextAt ?? Number.MAX_SAFE_INTEGER) - (b.nextAt ?? Number.MAX_SAFE_INTEGER));
		return { units, timers, jobs };
	}

	/** Fragment path decides ownership: a unit the user wrote is one whose file lives in their config. */
	private async ownUnits(scope: Scope, names: string[]): Promise<Set<string>> {
		const kept = new Set<string>();
		const unique = [...new Set(names)];
		if (unique.length === 0) return kept;
		if (this.opts.allUnits) {
			for (const unit of unique) kept.add(unit);
			return kept;
		}

		const raw = await execText(scope, ["show", "--no-pager", "-p", "Id", "-p", "FragmentPath", ...unique]);
		const paths = parseFragments(raw);
		await Promise.all(
			unique.map(async (unit) => {
				const reported = paths.get(unit);
				if (!reported) return;
				let resolved = reported;
				try {
					resolved = await realpath(reported);
				} catch {
					// deleted or unreadable unit file: judge by the reported path
				}
				if (isOwnUnit(scope, reported, resolved, this.opts.home)) kept.add(unit);
			}),
		);
		return kept;
	}
}
