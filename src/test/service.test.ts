import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../client.js';
import { getDistrict, listDistricts, lookupLot, type Outcome } from '../service.js';
import { fx, mockFetch } from './helpers.js';

function setup(opts: ConstructorParameters<typeof HttpClient>[0] = {}) {
  const m = mockFetch();
  const client = new HttpClient({ fetchImpl: m.fetchImpl, minIntervalMs: 0, ...opts });
  return { client, calls: m.calls };
}
function err<T>(o: Outcome<T>): string {
  assert.equal(o.ok, false, 'expected an error outcome');
  return (o as { error: string }).error;
}
function okText<T>(o: Outcome<T>): string {
  assert.equal(o.ok, true, o.ok ? '' : (o as { error: string }).error);
  return (o as { text: string }).text;
}

test('lookup_lot by BBL returns recorded zoning, FAR and areas without capacity calculations', async () => {
  const { client } = setup();
  const o = await lookupLot(client, { bbl: '3052410015' });
  const text = okText(o);
  assert.match(text, /Zoning: R7A/);
  assert.match(text, /Lot area: 4,675 sq ft/);
  assert.match(text, /development capacity: not determined from recorded parcel data/);
  assert.doesNotMatch(text, /16,094|sq ft allowed|overbuilt|FAR-based estimate/i);
  assert.match(text, /MapPLUTO release reported by NYRezone: MapPLUTO 26v2/);
  assert.match(text, /https:\/\/nyrezone\.com\/zoning\/r7a/);
  assert.match(text, /Full report: https:\/\/nyrezone\.com\/map\?bbl=3052410015/);
  assert.match(text, /not legal, architectural/);
  assert.ok(!/TEST OWNER NAME/i.test(text) && !/owner/i.test(text), 'no owner data in output');
  if (o.ok) assert.ok(!JSON.stringify(o.data).toLowerCase().includes('owner'));
});

test('lookup_lot by address resolves through geosearch, deduping lots that share a BBL', async () => {
  const { client } = setup();
  const o = await lookupLot(client, { address: '1187 Ocean Ave Brooklyn' });
  const text = okText(o);
  assert.match(text, /BBL 3052410015/);
  assert.match(text, /Matched from your address/);
  if (o.ok) assert.equal(o.data.resolved_from, 'address');
});

test('lookup_lot reports an ambiguous address instead of guessing', async () => {
  const { client } = setup();
  const msg = err(await lookupLot(client, { address: '50 Test Ave' }));
  assert.match(msg, /more than one tax lot/);
  assert.match(msg, /3000010001/);
  assert.match(msg, /4000010001/);
});

test('lookup_lot reports an unknown address, and ignores near-miss streets', async () => {
  const { client } = setup();
  assert.match(err(await lookupLot(client, { address: '99999 Nowhere Blvd Brooklyn' })), /No tax lot found/);
  assert.match(err(await lookupLot(client, { address: '100 Main St' })), /No tax lot found/);
});

test('lookup_lot reports a BBL with no record', async () => {
  const { client } = setup();
  assert.match(err(await lookupLot(client, { bbl: '3999999999' })), /No MapPLUTO record found for BBL 3999999999/);
});

test('lookup_lot rejects bad, empty, huge and injection-looking input without calling upstream', async () => {
  const { client, calls } = setup();
  const inputs: { bbl?: string; address?: string }[] = [
    {}, { bbl: '' }, { address: '' }, { bbl: '3052410015', address: '1187 Ocean Ave' },
    { bbl: '12345' }, { bbl: "3052410015'; DROP TABLE lots;--" }, { bbl: '../../etc/passwd' }, { bbl: 'x'.repeat(100000) },
    { address: 'x'.repeat(100000) }, { address: "'; DROP TABLE lots;--" }, { address: '<script>alert(1)</script>' },
    { address: '../../etc/passwd' }, { address: 'Ocean Avenue' }, { address: '1187 Ocean\u0000Ave' },
  ];
  for (const input of inputs) {
    const o = await lookupLot(client, input);
    assert.equal(o.ok, false, `should reject ${JSON.stringify(input).slice(0, 60)}`);
  }
  assert.equal(calls.length, 0, 'invalid input must never reach the network');
});

test('lookup_lot URL-encodes a hostile but well-formed address', async () => {
  const { client, calls } = setup();
  await lookupLot(client, { address: '1187 Ocean Ave & x=1#frag?y=2' });
  const geo = calls.find((c) => c.url.includes('/v2/search'));
  assert.ok(geo);
  const u = new URL(geo.url);
  assert.equal(u.searchParams.get('text'), '1187 Ocean Ave & x=1#frag?y=2');
  assert.equal(u.searchParams.has('x'), false);
});

test('get_zoning_district returns rules and a source line (R6A, any case, with slash form)', async () => {
  const { client } = setup();
  const text = okText(await getDistrict(client, 'r6a'));
  assert.match(text, /Max residential FAR: 3\.0/);
  assert.match(text, /Max building height: 75 ft/);
  assert.match(text, /MapPLUTO release reported by NYRezone: MapPLUTO 26v2/);
  assert.match(text, /https:\/\/nyrezone\.com\/zoning\/r6a/);
  assert.match(text, /Source: NYRezone HTML district summary/);
  assert.match(text, /not independently verified against the NYC Zoning Resolution/);
  assert.doesNotMatch(text, /rule values from the NYC Zoning Resolution/);
  const slash = await getDistrict(client, ' m1-2/r6a ');
  assert.match(okText(slash), /no bulk\/height\/setback rules table/);
});

test('get_zoning_district lists valid codes for an unknown or malformed code', async () => {
  const { client } = setup();
  const unknown = err(await getDistrict(client, 'ZZ9'));
  assert.match(unknown, /Unknown zoning district "ZZ9"/);
  assert.match(unknown, /R6A/);
  assert.match(err(await getDistrict(client, "R6A'; DROP TABLE x")), /not a valid district code/);
  assert.match(err(await getDistrict(client, 'A'.repeat(5000))), /not a valid district code/);
  assert.match(err(await getDistrict(client, '')), /not a valid district code/);
});

test('list_zoning_districts lists 51 codes, optionally filtered by family', async () => {
  const { client } = setup();
  const all = await listDistricts(client);
  assert.equal(all.ok && all.data.count, 51);
  assert.match(okText(all), /R6A - Mid-density apartment/);
  const r6 = await listDistricts(client, 'r6');
  assert.deepEqual(r6.ok && r6.data.districts.map((d) => d.code), ['R6', 'R6A', 'R6B']);
  assert.match(err(await listDistricts(client, 'Q9')), /No districts in family/);
  assert.match(err(await listDistricts(client, "R6'; --")), /family must be/);
});

test('client sends a descriptive User-Agent, caches responses, and stays inside the fixture map', async () => {
  const { client, calls } = setup();
  await lookupLot(client, { bbl: '3052410015' });
  const before = calls.length;
  await lookupLot(client, { bbl: '3052410015' });
  assert.equal(calls.length, before, 'second identical lookup should be served from cache');
  for (const c of calls) {
    assert.match(c.headers['user-agent'], /^nyrezone-mcp\/\d/);
    assert.match(c.url, /^https:\/\/(nyrezone\.com|geosearch\.planninglabs\.nyc)\//);
  }
});

test('upstream failures become clear errors: timeout, 500, 429, network, oversized', async () => {
  const mk = (impl: typeof fetch, extra: ConstructorParameters<typeof HttpClient>[0] = {}) =>
    new HttpClient({ fetchImpl: impl, minIntervalMs: 0, ...extra });
  const hang = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
  assert.match(err(await lookupLot(mk(hang, { timeoutMs: 30 }), { bbl: '3052410015' })), /timed out/);
  assert.match(err(await lookupLot(mk((async () => new Response('x', { status: 500 })) as typeof fetch), { bbl: '3052410015' })), /returned an error/);
  assert.match(err(await lookupLot(mk((async () => new Response('x', { status: 429 })) as typeof fetch), { bbl: '3052410015' })), /slow down/);
  assert.match(err(await lookupLot(mk((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch), { bbl: '3052410015' })), /Could not reach/);
  assert.match(err(await lookupLot(mk((async () => new Response('x'.repeat(5000))) as typeof fetch, { maxBytes: 1000 }), { bbl: '3052410015' })), /unexpectedly large/);
  assert.match(err(await lookupLot(mk((async () => new Response('not json')) as typeof fetch), { bbl: '3052410015' })), /unreadable/);
});

test('client caps its own request rate', async () => {
  const { client } = setup({ maxRequestsPerMinute: 2 });
  await lookupLot(client, { bbl: '3052410015' }); // pluto + methodology = 2 requests
  const msg = err(await lookupLot(client, { bbl: '1008350041' }));
  assert.match(msg, /limiting itself/);
});

test('a changed page format yields a clear error, not wrong numbers', async () => {
  const fetchImpl = (async (u: string | URL | Request) => String(u).endsWith('/zoning')
    ? new Response('<html><h2>Nothing useful</h2></html>')
    : new Response('x')) as typeof fetch;
  const client = new HttpClient({ fetchImpl, minIntervalMs: 0 });
  assert.match(err(await getDistrict(client, 'R6A')), /format looks different/);
});

test('borough hint comes from the borough part, not the street name: "100 Manhattan Ave, Brooklyn" is the Brooklyn lot', async () => {
  const { client } = setup();
  const text = okText(await lookupLot(client, { address: '100 Manhattan Ave, Brooklyn' }));
  assert.match(text, /BBL 3030700001/);
  assert.ok(!/1018407501/.test(text));
});

test('same street name with no borough given is ambiguous across boroughs, never a guess', async () => {
  const { client } = setup();
  const msg = err(await lookupLot(client, { address: '100 Manhattan Ave' }));
  assert.match(msg, /more than one tax lot/);
  assert.match(msg, /3030700001/);
  assert.match(msg, /1018407501/);
});

test('a 200 with an error body or an empty object is an error, not a lot of unknowns', async () => {
  const { client } = setup();
  assert.match(err(await lookupLot(client, { bbl: '3000000001' })), /no usable lot data/);
  assert.match(err(await lookupLot(client, { bbl: '3000000002' })), /no usable lot data/);
});

test('district_pages only links districts that exist in the index', async () => {
  const { client } = setup();
  const o = await lookupLot(client, { bbl: '3000000003' });
  const text = okText(o);
  assert.ok(!/zoning\/r99/.test(text));
  if (o.ok) assert.deepEqual(o.data.district_pages, []);
});

test('an index failure does not fail the lot lookup', async () => {
  const m = mockFetch();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/zoning') throw new Error('down');
    return m.fetchImpl(input, init);
  }) as typeof fetch;
  const client = new HttpClient({ fetchImpl, minIntervalMs: 0 });
  assert.match(okText(await lookupLot(client, { bbl: '3052410015' })), /Zoning: R7A/);
});

test('cache is bounded at 500 entries', async () => {
  const fetchImpl = (async () => new Response('x', { status: 200 })) as typeof fetch;
  const client = new HttpClient({ fetchImpl, minIntervalMs: 0, maxRequestsPerMinute: 10_000 });
  for (let i = 0; i < 520; i++) await client.getText(`https://nyrezone.com/p/${i}`, 'text/html');
  assert.equal(client.cacheSize, 500);
});

test('a response that ends up on another origin is rejected', async () => {
  const fetchImpl = (async () => {
    const r = new Response('x', { status: 200 });
    Object.defineProperty(r, 'url', { value: 'https://evil.example/landed' });
    return r;
  }) as typeof fetch;
  const client = new HttpClient({ fetchImpl, minIntervalMs: 0 });
  await assert.rejects(() => client.getText('https://nyrezone.com/api/pluto?bbl=1', 'application/json'), /unexpected host/);
});

test('lot source labels an unavailable or missing methodology stamp unknown without guessing', async () => {
  for (const mode of ['network', '404', 'missing']) {
    const m = mockFetch();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/methodology') {
        if (mode === 'network') throw new Error('down');
        return new Response('<html>no release stamp</html>', { status: mode === '404' ? 404 : 200 });
      }
      return m.fetchImpl(input, init);
    }) as typeof fetch;
    const o = await lookupLot(new HttpClient({ fetchImpl, minIntervalMs: 0 }), { bbl: '3052410015' });
    const text = okText(o);
    assert.match(text, /MapPLUTO release reported by NYRezone: unknown/);
    assert.match(text, /not independently validated for this result/);
    assert.doesNotMatch(text, /26v2|checked \d/);
  }
});

test('district source labels a missing page stamp unknown and keeps scraped-summary provenance', async () => {
  const m = mockFetch();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/zoning/r6a') {
      return new Response(fx('zoning_r6a.html').replaceAll('MapPLUTO 26v2', 'MapPLUTO unknown'));
    }
    return m.fetchImpl(input, init);
  }) as typeof fetch;
  const o = await getDistrict(new HttpClient({ fetchImpl, minIntervalMs: 0 }), 'R6A');
  const text = okText(o);
  assert.match(text, /Source: NYRezone HTML district summary/);
  assert.match(text, /MapPLUTO release reported by NYRezone: unknown/);
  if (o.ok) assert.equal(o.data.dataVintage, null);
});
