// Shared formatting helpers. Pure, no DOM.

const LIVE_STATUSES = new Set([
  "IN_PLAY",
  "PAUSED",
  "LIVE",
  "EXTRA_TIME",
  "PENALTY_SHOOTOUT",
  "BREAK",
]);

export function money(value) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

export function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

export function percent(value) {
  if (!Number.isFinite(value)) return "0%";
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
}

export function dateLabel(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-IE", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function dayLabel(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-IE", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(new Date(value));
}

export function timeLabel(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-IE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatStage(stage) {
  const map = {
    GROUP_STAGE: "Group stage",
    LAST_32: "Round of 32",
    ROUND_OF_32: "Round of 32",
    LAST_16: "Round of 16",
    ROUND_OF_16: "Round of 16",
    QUARTER_FINALS: "Quarter-final",
    SEMI_FINALS: "Semi-final",
    THIRD_PLACE: "Third place",
    FINAL: "Final",
  };
  return (
    map[stage] ??
    String(stage ?? "GROUP_STAGE")
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

export function isLive(status) {
  return LIVE_STATUSES.has(status);
}

export function isFinished(status) {
  return status === "FINISHED" || status === "AWARDED";
}

export function statusLabel(matchItem) {
  if (isLive(matchItem.status)) return matchItem.minute ? `${matchItem.minute}'` : "LIVE";
  if (isFinished(matchItem.status)) return "FT";
  return timeLabel(matchItem.utcDate);
}

export function scorePart(score, side) {
  return Number.isFinite(score?.[side]) ? score[side] : "";
}
