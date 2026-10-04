export function storedOrigin(configured) {
  const origin = new URL(configured);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
    || !(origin.protocol === "https:" || (origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname))))
    throw Error("Invalid stored service origin");
  return origin.origin;
}

export async function fetchStoredJson(url, { fetcher, timeoutMs, maxBytes }) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetcher(url, { signal: controller.signal, redirect: "error", headers: { Accept: "application/json" } });
    if (!response.ok) throw Error("Stored service unavailable");
    reader = response.body?.getReader();
    if (!reader) throw Error("Stored service has no body");
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Error("Stored response exceeds read limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { body: JSON.parse(new TextDecoder().decode(bytes)), size };
  } finally { clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {}); }
}
