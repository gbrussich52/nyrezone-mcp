// Parsers for the server-rendered nyrezone.com pages. They fail loudly (ParseError)
// when the markup no longer has the expected landmarks, so a site redesign surfaces
// as a clear error instead of silently wrong zoning numbers.

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeText(html: string): string {
  return html
    .replace(/<!--.*?-->/gs, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DistrictIndexEntry {
  code: string;
  slug: string;
  family: string;
  familyLabel: string;
}

/** Parses https://nyrezone.com/zoning: family headings, each followed by its district links. */
export function parseZoningIndex(html: string): DistrictIndexEntry[] {
  const out: DistrictIndexEntry[] = [];
  const re = /<h2[^>]*>(.*?)<\/h2>\s*<p[^>]*>(.*?)<\/p>/gs;
  for (const m of html.matchAll(re)) {
    const heading = decodeText(m[1]);
    const parts = heading.split(/\s+[—–-]\s+/);
    if (parts.length < 2) continue;
    const links = [...m[2].matchAll(/<a[^>]*href="\/zoning\/([a-z0-9-]+)"[^>]*>(.*?)<\/a>/gs)];
    for (const l of links) {
      out.push({ code: decodeText(l[2]), slug: l[1], family: parts[0], familyLabel: parts.slice(1).join(' - ') });
    }
  }
  if (out.length === 0) throw new ParseError('The NYRezone zoning index no longer has the expected structure.');
  return out;
}

export interface RuleRow {
  rule: string;
  value: string;
  note: string;
}

export interface DistrictPage {
  code: string;
  summary: string;
  rules: RuleRow[];
  stats: Record<string, string>;
  boroughs: { borough: string; parcels: string }[];
  dataVintage: string | null;
  dataCheckedOn: string | null;
}

const STAT_LABELS = ['Parcels citywide', 'High-opportunity lots', 'Avg built FAR', 'Avg max resid. FAR'];

/** Parses https://nyrezone.com/zoning/<slug>. Not every district has a rules table. */
export function parseDistrictPage(html: string): DistrictPage {
  const h1 = html.match(/<h1[^>]*>(.*?)<\/h1>/s);
  if (!h1) throw new ParseError('District page has no heading; the page format may have changed.');
  const code = decodeText(h1[1]).replace(/\s+Zoning in NYC\s*$/i, '').trim();
  const after = html.slice(h1.index! + h1[0].length);
  const intro = after.match(/<p[^>]*>(.*?)<\/p>/s);
  if (!code || !intro) throw new ParseError('District page is missing its summary; the page format may have changed.');

  const rules: RuleRow[] = [];
  const table = html.match(/<table[\s\S]*?<\/table>/);
  if (table) {
    for (const row of table[0].matchAll(/<tr[^>]*>\s*<th[^>]*scope="row"[^>]*>(.*?)<\/th>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gs)) {
      rules.push({ rule: decodeText(row[1]), value: decodeText(row[2]), note: decodeText(row[3]) });
    }
  }

  const stats: Record<string, string> = {};
  for (const m of html.matchAll(/<div[^>]*>([^<]{1,20})<\/div><div[^>]*>([^<]{1,40})<\/div>/g)) {
    const label = decodeText(m[2]);
    if (STAT_LABELS.includes(label)) stats[label] = decodeText(m[1]);
  }

  const boroughs: { borough: string; parcels: string }[] = [];
  for (const m of html.matchAll(/<li><a[^>]*href="\/boroughs\/[a-z-]+"[^>]*>(.*?)<\/a>:\s*(?:<!-- -->)?([\d,]+)(?:<!-- -->)?\s*parcels<\/li>/gs)) {
    boroughs.push({ borough: decodeText(m[1]), parcels: m[2] });
  }

  const vintage = parseVintage(html);
  return { code, summary: decodeText(intro[1]), rules, stats, boroughs, dataVintage: vintage.release, dataCheckedOn: vintage.checkedOn };
}

/** Extracts "MapPLUTO 26v2" and the "checked <date>" stamp from a nyrezone page, if present. */
export function parseVintage(html: string): { release: string | null; checkedOn: string | null } {
  const text = decodeText(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  const rel = text.match(/MapPLUTO\s+(\d\d[vV]\d)/);
  const checked = text.match(/MapPLUTO\s+\d\d[vV]\d\s*\(checked\s+([^)]{3,30})\)/);
  return { release: rel ? `MapPLUTO ${rel[1]}` : null, checkedOn: checked ? checked[1].trim() : null };
}
