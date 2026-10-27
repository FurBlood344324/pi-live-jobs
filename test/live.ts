/**
 * live.ts — manual smoke check against the real machine (not part of the published package).
 *
 *   bun test/live.ts
 *
 * Spawns a short-lived child, collects twice (to exercise the detached/remembered path), and prints
 * the panel exactly as the widget would render it.
 */
import { spawn } from "node:child_process";
import { JobsCollector } from "../extensions/collect";
import { renderPanel } from "../extensions/render";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const sessionId = "live-test-session";
const child = spawn("sleep", ["30"], { stdio: "ignore" });
// Lateral check: a bash-tool command that detaches immediately, so pi's tree never sees it.
const detached = spawn("bash", ["-lc", "nohup sleep 15 >/dev/null 2>&1 &"], {
	stdio: "ignore",
	env: { ...process.env, PI_SESSION_ID: sessionId },
});
const collector = new JobsCollector({
	rootPid: process.pid,
	includeSystem: true,
	sessionId,
	unitScope: "session",
	sessionStartedAt: Date.now(),
});
// Pretend the session asked for a unit an earlier session left running: it must appear, and only it.
collector.noteCommand("systemctl --user restart hdmi-autoconfig");

await new Promise((resolve) => setTimeout(resolve, 700));
const first = await collector.collect(true);
const second = await collector.collect(false);

const scriptPids = first.scripts.map((row) => row.pid);
console.log("spawned sleep pid:", child.pid, "seen:", scriptPids.includes(child.pid ?? -1));
console.log("scripts:", first.scripts.map((row) => `${row.pid} ${row.command} (${row.elapsedMs}ms)`));
const adopted = second.scripts.filter((row) => row.detached);
console.log("detached (nohup):", adopted.map((row) => `${row.pid} ${row.command}`));
console.log("scope:", first.unitScope);
console.log("user units:", first.units.filter((u) => u.scope === "user").map((u) => u.unit));
console.log("system units:", first.units.filter((u) => u.scope === "system").map((u) => u.unit));
console.log("timers:", first.timers.map((t) => `${t.unit}@${t.nextAt}`));
console.log("jobs:", first.jobs);
console.log(
	"session filter:",
	first.units.every((u) => u.unit === "hdmi-autoconfig.service")
		? "only the claimed unit"
		: "UNEXPECTED units listed",
);

console.log("\n--- collapsed ---");
console.log(renderPanel(second, { expanded: false }, theme, 100, { toggleKey: "ctrl+shift+j" }).join("\n"));
console.log("\n--- expanded ---");
console.log(renderPanel(second, { expanded: true }, theme, 100, { toggleKey: "ctrl+shift+j" }).join("\n"));

child.kill("SIGTERM");
for (const row of adopted) {
	try {
		process.kill(row.pid, "SIGTERM");
	} catch {
		// already gone
	}
}
void detached;
const ok =
	scriptPids.includes(child.pid ?? -1) &&
	adopted.some((row) => row.command.includes("sleep 15")) &&
	first.units.every((unit) => unit.unit === "hdmi-autoconfig.service");
process.exit(ok ? 0 : 1);
