import { createServer } from "node:http";
import { handler, database } from "./lambda.mjs";

const port = Number(process.env.SCORE_PORT ?? 8744);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("Invalid SCORE_PORT");
const server = createServer(async (req, res) => {
  try {
    const result = await handler({ version: "2.0", rawPath: new URL(req.url, "http://localhost").pathname,
      requestContext: { http: { method: req.method } } });
    res.writeHead(result.statusCode, result.headers); res.end(result.body);
  } catch { res.writeHead(503); res.end("stored scores unavailable"); }
});
server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port })));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.close(() => database.destroy());
  server.closeAllConnections();
});
