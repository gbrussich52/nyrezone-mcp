// Fixture routing shared by unit tests (injected fetch) and the stdio e2e test
// (local HTTP server). Nothing here touches the real network.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = join(here, '..', '..', 'fixtures');
export const fx = (name: string): string => readFileSync(join(fixturesDir, name), 'utf8');

export interface Routed {
  status: number;
  body: string;
  type: string;
}

const html = (body: string, status = 200): Routed => ({ status, body, type: 'text/html' });
const json = (body: string, status = 200): Routed => ({ status, body, type: 'application/json' });

/** Synthetic response (not recorded): two different lots on the same house number and street. */
function ambiguousGeo(): string {
  const base = JSON.parse(fx('geo_1187.json')) as { features: { properties: Record<string, unknown> }[] };
  const a = structuredClone(base.features[0]);
  const b = structuredClone(base.features[0]);
  Object.assign(a.properties, { label: '50 TEST AVENUE, Brooklyn, NY, USA', housenumber: '50', street: 'TEST AVENUE', borough: 'Brooklyn', addendum: { pad: { bbl: '3000010001' } } });
  Object.assign(b.properties, { label: '50 TEST AVENUE, Queens, NY, USA', housenumber: '50', street: 'TEST AVENUE', borough: 'Queens', addendum: { pad: { bbl: '4000010001' } } });
  return JSON.stringify({ geocoding: { query: { parsed_text: { housenumber: '50', street: 'Test Ave' } } }, features: [a, b] });
}

export function route(rawUrl: string): Routed | null {
  const u = new URL(rawUrl);
  if (u.pathname === '/api/pluto') {
    const bbl = u.searchParams.get('bbl');
    if (bbl === '3052410015') return json(fx('pluto_3052410015.json'));
    if (bbl === '1008350041') return json(fx('pluto_1008350041.json'));
    // Synthetic bodies (not recorded) for upstream-misbehaviour cases.
    if (bbl === '3030700001') return json(fx('pluto_3052410015.json').replace('3052410015', '3030700001')); // stand-in row; the test is about which BBL was resolved
    if (bbl === '3000000001') return json('{"error":"boom"}');
    if (bbl === '3000000002') return json('{}');
    if (bbl === '3000000003') return json(fx('pluto_3052410015.json').replace('"zonedist1":"R7A"', '"zonedist1":"R99"'));
    return json(fx('pluto_404.json'), 404);
  }
  if (u.pathname === '/zoning') return html(fx('zoning.html'));
  if (u.pathname === '/methodology') return html(fx('methodology.html'));
  const d = u.pathname.match(/^\/zoning\/([a-z0-9-]+)$/);
  if (d) {
    const map: Record<string, string> = { r6a: 'zoning_r6a.html', 'c4-2': 'zoning_c4-2.html', 'm1-2-r6a': 'zoning_m1-2-r6a.html' };
    return map[d[1]] ? html(fx(map[d[1]])) : html('<html>not found</html>', 404);
  }
  if (u.pathname === '/v2/search') {
    const text = (u.searchParams.get('text') ?? '').toLowerCase();
    if (text.includes('1187 ocean')) return json(fx('geo_1187.json'));
    if (text.includes('100 manhattan')) {
      const d = JSON.parse(fx('geo_100manhattan.json')) as { geocoding: { query: { parsed_text: Record<string, string> } } };
      // Without a borough in the query, Pelias gives no locality/admin to hint from.
      if (!text.includes('brooklyn')) {
        delete d.geocoding.query.parsed_text.locality;
        delete d.geocoding.query.parsed_text.admin;
      }
      return json(JSON.stringify(d));
    }
    if (text.includes('100 main')) return json(fx('geo_100main.json'));
    if (text.includes('99999 nowhere')) return json(fx('geo_none.json'));
    if (text.includes('50 test')) return json(ambiguousGeo());
    return json(JSON.stringify({ features: [] }));
  }
  return null;
}

export interface MockFetch {
  fetchImpl: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
}

/** fetch replacement; throws for any URL outside the fixture map so a live call can never slip in. */
export function mockFetch(): MockFetch {
  const calls: MockFetch['calls'] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = route(url);
    if (!r) throw new Error(`unexpected URL in test: ${url}`);
    return new Response(r.body, { status: r.status, headers: { 'content-type': r.type } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
