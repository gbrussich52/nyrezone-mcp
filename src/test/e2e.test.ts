// Spawns the built stdio server and drives it with the real MCP client. Upstream hosts
// are replaced by a local fixture HTTP server (via test-only env vars), so this proves the
// MCP wiring end to end without touching the live network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFileSync } from 'node:fs';
import { route } from './helpers.js';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const REQUIRED_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

function fixtureServer(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const r = route(`http://local${req.url}`);
      res.writeHead(r?.status ?? 404, { 'content-type': r?.type ?? 'text/plain' });
      res.end(r?.body ?? 'no fixture');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const textOf = (r: { content?: unknown }): string => ((r.content as { type: string; text: string }[])[0]?.text ?? '');

test('e2e: stdio server lists 3 read-only tools and answers each one', async () => {
  const { server, base } = await fixtureServer();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    env: { ...(process.env as Record<string, string>), NYREZONE_MCP_BASE_URL: base, NYREZONE_MCP_GEOSEARCH_URL: base, NYREZONE_MCP_MIN_INTERVAL_MS: '0' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'nyrezone-e2e', version: '0.0.0' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, '0.2.0');
    for (const name of ['package.json', 'package-lock.json', 'server.json']) {
      const manifest = JSON.parse(readFileSync(join(dirname(cliPath), '..', name), 'utf8'));
      assert.equal(manifest.version, '0.2.0', name);
      if (manifest.packages) {
        assert.equal(Array.isArray(manifest.packages) ? manifest.packages[0].version : manifest.packages[''].version, '0.2.0', name);
      }
    }
    assert.match(client.getInstructions() ?? '', /calculation fields are always null/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['get_zoning_district', 'list_zoning_districts', 'lookup_lot']);
    for (const t of tools) {
      for (const h of REQUIRED_HINTS) assert.equal(typeof t.annotations?.[h], 'boolean', `${t.name} missing ${h}`);
      assert.equal(t.annotations?.readOnlyHint, true);
      assert.equal(t.annotations?.destructiveHint, false);
      assert.ok((t.description ?? '').length > 40);
    }

    const lookup = tools.find((t) => t.name === 'lookup_lot')!;
    assert.doesNotMatch(lookup.description ?? '', /built vs. allowed|estimated unused floor area|sq ft allowed|overbuilt/i);
    const schema = lookup.outputSchema as { properties: { lot: { properties: { unused_floor_area: { properties: Record<string, { type: string }> } } } } };
    for (const key of ['estimate_sqft', 'allowed_floor_area_sqft', 'governing_far', 'overbuilt']) {
      assert.equal(schema.properties.lot.properties.unused_floor_area.properties[key].type, 'null', key);
    }

    const lot = await client.callTool({ name: 'lookup_lot', arguments: { bbl: '3052410015' } });
    assert.ok(!lot.isError, textOf(lot));
    assert.match(textOf(lot), /Zoning: R7A/);
    assert.ok(lot.structuredContent);
    assert.ok(!JSON.stringify(lot).toLowerCase().includes('owner'), 'no owner data over the wire');

    for (const bbl of ['3052410015', '1008350041', '3000000004']) {
      const result = bbl === '3052410015' ? lot : await client.callTool({ name: 'lookup_lot', arguments: { bbl } });
      assert.ok(!result.isError, textOf(result));
      const data = result.structuredContent as { lot: { unused_floor_area: Record<string, unknown> } };
      for (const key of ['estimate_sqft', 'allowed_floor_area_sqft', 'governing_far', 'overbuilt']) {
        assert.ok(Object.hasOwn(data.lot.unused_floor_area, key), `${bbl}: ${key} retained`);
        assert.equal(data.lot.unused_floor_area[key], null, `${bbl}: ${key}`);
      }
      assert.equal(data.lot.unused_floor_area.basis, 'not determined from recorded parcel data');
      assert.doesNotMatch(textOf(result), /16,094|sq ft allowed|overbuilt|about 0 sq ft/i);
      assert.ok(!JSON.stringify(result).toLowerCase().includes('owner'));
    }

    const byAddr = await client.callTool({ name: 'lookup_lot', arguments: { address: '1187 Ocean Ave, Brooklyn' } });
    assert.ok(!byAddr.isError, textOf(byAddr));
    assert.match(textOf(byAddr), /BBL 3052410015/);

    const dist = await client.callTool({ name: 'get_zoning_district', arguments: { code: 'R6A' } });
    assert.ok(!dist.isError, textOf(dist));
    assert.match(textOf(dist), /Max residential FAR: 3\.0/);

    const list = await client.callTool({ name: 'list_zoning_districts', arguments: {} });
    assert.ok(!list.isError, textOf(list));
    assert.equal((list.structuredContent as { count: number }).count, 51);

    // Error paths must come back as tool errors, not protocol failures.
    const bad = await client.callTool({ name: 'lookup_lot', arguments: { bbl: 'nope' } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /10-digit/);
    const unknown = await client.callTool({ name: 'get_zoning_district', arguments: { code: 'ZZ9' } });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /R6A/);
  } finally {
    await client.close();
    server.close();
  }
});
