/**
 * render.ts — the widget's rendering. Pure: a snapshot plus a theme in, terminal lines out.
 *
 * The collapsed form is one line so it can sit above the editor next to pi-subagents' widget;
 * expanding adds one section per source. Rows are capped and the rest is summarised, because this
 * panel shares the editor's vertical space with the transcript.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ScriptJob, Snapshot } from "./collect";

export interface PanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface PanelState {
	expanded: boolean;
	/** Shown even when nothing is active (the user asked for the panel explicitly). */
	forced?: boolean;
}

export interface PanelOptions {
	toggleKey?: string;
}

export const MAX_SCRIPT_ROWS = 5;
export const MAX_UNIT_ROWS = 3;
export const MAX_TIMER_ROWS = 2;
export const MAX_JOB_ROWS = 2;
/** Body lines after the header. The panel shares the space above the editor with other widgets. */
export const MAX_BODY_LINES = 12;

/** "12s", "4m", "3h", "2d" — one unit, because the column is three characters wide. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(1, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Relative next run: "now", "in <1m", "in 12m", "in 3h", "in 2d". */
export function formatNext(nextAt: number | null, now: number): string {
	if (nextAt === null) return "no next run";
	const ms = nextAt - now;
	if (ms <= 0) return "now";
	if (ms < 60_000) return "in <1m";
	if (ms < 3_600_000) return `in ${Math.floor(ms / 60_000)}m`;
	if (ms < 86_400_000) return `in ${Math.floor(ms / 3_600_000)}h`;
	return `in ${Math.floor(ms / 86_400_000)}d`;
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** The header counts, in a fixed order. Empty when nothing is active. */
export function countsText(snapshot: Snapshot): string {
	const parts: string[] = [];
	if (snapshot.scripts.length > 0) parts.push(plural(snapshot.scripts.length, "script"));
	if (snapshot.units.length > 0) parts.push(plural(snapshot.units.length, "unit"));
	if (snapshot.timers.length > 0) parts.push(plural(snapshot.timers.length, "timer"));
	if (snapshot.jobs.length > 0) parts.push(plural(snapshot.jobs.length, "job"));
	return parts.join(" · ");
}

function scriptRow(job: ScriptJob, theme: PanelTheme): string {
	const glyph = job.detached ? theme.fg("warning", "↗") : theme.fg("accent", "●");
	const elapsed = theme.fg("dim", formatElapsed(job.elapsedMs).padEnd(4));
	const indent = "  ".repeat(Math.max(0, job.depth - 1));
	const command = theme.fg("toolOutput", job.command) + (job.detached ? theme.fg("dim", " · detached") : "");
	return `    ${indent}${glyph} ${elapsed} ${command}`;
}

function section(title: string, rows: string[], limit: number, theme: PanelTheme): string[] {
	if (rows.length === 0) return [];
	const lines = [theme.fg("dim", `  ${title}`)];
	for (const row of rows.slice(0, limit)) lines.push(row);
	if (rows.length > limit) lines.push(theme.fg("dim", `    +${rows.length - limit} more`));
	return lines;
}

export function renderPanel(
	snapshot: Snapshot,
	state: PanelState,
	theme: PanelTheme,
	width: number,
	options: PanelOptions = {},
): string[] {
	const counts = countsText(snapshot);
	const title = `${theme.fg("accent", "⚙")} ${theme.bold("jobs")}${counts ? ` ${theme.fg("muted", counts)}` : ` ${theme.fg("dim", "idle")}`}`;
	const hint = options.toggleKey ? theme.fg("dim", options.toggleKey) : "";
	const lines: string[] = [hint ? `${title}  ${hint}` : title];

	if (state.expanded) {
		const body: string[] = [
			...section(
				"scripts",
				snapshot.scripts.map((job) => scriptRow(job, theme)),
				MAX_SCRIPT_ROWS,
				theme,
			),
			...section(
				"user units",
				snapshot.units
					.filter((unit) => unit.scope === "user")
					.map((unit) => `    ${theme.fg("success", "●")} ${theme.fg("toolOutput", unit.unit)}`),
				MAX_UNIT_ROWS,
				theme,
			),
			...section(
				"system units",
				snapshot.units
					.filter((unit) => unit.scope === "system")
					.map((unit) => `    ${theme.fg("success", "●")} ${theme.fg("toolOutput", unit.unit)}`),
				MAX_UNIT_ROWS,
				theme,
			),
			...section(
				"timers",
				snapshot.timers.map(
					(timer) =>
						`    ${theme.fg("accent", "◷")} ${theme.fg("toolOutput", timer.unit)} ${theme.fg("muted", `· ${formatNext(timer.nextAt, snapshot.at)}`)}`,
				),
				MAX_TIMER_ROWS,
				theme,
			),
			...section(
				"jobs",
				snapshot.jobs.map(
					(job) => `    ${theme.fg("warning", "⟳")} ${theme.fg("toolOutput", job.unit)} ${theme.fg("muted", `· ${job.type}`)}`,
				),
				MAX_JOB_ROWS,
				theme,
			),
		];

		if (body.length === 0) body.push(theme.fg("dim", "  nothing active"));
		else if (body.length > MAX_BODY_LINES) {
			const hidden = body.length - (MAX_BODY_LINES - 1);
			body.splice(MAX_BODY_LINES - 1, body.length, theme.fg("dim", `  +${hidden} more lines`));
		}
		lines.push(...body);
	}

	return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}
