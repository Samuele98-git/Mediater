// Parses scene-style release / file names such as
//   "The.Matrix.1999.1080p.BluRay.x264-GROUP"
//   "Breaking Bad S02E05 720p WEB-DL"
//   "Show Name Season 3 Complete 1080p"
// into { title, year, season, episode, quality, ... }.
import path from 'path';

export const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.3gp', '.divx']);
export const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);

export const extOf = (name) => path.extname(String(name || '')).toLowerCase();
export const isVideoFile = (name) => VIDEO_EXT.has(extOf(name));
export const isSubtitleFile = (name) => SUB_EXT.has(extOf(name));
// Artwork that often ships inside releases (poster.jpg, fanart.jpg, folder.jpg…)
export const ART_RE = /^(poster|cover|folder|movie|fanart|backdrop|background|banner|clearlogo|logo|landscape|thumb)\.(jpe?g|png|webp)$/i;
export const isArtworkFile = (name, size = 0) => ART_RE.test(path.basename(String(name))) && size < 25 * 1024 * 1024;
// "Sample" clips that ship with many releases
export const isSampleFile = (name, size = 0) =>
    /(^|[\W_])sample([\W_]|$)/i.test(path.basename(String(name))) && size < 400 * 1024 * 1024;

function smartCase(t) {
    if (!t) return t;
    const letters = t.replace(/[^a-zA-Z]/g, '');
    if (letters && (letters === letters.toLowerCase() || letters === letters.toUpperCase())) {
        return t.toLowerCase().replace(/(^|\s|-)([a-z])/g, (m, a, b) => a + b.toUpperCase());
    }
    return t;
}

const TITLE_TRAIL = new Set([' ', '\t', '-', '–', ':', ',', '(', '[', '{']);

// Program files: a movie or a TV show never needs them (fake releases carrying malware do).
export const EXECUTABLE_RE = /\.(exe|msi|bat|cmd|scr|com|pif|vbs|vbe|jse?|wsf|jar|apk|lnk|ps1|dll|reg|hta|cpl|msc)$/i;
export const isExecutableFile = (name) => EXECUTABLE_RE.test(String(name || ''));

export function parseRelease(raw) {
    const out = {
        title: '', year: null, season: null, episode: null, episodeEnd: null,
        quality: null, source: null, codec: null, hdr: false, pack: false
    };
    if (!raw) return out;

    let s = String(raw).trim();
    const ext = extOf(s);
    if (VIDEO_EXT.has(ext) || SUB_EXT.has(ext) || ext === '.torrent') s = s.slice(0, -ext.length);
    // Names come from strangers' torrents: keep them short so no pattern can get slow.
    s = s.slice(0, 300);
    s = s.replace(/^\s*(\[[^\]]*\]\s*)+/, '');          // leading [Group] tags
    s = s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

    const cuts = [];
    const take = (re, fn) => {
        const m = s.match(re);
        if (m) { if (fn) fn(m); cuts.push(m.index); }
        return m;
    };

    // Season / episode markers
    take(/\bS(\d{1,2}) ?E(\d{1,3})(?: ?-? ?E(\d{1,3}))?\b/i, m => {
        out.season = +m[1]; out.episode = +m[2]; if (m[3]) out.episodeEnd = +m[3];
    })
        || take(/\b(\d{1,2})x(\d{2,3})\b/i, m => { out.season = +m[1]; out.episode = +m[2]; })
        || take(/\b(?:Season|Stagione|Temporada|Saison|Sezon|Staffel) ?(\d{1,2})\b/i, m => { out.season = +m[1]; out.pack = true; })
        || take(/\bS(\d{1,2})(?:-S?\d{1,2})?\b/i, m => { out.season = +m[1]; out.pack = true; });
    if (/\b(Complete|Completa|Integrale|Collection)\b/i.test(s)) {
        out.pack = true;
        take(/\b(Complete|Completa|Integrale)\b/i);
    }
    // Anime style "Title - 05"
    if (out.episode == null) {
        take(/\s-\s(\d{2,3})(?:v\d)?(?=$|\s|\[|\()/, m => {
            const n = +m[1];
            if (n < 1900) { out.episode = n; if (out.season == null) out.season = 1; }
        });
    }

    // Year: the last plausible year that is not the very start of the name
    // (so "1917 2019 1080p" -> title "1917", year 2019).
    const yearRe = /(^|[\s(\[])((?:19[2-9]|20[0-4])\d)(?=$|[\s)\],])/g;
    let ym; const years = [];
    while ((ym = yearRe.exec(s))) years.push({ year: +ym[2], index: ym.index + ym[1].length, bracket: ym[1] === '(' || ym[1] === '[' });
    const usable = years.filter(y => y.index > 0);
    if (usable.length) {
        const pick = usable[usable.length - 1];
        out.year = pick.year;
        cuts.push(pick.bracket ? pick.index - 1 : pick.index);
    }

    take(/\b(2160p|4K|UHD|1080p|1080i|720p|576p|480p)\b/i, m => {
        const q = m[1].toLowerCase();
        out.quality = (q === '2160p' || q === '4k' || q === 'uhd') ? '4K' : q.replace('i', 'p');
    });
    take(/\b(BluRay|Blu-Ray|BDRip|BRRip|BDRemux|REMUX|WEB-?DL|WEB-?Rip|HDTV|HDRip|DVDRip|DVDScr|HDCAM)\b/i, m => { out.source = m[1]; })
        || take(/\b(WEB|DVD|CAM)\b/, m => { out.source = m[1]; });
    take(/\b(x264|x265|H ?264|H ?265|HEVC|AVC|AV1|XviD|DivX|VP9)\b/i, m => { out.codec = m[1].toUpperCase().replace(' ', ''); });
    if (/\b(HDR10\+?|HDR|Dolby ?Vision|DoVi)\b/i.test(s)) { out.hdr = true; take(/\b(HDR10\+?|HDR|Dolby ?Vision|DoVi)\b/i); }
    take(/\b(PROPER|REPACK|EXTENDED|UNRATED|REMASTERED|IMAX|10bit|8bit|AAC\d?|AC3|DTS(?:-HD)?|DDP?\d?|TrueHD|Atmos)\b/i);
    take(/\b(ITA|ENG|MULTi|DUAL|SUBBED|DUBBED|SUB ?ITA)\b/);

    const end = cuts.length ? Math.min(...cuts) : s.length;
    let title = s.slice(0, end);
    let k = title.length;
    while (k > 0 && TITLE_TRAIL.has(title[k - 1])) k--; // (a loop: a /[…]+$/ regex is quadratic)
    title = title.slice(0, k).replace(/^[\s\-–]+/, '').trim();
    if (!title) title = s.split(/\s(?:S\d|\d{3,4}p)/i)[0].trim() || s;
    out.title = smartCase(title);
    return out;
}

// Turns a file list into "episodes" when a torrent looks like a season pack.
export function detectEpisodes(files) {
    const eps = [];
    for (const f of files) {
        if (!isVideoFile(f.name) || isSampleFile(f.name, f.length)) continue;
        const p = parseRelease(f.name);
        let season = p.season, episode = p.episode;
        if (episode == null) {
            // fall back to the folder name for the season ("Season 2/03 - Title.mkv")
            const dir = parseRelease(path.dirname(f.path || ''));
            const m = path.basename(f.name).match(/^(\d{1,3})[\s.\-_]/);
            if (m) { episode = +m[1]; season = season ?? dir.season ?? 1; }
        }
        if (episode != null) eps.push({ index: f.index, season: season ?? 1, episode, name: f.name });
    }
    eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return eps;
}
