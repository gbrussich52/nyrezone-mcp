#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { VERSION } from './client.js';

if (process.argv.includes('--version')) {
  console.log(VERSION);
} else if (process.argv.includes('--help')) {
  console.error('nyrezone-mcp: MCP server (stdio) for public NYC zoning data via nyrezone.com. No flags; configure it in your MCP client.');
} else {
  // Test-only overrides so the end-to-end test can point at a local fixture server.
  const intervalEnv = Number(process.env.NYREZONE_MCP_MIN_INTERVAL_MS);
  serveStdio(() =>
    createServer({
      nyrezoneBase: process.env.NYREZONE_MCP_BASE_URL || undefined,
      geosearchBase: process.env.NYREZONE_MCP_GEOSEARCH_URL || undefined,
      minIntervalMs: Number.isFinite(intervalEnv) && process.env.NYREZONE_MCP_MIN_INTERVAL_MS ? intervalEnv : undefined,
    }),
  );
}
