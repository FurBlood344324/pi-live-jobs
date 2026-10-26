import { describe, expect, test } from "bun:test";
import {
	buildScripts,
	commandText,
	detachedJobs,
	hasSessionMarker,
	isOwnUnit,
	isShellWrapper,
	parseFragments,
	parseJobs,
	parseStat,
	parseTimers,
	parseUnitNames,
	type ProcInfo,
	type Remembered,
} from "../extensions/collect";

function proc(pid: number, ppid: number, argv: string[], overrides: Partial<ProcInfo> = {}): ProcInfo {
	return {
		pid,
		ppid,
		state: "S",
		comm: argv[0] ? argv[0].split("/").pop() ?? "proc" : "proc",
		// uptime 1000s, started 1s ago unless overridden
		startTicks: 99_900,
		argv,
		...overrides,
	};
}

function table(...items: ProcInfo[]): Map<number, ProcInfo> {
	return new Map(items.map((info) => [info.pid, info]));
}

describe("parseStat", () => {
	test("reads fields from the last ')' so a comm with spaces and parens survives", () => {
		const raw = "42 (my (weird) proc) S 7 42 42 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 99123 1000 100";
		expect(parseStat(raw)).toEqual({ comm: "my (weird) proc", state: "S", ppid: 7, startTicks: 99123 });
	});

	test("rejects a truncated line", () => {
		expect(parseStat("")).toBeUndefined();
		expect(parseStat("42 (x) S")).toBeUndefined();
	});
});

describe("commandText", () => {
	test("reduces a shell wrapper to the command it runs", () => {
		expect(isShellWrapper(["bash", "-lc", "npm run dev"])).toBe(true);
		expect(commandText(["bash", "-lc", "npm run dev"])).toBe("npm run dev");
		expect(commandText(["/bin/sh", "-c", "python3 train.py --epochs 3"])).toBe("python3 train.py --epochs 3");
	});

	test("leaves a normal command alone and handles an empty argv", () => {
		expect(commandText(["node", "server.js"])).toBe("node server.js");
		expect(commandText([])).toBe("");
		expect(isShellWrapper(["node", "-c", "x"])).toBe(false);
	});
});

describe("buildScripts", () => {
	test("walks pi's descendants in order and indents children", () => {
		const procs = table(
			proc(100, 1, ["pi"]),
			proc(101, 100, ["node", "dev.js"]),
			proc(102, 100, ["python3", "worker.py"]),
			proc(103, 101, ["node", "child.js"]),
		);
		const rows = buildScripts(procs, 100, { uptimeSec: 1000, minAgeMs: 100 });
		expect(rows.map((row) => [row.pid, row.depth, row.command])).toEqual([
			[101, 1, "node dev.js"],
			[103, 2, "node child.js"],
			[102, 1, "python3 worker.py"],
		]);
	});

	test("drops a single-child shell wrapper and promotes the child to its depth", () => {
		const procs = table(
			proc(100, 1, ["pi"]),
			proc(101, 100, ["bash", "-lc", "npm run dev"]),
			proc(102, 101, ["npm", "run", "dev"]),
			proc(103, 102, ["node", "bin/dev.js"]),
		);
		const rows = buildScripts(procs, 100, { uptimeSec: 1000, minAgeMs: 100 });
		expect(rows.map((row) => [row.pid, row.depth, row.command])).toEqual([
			[102, 1, "npm run dev"],
			[103, 2, "node bin/dev.js"],
		]);
	});

	test("skips zombies, ignored pids and processes younger than minAge", () => {
		const procs = table(
			proc(100, 1, ["pi"]),
			proc(101, 100, ["node", "old.js"]),
			proc(102, 100, ["node", "young.js"], { startTicks: 99_990 }),
			proc(103, 100, ["node", "zombie.js"], { state: "Z" }),
			proc(104, 100, ["systemctl", "list-jobs"]),
		);
		const rows = buildScripts(procs, 100, {
			uptimeSec: 1000,
			minAgeMs: 500,
			ignore: new Set([104]),
		});
		expect(rows.map((row) => row.pid)).toEqual([101]);
	});
});

describe("detachedJobs", () => {
	const remembered: Map<number, Remembered> = new Map([[50, { startTicks: 98_000, command: "python3 worker.py" }]]);

	test("keeps a remembered process that outlived its parent", () => {
		const procs = table(proc(100, 1, ["pi"]), proc(50, 1, ["python3", "worker.py"], { startTicks: 98_000 }));
		const rows = detachedJobs(remembered, procs, new Set(), 1000);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ pid: 50, command: "python3 worker.py", detached: true, elapsedMs: 20_000 });
	});

	test("drops reused pids and processes still inside pi's tree", () => {
		const reused = table(proc(50, 1, ["other"], { startTicks: 99_500 }));
		expect(detachedJobs(remembered, reused, new Set(), 1000)).toEqual([]);
		const inside = table(proc(50, 100, ["python3", "worker.py"], { startTicks: 98_000 }));
		expect(detachedJobs(remembered, inside, new Set([50]), 1000)).toEqual([]);
	});
});

describe("hasSessionMarker", () => {
	test("matches only the exact PI_SESSION_ID entry", () => {
		const environ = "PATH=/bin\0PI_SESSION_ID=abc\0AI_AGENT=pi\0";
		expect(hasSessionMarker(environ, "abc")).toBe(true);
		expect(hasSessionMarker(environ, "abcd")).toBe(false);
		expect(hasSessionMarker(environ, undefined)).toBe(false);
		expect(hasSessionMarker("PATH=/bin\0PI_SESSION_ID=abc-other\0", "abc")).toBe(false);
	});
});

describe("isOwnUnit", () => {
	const home = "/home/user";

	test("accepts units the user wrote, including dotfile symlinks", () => {
		expect(isOwnUnit("user", `${home}/.config/systemd/user/a.service`, "/home/user/dotfiles/a.service", home)).toBe(true);
		expect(isOwnUnit("user", `${home}/.local/share/systemd/user/b.service`, `${home}/.local/share/systemd/user/b.service`, home)).toBe(true);
		expect(isOwnUnit("system", "/etc/systemd/system/custom.service", "/etc/systemd/system/custom.service", home)).toBe(true);
	});

	test("rejects package units and /etc aliases that resolve into /usr", () => {
		expect(isOwnUnit("user", "/usr/lib/systemd/user/gvfs.service", "/usr/lib/systemd/user/gvfs.service", home)).toBe(false);
		expect(isOwnUnit("system", "/etc/systemd/system/display-manager.service", "/usr/lib/systemd/system/gdm.service", home)).toBe(false);
	});

	test("rejects a unit outside the user's config roots", () => {
		expect(isOwnUnit("user", "/etc/systemd/system/x.service", "/etc/systemd/system/x.service", home)).toBe(false);
		expect(isOwnUnit("system", "/etc/systemd/system/x.service", undefined, home)).toBe(true);
	});
});

describe("systemd parsing", () => {
	test("unit list comes from the JSON 'unit' field", () => {
		const raw = JSON.stringify([{ unit: "a.service" }, { unit: "b.service" }, { nope: 1 }]);
		expect(parseUnitNames(raw)).toEqual(["a.service", "b.service"]);
		expect(parseUnitNames("")).toEqual([]);
		expect(parseUnitNames("not json")).toEqual([]);
	});

	test("old systemd text tables fall back to names", () => {
		const units = "  backup.service loaded active running Daily backup\n● other.service loaded active running Other\n";
		expect(parseUnitNames(units)).toEqual(["backup.service", "other.service"]);
		expect(parseTimers("NEXT LEFT LAST PASSED UNIT ACTIVATES\nn/a n/a n/a n/a backup.timer backup.service\n")).toEqual([
			{ unit: "backup.timer", nextAt: null },
		]);
	});

	test("timers convert the microsecond 'next' field to epoch ms", () => {
		const raw = JSON.stringify([{ unit: "t.timer", next: 1_793_048_400_000_000, activates: "t.service" }]);
		expect(parseTimers(raw)).toEqual([{ unit: "t.timer", nextAt: 1_793_048_400_000, activates: "t.service" }]);
	});

	test("jobs come from the text table and ignore the empty-state sentence", () => {
		expect(parseJobs("No jobs running.\n", "user")).toEqual([]);
		expect(parseJobs("JOB UNIT TYPE STATE\n12 backup.service start running\n", "user")).toEqual([
			{ job: "12", unit: "backup.service", type: "start", state: "running", scope: "user" },
		]);
	});

	test("fragment paths are grouped per unit block", () => {
		const raw = "Id=a.service\nFragmentPath=/home/u/.config/systemd/user/a.service\n\nId=b.service\nFragmentPath=/usr/lib/systemd/user/b.service\n";
		const paths = parseFragments(raw);
		expect(paths.get("a.service")).toBe("/home/u/.config/systemd/user/a.service");
		expect(paths.get("b.service")).toBe("/usr/lib/systemd/user/b.service");
	});
});
