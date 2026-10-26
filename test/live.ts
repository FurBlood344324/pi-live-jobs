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

const child = spawn("sleep", ["30"], { stdio: "ignore" });
const collector = new JobsCollector({ rootPid: process.pid, includeSystem: true });

await new Promise((resolve) => setTimeout(resolve, 700));
const first = await collector.collect(true);
const second = await collector.collect(false);

const scriptPids = first.scripts.map((row) => row.pid);
console.log("spawned sleep pid:", child.pid, "seen:", scriptPids.includes(child.pid ?? -1));
console.log("scripts:", first.scripts.map((row) => `${row.pid} ${row.command} (${row.elapsedMs}ms)`));
console.log("user units:", first.units.filter((u) => u.scope === "user").map((u) => u.unit));
console.log("system units:", first.units.filter((u) => u.scope === "system").map((u) => u.unit));
console.log("timers:", first.timers.map((t) => `${t.unit}@${t.nextAt}`));
console.log("jobs:", first.jobs);

console.log("\n--- collapsed ---");
console.log(renderPanel(second, { expanded: false }, theme, 100, { toggleKey: "ctrl+shift+j" }).join("\n"));
console.log("\n--- expanded ---");
console.log(renderPanel(second, { expanded: true }, theme, 100, { toggleKey: "ctrl+shift+j" }).join("\n"));

child.kill("SIGTERM");
process.exit(scriptPids.includes(child.pid ?? -1) ? 0 : 1);
