import { COMPETITIONS } from "../../src/competitions.js";

export function normalizeSeasons(seasons) {
  if (!seasons || !Object.keys(seasons).length || Object.entries(seasons).some(([code, season]) =>
    !Object.hasOwn(COMPETITIONS, code) || !/^\d{4}$/.test(String(season)))) throw Error("Explicit supported competition seasons are required");
  return Object.fromEntries(Object.entries(seasons).map(([code, season]) => [code, String(season)]));
}

export function parseSeasons(value) {
  const entries = (value ?? "").split(",").map(entry => entry.trim().split(":"));
  if (entries.some(entry => entry.length !== 2) || new Set(entries.map(([code]) => code)).size !== entries.length)
    throw Error("Use unique CODE:season entries in SCORE_SEASONS");
  return normalizeSeasons(Object.fromEntries(entries));
}

export function loopbackEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password)
    throw Error("Local test endpoints must use loopback HTTP");
  return url.href;
}
