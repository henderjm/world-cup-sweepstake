import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assertApiFootballPayload } from "../../src/apiFootballPayload.js";

const execFileAsync = promisify(execFile);

export async function fetchApiFootball(paths, { interval = "250ms" } = {}) {
  const requested = Array.isArray(paths) ? paths : [paths];
  if (!requested.length) return [];
  const configured = process.env.API_FOOTBALL_CLI;
  const command = configured || "go";
  const args = configured
    ? ["--interval", interval, ...requested]
    : ["run", "./cmd/api-football", "--interval", interval, ...requested];
  const { stdout } = await execFileAsync(command, args, {
    cwd: new URL("../../", import.meta.url),
    env: process.env,
    maxBuffer: 50 * 1024 * 1024,
  });
  const payloads = JSON.parse(stdout);
  payloads.forEach(assertApiFootballPayload);
  return Array.isArray(paths) ? payloads : payloads[0];
}

// The Go CLI (cmd/api-football) exits 1 for an expected upstream failure (a
// season not yet open, a network blip) and otherwise exits with Go's own default
// code for an unhandled panic. Only the former is safe for a caller to swallow as
// "no data this run"; anything else is a real bug in the ingestion layer.
export function isUnexpectedApiFootballFailure(error) {
  return typeof error.code === "number" && error.code !== 1;
}
