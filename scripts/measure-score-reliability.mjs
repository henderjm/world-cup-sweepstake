import { fstatSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { readLedger } from "./lib/scoreAlerts.mjs";
import { open, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { validatePlan, probe, summarize } from "./lib/scoreReliability.mjs";

const [mode, input, output, ...extra] = process.argv.slice(2);
if (extra.length || !input || !["record", "resume", "report"].includes(mode) || (mode !== "report" ? !output : output))
  throw Error("Usage: node scripts/measure-score-reliability.mjs record <plan.json> <new-ledger.jsonl> | report <ledger.jsonl>");

if (mode === "report") {
  const contents = await readFile(input, "utf8");
  const lines = contents.trimEnd().split("\n");
  // Only the last unterminated append may be interrupted by process loss.
  const rows = lines.flatMap((line, i) => {
    try { return [JSON.parse(line)]; } catch (error) {
      if (i !== lines.length - 1 || contents.endsWith("\n")) throw error;
      console.error("Ignoring interrupted final ledger record; its checks remain missing");
      return [];
    }
  });
  if (rows[0]?.type !== "plan") throw Error("Ledger needs its original plan");
  console.log(JSON.stringify(summarize(validatePlan(rows[0].plan), rows.slice(1)), null, 2));
} else {
  const plan = validatePlan(JSON.parse(await readFile(input, "utf8")));
  // Current Worker reads can contact the provider. Faster sampling belongs to
  // the replacement stored-data API, not the existing production endpoint.
  if (new URL(plan.origin).hostname === "goon-squad-data.gs-wc.workers.dev" && plan.intervalMs < 60000)
    throw Error("Current production Worker requires a >=60s probe interval to protect provider quota");
  if (mode === "resume") {
    const fd = Number(process.env.SCORE_RECORDER_LOCK_FD);
    if (!Number.isInteger(fd) || fd < 3) throw Error("Resume requires scripts/resume-score-recorder.py");
    const held = fstatSync(fd), expected = statSync(`${resolve(output)}.recorder.lock`);
    if (!held.isFile() || held.dev !== expected.dev || held.ino !== expected.ino)
      throw Error("Recorder lock does not match ledger");
  }
  const file = await open(output, mode === "resume" ? "a+" : "wx", 0o600);
  const write = async row => { await file.writeFile(JSON.stringify(row) + "\n"); await file.sync(); };
  const records = [];
  try {
    if ((await file.stat()).size > 64 * 1024 * 1024) throw Error("Ledger exceeds 64 MiB recovery limit");
    const bytes = mode === "resume" ? await file.readFile() : Buffer.alloc(0);
    if (bytes.length) {
      const ledger = readLedger(bytes);
      if (JSON.parse(ledger.complete.toString("utf8").split("\n")[0]).writerProtocol !== "posix-lock-v1")
        throw Error("Legacy unlocked ledger cannot be resumed; retain its evidence and start a new window");
      if (!isDeepStrictEqual(ledger.plan, plan)) throw Error("Resume plan differs from original evidence");
      records.push(...ledger.slots.values());
      // Only an unterminated tail can be discarded; durable records were validated above.
      if (ledger.complete.length !== bytes.length) { await file.truncate(ledger.complete.length); await file.sync(); }
    } else await write({ type: "plan", schema: 1, plan, ...(mode === "resume" ? { writerProtocol: "posix-lock-v1" } : {}) });
    const seen = new Set(records.map(row => `${row.competition}:${row.scheduledAt}`));
    for (let at = Date.parse(plan.start); at < Date.parse(plan.end); at += plan.intervalMs) {
      if (Date.now() >= at + plan.intervalMs) continue;
      await sleep(Math.max(0, at - Date.now()));
      if (Date.now() >= at + plan.intervalMs || Date.now() >= Date.parse(plan.end)) continue;
      const rows = await Promise.all(plan.competitions.filter(code => !seen.has(`${code}:${at}`)).map(code => probe(plan, code, at)));
      for (const row of rows) { await write(row); records.push(row); }
    }
  } finally { await file.close(); }
  console.log(JSON.stringify(summarize(plan, records), null, 2));
}
