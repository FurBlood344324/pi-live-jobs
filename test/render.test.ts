import { describe, expect, test } from "bun:test";
import { type Snapshot } from "../extensions/collect";
import {
	countsText,
	formatElapsed,
	formatNext,
	MAX_BODY_LINES,
	MAX_SCRIPT_ROWS,
	renderPanel,
	renderPanel as render,
} from "../extensions/render";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		at: 1_000_000,
		scripts: [],
		units: [],
		timers: [],
		jobs: [],
		...overrides,
	};
}

function visibleWidth(line: string): number {
	return line.replace(/\u001b\[[0-9;]*m/g, "").length;
}

describe("formatElapsed", () => {
	test("uses one unit and never shows 0s for a fresh process", () => {
		expect(formatElapsed(200)).toBe("1s");
		expect(formatElapsed(12_400)).toBe("12s");
		expect(formatElapsed(59_900)).toBe("59s");
		expect(formatElapsed(4 * 60_000)).toBe("4m");
		expect(formatElapsed(3 * 3_600_000)).toBe("3h");
		expect(formatElapsed(2 * 86_400_000)).toBe("2d");
	});
});

describe("formatNext", () => {
	test("renders a coarse relative time", () => {
		expect(formatNext(null, 0)).toBe("no next run");
		expect(formatNext(0, 1_000)).toBe("now");
		expect(formatNext(30_000, 0)).toBe("in <1m");
		expect(formatNext(12 * 60_000, 0)).toBe("in 12m");
		expect(formatNext(3 * 3_600_000, 0)).toBe("in 3h");
		expect(formatNext(2 * 86_400_000, 0)).toBe("in 2d");
	});
});

describe("countsText", () => {
	test("counts only what is present, in a fixed order", () => {
		expect(countsText(snapshot())).toBe("");
		expect(
			countsText(
				snapshot({
					scripts: [{ pid: 1, ppid: 0, depth: 1, command: "a", elapsedMs: 1000, state: "S" }],
					units: [{ unit: "u.service", scope: "user" }],
					timers: [{ unit: "t.timer", scope: "user", nextAt: null }],
					jobs: [{ job: "1", unit: "j.service", type: "start", state: "running", scope: "user" }],
				}),
			),
		).toBe("1 script · 1 unit · 1 timer · 1 job");
	});
});

describe("renderPanel", () => {
	test("collapsed form is a single header line with counts and the toggle key", () => {
		const lines = render(
			snapshot({
				scripts: [
					{ pid: 1, ppid: 0, depth: 1, command: "npm run dev", elapsedMs: 12_400, state: "S" },
					{ pid: 2, ppid: 1, depth: 2, command: "node dev.js", elapsedMs: 12_000, state: "S" },
				],
				units: [{ unit: "mc-chat-bridge.service", scope: "user" }],
			}),
			{ expanded: false },
			theme,
			120,
			{ toggleKey: "ctrl+shift+j" },
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe("⚙ jobs 2 scripts · 1 unit  ctrl+shift+j");
	});

	test("expanded form sections scripts, units, timers and jobs", () => {
		const lines = render(
			snapshot({
				scripts: [
					{ pid: 1, ppid: 0, depth: 1, command: "npm run dev", elapsedMs: 12_400, state: "S" },
					{ pid: 2, ppid: 1, depth: 2, command: "node dev.js", elapsedMs: 12_000, state: "S" },
					{ pid: 3, ppid: 0, depth: 1, command: "python3 worker.py", elapsedMs: 240_000, state: "S", detached: true },
				],
				units: [
					{ unit: "mc-chat-bridge.service", scope: "user" },
					{ unit: "backup.service", scope: "system" },
				],
				timers: [{ unit: "marketpulse-scan.timer", scope: "user", nextAt: 1_000_000 + 12 * 60_000 }],
				jobs: [{ job: "12", unit: "queued.service", type: "start", state: "running", scope: "user" }],
			}),
			{ expanded: true },
			theme,
			120,
			{ toggleKey: "ctrl+shift+j" },
		);
		expect(lines).toEqual([
			"⚙ jobs 3 scripts · 2 units · 1 timer · 1 job  ctrl+shift+j",
			"  scripts",
			"    ● 12s  npm run dev",
			"      ● 12s  node dev.js",
			"    ↗ 4m   python3 worker.py · detached",
			"  user units",
			"    ● mc-chat-bridge.service",
			"  system units",
			"    ● backup.service",
			"  timers",
			"    ◷ marketpulse-scan.timer · in 12m",
			"  jobs",
			"    ⟳ queued.service · start",
		]);
	});

	test("expanded form caps rows and summarises the rest", () => {
		const scripts = Array.from({ length: MAX_SCRIPT_ROWS + 3 }, (_value, index) => ({
			pid: index + 1,
			ppid: 0,
			depth: 1,
			command: `script-${index + 1}`,
			elapsedMs: 1000,
			state: "S",
		}));
		const lines = render(snapshot({ scripts }), { expanded: true }, theme, 120);
		expect(lines).toContain("    +3 more");
		expect(lines.filter((line) => line.includes("script-"))).toHaveLength(MAX_SCRIPT_ROWS);
	});

	test("expanded panel never grows past its line budget", () => {
		const scripts = Array.from({ length: 6 }, (_value, index) => ({
			pid: index + 1,
			ppid: 0,
			depth: index === 0 ? 1 : 2,
			command: `script-${index + 1}`,
			elapsedMs: 1000,
			state: "S",
		}));
		const units = Array.from({ length: 5 }, (_value, index) => ({ unit: `u${index}.service`, scope: "user" as const }));
		const timers = Array.from({ length: 3 }, (_value, index) => ({ unit: `t${index}.timer`, scope: "user" as const, nextAt: null }));
		const lines = render(snapshot({ scripts, units, timers }), { expanded: true }, theme, 120);
		expect(lines.length).toBe(MAX_BODY_LINES + 1);
		expect(lines.at(-1)).toContain("more lines");
	});

	test("idle panel says nothing is active when shown on request", () => {
		const lines = renderPanel(snapshot(), { expanded: true, forced: true }, theme, 80);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("idle");
		expect(lines[1]).toContain("nothing active");
	});

	test("every line fits the width, including narrow terminals", () => {
		const lines = render(
			snapshot({
				scripts: [
					{ pid: 1, ppid: 0, depth: 1, command: "npm run dev -- --watch --very-long-flag", elapsedMs: 12_400, state: "S" },
				],
				timers: [{ unit: "marketpulse-scan.timer", scope: "user", nextAt: 1_000_000 + 12 * 60_000 }],
			}),
			{ expanded: true },
			theme,
			24,
			{ toggleKey: "ctrl+shift+j" },
		);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});
});
