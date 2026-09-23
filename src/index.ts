// torob-mcp (Node): stdio by default, Streamable HTTP with --http.
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MAX_BODY_BYTES, PORT } from "./config.js";
import { LANDING } from "./landing.js";
import { buildServer, VERSION } from "./server.js";

// Browser-based MCP clients cannot POST /mcp without CORS (same as worker.ts).
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, authorization",
  "access-control-expose-headers": "mcp-session-id",
};

async function main() {
  if (process.argv.includes("--http")) {
    // Stateless: every POST is self-contained. The SDK requires a fresh
    // transport (and therefore a fresh Server) per request.
    const http = createServer((req, res) => {
      if (req.method === "OPTIONS" && req.url === "/mcp") {
        res.writeHead(204, { ...CORS_HEADERS, "access-control-max-age": "86400" }).end();
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        res.setHeader("access-control-allow-origin", CORS_HEADERS["access-control-allow-origin"]);
        res.setHeader("access-control-expose-headers", CORS_HEADERS["access-control-expose-headers"]);
        let body = "";
        let tooBig = false;
        req.on("data", (c: Buffer | string) => {
          if (tooBig) return;
          body += c;
          // Unbounded bodies OOM the process before routing runs.
          if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
            tooBig = true;
            body = "";
            try {
              req.destroy();
            } catch {
              /* ignore */
            }
            if (!res.headersSent) res.writeHead(413).end("Body too large");
          }
        });
        req.on("end", async () => {
          if (tooBig || res.writableEnded) return;
          let parsed: unknown;
          try {
            parsed = body ? JSON.parse(body) : undefined;
          } catch {
            if (!res.headersSent) res.writeHead(400).end("Bad request: invalid JSON");
            return;
          }
          const reqServer = buildServer();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          try {
            await reqServer.connect(transport);
            await transport.handleRequest(req, res, parsed as any);
          } catch {
            if (!res.headersSent) res.writeHead(400).end("Bad request");
          } finally {
            try { await transport.close(); } catch { /* ignore */ }
            try { await reqServer.close(); } catch { /* ignore */ }
          }
        });
      } else if (req.method === "GET" && req.url === "/health") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, service: "torob-mcp", version: VERSION }));
      } else if (req.method === "GET" && (req.url === "/" || req.url === "")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LANDING);
      } else {
        res.writeHead(404).end("Not found. POST /mcp for MCP, GET /health for health.");
      }
    });
    http.listen(PORT, () => console.error(`torob-mcp HTTP on :${PORT}/mcp`));
  } else {
    await buildServer().connect(new StdioServerTransport());
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
