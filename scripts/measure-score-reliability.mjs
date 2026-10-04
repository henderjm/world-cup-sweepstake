import { open, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { validatePlan, probe, summarize } from "./lib/scoreReliability.mjs";

const [mode, input, output, ...extra] = process.argv.slice(2);
if (extra.length || !input || !["record", "report"].includes(mode) || (mode === "record" ? !output : output))
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
  const file = await open(output, "wx", 0o600);
  const write = async row => { await file.writeFile(JSON.stringify(row) + "\n"); await file.sync(); };
  const records = [];
  try {
    await write({ type: "plan", schema: 1, plan });
    for (let at = Date.parse(plan.start); at < Date.parse(plan.end); at += plan.intervalMs) {
      if (Date.now() >= at + plan.intervalMs) continue;
      await sleep(Math.max(0, at - Date.now()));
      if (Date.now() >= at + plan.intervalMs || Date.now() >= Date.parse(plan.end)) continue;
      const rows = await Promise.all(plan.competitions.map(code => probe(plan, code, at)));
      for (const row of rows) { await write(row); records.push(row); }
    }
  } finally { await file.close(); }
  console.log(JSON.stringify(summarize(plan, records), null, 2));
}
