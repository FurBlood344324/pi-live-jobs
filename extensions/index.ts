/**
 * index.ts — pi-live-jobs: a collapsible widget above the editor showing
 *   (1) the processes pi spawned — scripts, servers, long commands, plus ones that detached —
 *   (2) the systemd units, timers and jobs this session started or invoked.
 *
 * Read-only by design: it observes /proc and asks systemctl for state; it never starts, stops,
 * signals or kills anything. Every poll is independent, so a missing systemd or a permission error
 * just means an empty section (fail-open, the panel never breaks the session).
 *
 * Environment:
 *   JOBS_KEY          toggle shortcut (default ctrl+shift+j)
 *   JOBS_MIN_AGE_MS   process age before it gets a row (default 400)
 *   JOBS_SYSTEM       1 also watches system-scope units in /etc/systemd/system (default 1)
 *   JOBS_UNIT_SCOPE   session | owner | all (default session)
 *                       session — only units this session started or named on a command line
 *                       owner   — every active unit whose file lives in the user's config
 *                       all     — every active unit, distribution units included
 *   JOBS_ALL_UNITS    1 is the old name for JOBS_UNIT_SCOPE=all (kept for compatibility)
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { DEFAULT_MIN_AGE_MS, emptySnapshot, JobsCollector, type Snapshot, type UnitScope } from "./collect";
import { countsText, renderPanel, type PanelState } from "./render";

const WIDGET_KEY = "jobs";
const POLL_MS = 3000;
const DEFAULT_TOGGLE_KEY = "ctrl+shift+j";
const TOGGLE_LABEL = process.env.JOBS_KEY?.trim() || DEFAULT_TOGGLE_KEY;
const TOGGLE_KEY = TOGGLE_LABEL as KeyId;

function envFlag(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw) return fallback;
	if (["1", "true", "yes", "on"].includes(raw)) return true;
	if (["0", "false", "no", "off"].includes(raw)) return false;
	return fallback;
}

function envNumber(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envUnitScope(): UnitScope {
	const raw = process.env.JOBS_UNIT_SCOPE?.trim().toLowerCase();
	if (raw === "session" || raw === "owner" || raw === "all") return raw;
	return envFlag("JOBS_ALL_UNITS", false) ? "all" : "session";
}

/**
 * The command text of a tool call, so a `systemctl start` this session runs can claim its unit. Only
 * arguments that hold a command or a script are read; other tools have nothing to contribute.
 */
function toolCommandText(event: ToolCallEvent): string {
	const input = event.input as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of ["command", "code", "script"]) {
		const value = input[key];
		if (typeof value === "string") parts.push(value);
	}
	return parts.join("\n");
}

interface WidgetHandle {
	requestRender(): void;
}

function hasItems(snapshot: Snapshot): boolean {
	return snapshot.scripts.length + snapshot.units.length + snapshot.timers.length + snapshot.jobs.length > 0;
}

export default function liveJobs(pi: ExtensionAPI) {
	// /proc and systemctl are Linux; elsewhere the extension stays inert instead of erroring.
	if (process.platform !== "linux") return;

	let session: ExtensionContext | undefined;
	let collector: JobsCollector | undefined;
	let snapshot: Snapshot | undefined;
	let poller: ReturnType<typeof setInterval> | undefined;
	let tui: WidgetHandle | undefined;

	const state: PanelState = { expanded: false };
	/** `/jobs off` hides the widget even when jobs are active; `/jobs` or the shortcut undoes it. */
	let hidden = false;
	/** `/jobs on` keeps the panel visible while idle. */
	let forced = false;
	let widgetRegistered = false;
	let busy = false;
	let lastError: string | undefined;

	function clearWidget(): void {
		if (!session) return;
		if (widgetRegistered) session.ui.setWidget(WIDGET_KEY, undefined);
		widgetRegistered = false;
		tui = undefined;
	}

	function registerWidget(): void {
		if (!session) return;
		session.ui.setWidget(
			WIDGET_KEY,
			(handle, theme) => {
				tui = handle;
				return {
					render: (width: number) =>
						renderPanel(snapshot ?? emptySnapshot(), state, theme, width, { toggleKey: TOGGLE_LABEL }),
					invalidate: () => {
						// Theme changed: the factory must run again to capture the new theme.
						widgetRegistered = false;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
		widgetRegistered = true;
	}

	function syncWidget(): void {
		if (!session) return;
		const active = snapshot ? hasItems(snapshot) : false;
		if (hidden || !(forced || active)) {
			clearWidget();
			return;
		}
		if (widgetRegistered) tui?.requestRender();
		else registerWidget();
	}

	async function refresh(force = false): Promise<void> {
		if (!collector || busy) return;
		busy = true;
		try {
			snapshot = await collector.collect(force);
			lastError = undefined;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
		syncWidget();
	}

	function toggle(context: ExtensionContext): void {
		if (!snapshot || !hasItems(snapshot)) {
			context.ui.notify("jobs: nothing active", "info");
			return;
		}
		hidden = false;
		state.expanded = !state.expanded;
		if (state.expanded) void refresh();
		syncWidget();
		tui?.requestRender();
	}

	pi.registerCommand("jobs", {
		description: "Toggle the live jobs panel (scripts spawned from pi, active systemd units, timers, jobs)",
		handler: async (args, context) => {
			if (!session) {
				context.ui.notify("jobs: no interactive session", "info");
				return;
			}
			const arg = args.trim().toLowerCase();

			if (arg === "off") {
				hidden = true;
				forced = false;
				clearWidget();
				return;
			}
			if (arg === "on") {
				hidden = false;
				forced = true;
				state.expanded = true;
				await refresh(true);
				syncWidget();
				return;
			}
			if (arg === "refresh" || arg === "status") {
				await refresh(true);
				const counts = snapshot ? countsText(snapshot) : "";
				if (lastError) context.ui.notify(`jobs: ${lastError}`, "warning");
				else context.ui.notify(counts ? `jobs: ${counts}` : "jobs: nothing active", "info");
				return;
			}
			if (arg === "help" || arg === "?") {
				context.ui.notify(
					`jobs: /jobs toggles · on · off · refresh · status · units: ${snapshot?.unitScope ?? envUnitScope()} (JOBS_UNIT_SCOPE)`,
					"info",
				);
				return;
			}
			toggle(context);
		},
	});

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Toggle the live jobs panel",
		handler: (context) => toggle(context),
	});

	pi.on("session_start", (_event, context) => {
		if (context.mode !== "tui") return;
		session = context;
		hidden = false;
		forced = false;
		state.expanded = false;
		collector = new JobsCollector({
			rootPid: process.pid,
			includeSystem: envFlag("JOBS_SYSTEM", true),
			unitScope: envUnitScope(),
			sessionStartedAt: Date.now(),
			minAgeMs: envNumber("JOBS_MIN_AGE_MS", DEFAULT_MIN_AGE_MS),
			sessionId: context.sessionManager.getSessionId(),
		});
		void refresh(true);
		poller = setInterval(() => void refresh(), POLL_MS);
		poller.unref?.();
	});

	// Units and timers are attributed to this session by the commands it runs and by their activation
	// stamp; nothing is executed here, the text is only scanned.
	pi.on("tool_call", (event) => {
		if (!collector) return;
		const text = toolCommandText(event);
		if (text) collector.noteCommand(text);
	});

	pi.on("session_shutdown", () => {
		if (poller) clearInterval(poller);
		poller = undefined;
		clearWidget();
		session = undefined;
		collector = undefined;
		snapshot = undefined;
		busy = false;
	});
}
