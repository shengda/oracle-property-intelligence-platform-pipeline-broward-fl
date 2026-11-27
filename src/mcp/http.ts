import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { createRateLimiter } from "./rate-limit.ts";

/**
 * Mount a stateless Streamable HTTP MCP endpoint (JSON responses, no session store), so any
 * instance — a laptop or a Lambda — can answer any request. A fresh server + transport per
 * request; GET/DELETE (SSE streams, session teardown) are not offered in stateless mode.
 */
export function mountMcpHttp(
  app: FastifyInstance,
  createServer: () => McpServer,
  opts: { path?: string; rateLimitPerMinute?: number } = {},
): void {
  const path = opts.path ?? "/mcp";
  const limiter = createRateLimiter({ limit: opts.rateLimitPerMinute ?? 60 });

  app.post(path, async (req, reply) => {
    if (!limiter.allow(req.ip)) {
      return reply.code(429).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Rate limit exceeded: try again in a minute." },
        id: null,
      });
    }
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = async (_req: unknown, reply: any) =>
    reply
      .code(405)
      .header("allow", "POST")
      .send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed: this MCP endpoint is stateless (POST only)." },
        id: null,
      });
  app.get(path, notAllowed);
  app.delete(path, notAllowed);
}
