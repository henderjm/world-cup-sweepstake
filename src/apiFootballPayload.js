export function assertApiFootballPayload(payload) {
  const errors = payload?.errors;
  const hasErrors = Array.isArray(errors)
    ? errors.length > 0
    : errors && typeof errors === "object"
      ? Object.keys(errors).length > 0
      : Boolean(errors);
  if (hasErrors) throw new Error(`API-Football: ${JSON.stringify(errors)}`);
  if (!Array.isArray(payload?.response)) throw new Error("API-Football: malformed response");
  return payload;
}
