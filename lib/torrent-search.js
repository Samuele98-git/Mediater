// Torrent search for the Downloads page (admin only).
//
// Sources:
//   • Internet Archive (built in) — public-domain and Creative Commons films and
//     TV from its curated collections. Every item has an official torrent with
//     archive.org itself as a web seed, so these are the safest downloads there are.
//   • Jackett / Prowlarr (optional) — Torznab feeds the admin adds in Settings.
//     Mediater has no built-in scrapers for other sites.
//
// Every result gets a safety rating; the safest results come first and risky or
// dead ones are hidden unless asked for.
import { parseRelease } from './release-name.js';
import { getSettings } from './settings.js';

const TIMEOUT = 15000;
const UA = 'Mediater (self-hosted media server)';
// Curated film/TV collections on archive.org (not the TV news archive, not trailers).
const IA_COLLECTIONS = [
    'feature_films', 'classic_tv', 'classic_tv_1950s', 'animationandcartoons', 'classic_cartoons', 'silent_films',
    'Film_Noir', 'SciFi_Horror', 'film_scifi', 'Comedy_Films', 'short_films', 'horror_movies'
];

// Things a movie or a TV show never needs.
const EXEC_IN_TITLE = /\.(exe|msi|bat|cmd|scr|pif|vbs|jar|apk|lnk|ps1)\b/i;
const ARCHIVE_IN_TITLE = /\.(zip|rar|7z)\b/i;
const SUSPICIOUS_WORDS = /\b(keygen|cracked|activator|serial[\s._-]?key|passworded|password|codec[\s._-]?pack|installer)\b/i;

const decodeXml = (s) => String(s || '')
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();

/** Rates how safe a result looks. level: 'safer' | 'ok' | 'dead' | 'risky'; reasons: keys shown in the UI. */
export function assessSafety(r) {
    if (r.trusted) return { level: 'safer', reasons: ['trusted'] };
    const title = String(r.title || '');
    const p = parseRelease(title);
    const properName = !!(p.quality || p.source || p.codec);
    const video = !r.categories || !r.categories.length || r.categories.some(c => (c >= 2000 && c < 3000) || (c >= 5000 && c < 6000));
    const red = [];
    if (EXEC_IN_TITLE.test(title)) red.push('program');
    if (ARCHIVE_IN_TITLE.test(title)) red.push('archive');
    if (SUSPICIOUS_WORDS.test(title) && !properName) red.push('keywords');
    if (video && r.size && r.size < 40 * 1024 * 1024) red.push('too_small');
    if (red.length) return { level: 'risky', reasons: red };
    if (r.seeders === 0) return { level: 'dead', reasons: ['no_seeders'] };
    const good = [];
    if (r.seeders >= 25) good.push('many_seeders');
    if (properName) good.push('proper_name');
    if (good.length === 2) return { level: 'safer', reasons: good };
    return { level: 'ok', reasons: r.seeders != null && r.seeders < 5 ? [...good, 'few_seeders'] : good };
}

// ------------------------------------------------------------ Internet Archive
async function searchArchive(q) {
    // Lucene special characters out: only words go in the query.
    const words = q.replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').replace(/(^|\s)-+/g, ' ').trim();
    if (!words) return [];
    const query = `title:(${words}) AND mediatype:movies AND collection:(${IA_COLLECTIONS.join(' OR ')}) AND -collection:movie_trailers`;
    const params = new URLSearchParams([['q', query], ['sort[]', 'downloads desc'], ['rows', '40'], ['output', 'json']]);
    for (const f of ['identifier', 'title', 'year', 'downloads', 'item_size', 'licenseurl', 'creator']) params.append('fl[]', f);
    const res = await fetch('https://archive.org/advancedsearch.php?' + params, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const docs = ((await res.json()).response || {}).docs || [];
    return docs.filter(d => d.identifier && d.title).map(d => {
        const id = encodeURIComponent(d.identifier);
        const year = parseInt(String(d.year || ''), 10) || null;
        const name = String(Array.isArray(d.title) ? d.title[0] : d.title).trim().slice(0, 300);
        return {
            source: 'Internet Archive', trusted: true,
            title: name + (year && !name.includes(String(year)) ? ` (${year})` : ''),
            // the torrent is named after the item id: keep the real title for the library
            hint: { title: name.replace(/\s*\(\d{4}\)\s*$/, ''), year },
            year, size: Number(d.item_size) || null, sizeIsMax: true,
            seeders: null, downloads: Number(d.downloads) || 0,
            link: `https://archive.org/download/${id}/${id}_archive.torrent`,
            page: `https://archive.org/details/${id}`,
            license: !d.licenseurl || /publicdomain/i.test(String(d.licenseurl)) ? 'pd' : 'cc'
        };
    });
}

// ------------------------------------------------------------ Torznab (Jackett / Prowlarr)
export function feedsFrom(settings) {
    return String(settings.TORZNAB_URLS || '').split(/\r?\n/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s)).slice(0, 20).map(url => {
        let name;
        try {
            const u = new URL(url);
            name = /\/api\/v2\.0\/indexers\//i.test(u.pathname) ? 'Jackett' : (u.port === '9696' || /^\/\d+\/api/.test(u.pathname)) ? 'Prowlarr' : u.hostname;
        } catch { name = 'Torznab'; }
        return { url, name };
    });
}

function torznabUrl(base, apiKey, q) {
    let raw = base.trim();
    if (/\/torznab\/?(\?|$)/i.test(raw)) raw = raw.replace(/\/torznab\/?(\?|$)/i, '/torznab/api$1');
    const u = new URL(raw);
    u.searchParams.set('t', 'search');
    u.searchParams.set('q', q);
    u.searchParams.set('cat', '2000,5000'); // movies and TV
    u.searchParams.set('limit', '100');
    if (apiKey && !u.searchParams.has('apikey')) u.searchParams.set('apikey', apiKey);
    return u;
}

export function parseTorznab(xml, fallbackName) {
    const out = [];
    const err = String(xml).match(/<error\b[^>]*description="([^"]*)"/i);
    if (err && !/<item\b/i.test(xml)) throw new Error(decodeXml(err[1]) || 'Indexer error');
    for (const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
        const body = m[1];
        const tag = (name) => { const t = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return t ? decodeXml(t[1]) : ''; };
        const attrs = {};
        for (const a of body.matchAll(/<(?:torznab|newznab):attr\b([^>]*)>/gi)) {
            const name = (a[1].match(/\bname="([^"]*)"/i) || [])[1];
            const value = (a[1].match(/\bvalue="([^"]*)"/i) || [])[1];
            if (name) (attrs[name.toLowerCase()] = attrs[name.toLowerCase()] || []).push(decodeXml(value || ''));
        }
        const one = (k) => (attrs[k] ? attrs[k][0] : undefined);
        const num = (v) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : null; };
        const enclosure = body.match(/<enclosure\b([^>]*)>/i);
        const encUrl = enclosure && (enclosure[1].match(/\burl="([^"]*)"/i) || [])[1];
        const encLen = enclosure && (enclosure[1].match(/\blength="(\d+)"/i) || [])[1];
        const linkTag = tag('link');
        const magnet = one('magneturl') || (/^magnet:/i.test(linkTag) ? linkTag : null) || (encUrl && /^magnet:/i.test(decodeXml(encUrl)) ? decodeXml(encUrl) : null);
        const link = magnet || (encUrl ? decodeXml(encUrl) : linkTag);
        const title = tag('title');
        if (!title || !link || !/^(magnet:|https?:\/\/)/i.test(link)) continue;
        const seeders = num(one('seeders'));
        const peers = num(one('peers'));
        out.push({
            source: tag('jackettindexer') || tag('prowlarrindexer') || fallbackName,
            title: title.slice(0, 300),
            size: num(tag('size')) || num(one('size')) || num(encLen),
            seeders, leechers: peers != null && seeders != null ? Math.max(0, peers - seeders) : null,
            categories: (attrs.category || []).map(Number).filter(Number.isFinite),
            infoHash: (one('infohash') || (magnet && (magnet.match(/btih:([a-f0-9]{40})/i) || [])[1]) || '').toLowerCase() || null,
            pubDate: tag('pubDate') || null,
            link, page: /^https?:/i.test(tag('comments')) ? tag('comments') : null
        });
    }
    return out;
}

async function searchTorznab(feed, apiKey, q) {
    const res = await fetch(torznabUrl(feed.url, apiKey, q), { signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' } });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'wrong API key' : `HTTP ${res.status}`);
    return parseTorznab(await res.text(), feed.name);
}

// ------------------------------------------------------------ everything together
const LEVEL_RANK = { safer: 0, ok: 1, dead: 2, risky: 3 };

/** Searches every configured source; safest results first. */
export async function searchTorrents(q) {
    const settings = await getSettings();
    const tasks = [];
    if (settings.SEARCH_ARCHIVE !== 'false') tasks.push({ name: 'Internet Archive', run: () => searchArchive(q) });
    for (const feed of feedsFrom(settings)) tasks.push({ name: feed.name, run: () => searchTorznab(feed, settings.TORZNAB_API_KEY, q) });
    const settled = await Promise.allSettled(tasks.map(t => t.run()));
    const errors = [];
    let results = [];
    settled.forEach((s, i) => {
        if (s.status === 'fulfilled') results.push(...s.value);
        else errors.push({ source: tasks[i].name, error: /abort|timeout/i.test(String(s.reason && s.reason.name) + String(s.reason && s.reason.message)) ? 'timed out' : String((s.reason && s.reason.message) || s.reason).slice(0, 120) });
    });
    // the same torrent from several indexers: keep the copy with the most seeders
    const byHash = new Map();
    results = results.filter(r => {
        if (!r.infoHash) return true;
        const prev = byHash.get(r.infoHash);
        if (prev && (prev.seeders || 0) >= (r.seeders || 0)) return false;
        if (prev) prev.duplicate = true;
        byHash.set(r.infoHash, r);
        return true;
    }).filter(r => !r.duplicate);
    for (const r of results) {
        r.safety = assessSafety(r);
        const p = parseRelease(r.title);
        r.quality = p.quality || null;
        r.codec = p.codec || null;
        r.hdr = p.hdr || false;
        r.season = p.season ?? null;
        r.episode = p.episode ?? null;
    }
    results.sort((a, b) => LEVEL_RANK[a.safety.level] - LEVEL_RANK[b.safety.level]
        || (b.seeders ?? -1) - (a.seeders ?? -1)
        || (b.downloads || 0) - (a.downloads || 0));
    return { query: q, sources: tasks.map(t => t.name), errors, results: results.slice(0, 150) };
}
