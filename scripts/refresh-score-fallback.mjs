import { readFile, writeFile } from "node:fs/promises";
import { validScoreSnapshot } from "../src/scoreSnapshot.js";

async function readLive(competition) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`https://goon-squad-data.gs-wc.workers.dev/${competition}/live`, {
        signal: AbortSignal.timeout(15000), cache: "no-store",
      });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

// Reuse the public cached feed; a code deploy must not trigger a full provider bake.
await Promise.all(["PL", "CL"].map(async competition => {
  const path = `data/${competition}/live.json`;
  try {
    const fresh = await readLive(competition);
    if (!validScoreSnapshot(fresh, competition)) throw Error("Feed has no recent, dated fixtures");
    const previous = JSON.parse(await readFile(path, "utf8"));
    if (Date.parse(previous.lastUpdated) > Date.parse(fresh.lastUpdated)) {
      console.log(`${competition}: retaining newer fallback from ${previous.lastUpdated}`);
      return;
    }
    const body = JSON.stringify(fresh, null, 2) + "\n";
    await writeFile(path, body);
    if (competition === "PL") await writeFile("data/live.json", body);
    console.log(`${competition}: fallback refreshed to ${fresh.lastUpdated}`);
  } catch (error) {
    console.warn(`${competition}: could not refresh fallback; retaining existing data: ${error.message}`);
  }
}));
