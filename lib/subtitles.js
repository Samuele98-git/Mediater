// Subtitle helpers: SRT -> WebVTT, charset repair, language guessing.
import path from 'path';

const LANG_WORDS = {
    en: ['en', 'eng', 'english', 'inglese'],
    it: ['it', 'ita', 'italian', 'italiano'],
    es: ['es', 'spa', 'esp', 'spanish', 'espanol', 'español', 'castellano', 'latino', 'lat'],
    fr: ['fr', 'fre', 'fra', 'french', 'francais', 'français', 'vf', 'vff'],
    de: ['de', 'ger', 'deu', 'german', 'deutsch'],
    tr: ['tr', 'tur', 'turkish', 'turkce', 'türkçe'],
    pt: ['pt', 'por', 'portuguese', 'portugues', 'português', 'ptbr', 'brazilian', 'pob'],
    nl: ['nl', 'dut', 'nld', 'dutch'],
    ru: ['ru', 'rus', 'russian'],
    ja: ['ja', 'jpn', 'japanese'],
    ko: ['ko', 'kor', 'korean'],
    zh: ['zh', 'chi', 'zho', 'chinese', 'chs', 'cht'],
    ar: ['ar', 'ara', 'arabic'],
    pl: ['pl', 'pol', 'polish'],
    sv: ['sv', 'swe', 'swedish'],
    da: ['da', 'dan', 'danish'],
    no: ['no', 'nor', 'norwegian'],
    fi: ['fi', 'fin', 'finnish'],
    el: ['el', 'gre', 'ell', 'greek'],
    he: ['he', 'heb', 'hebrew'],
    ro: ['ro', 'rum', 'ron', 'romanian'],
    hu: ['hu', 'hun', 'hungarian'],
    cs: ['cs', 'cze', 'ces', 'czech']
};
const WORD_TO_LANG = {};
for (const [code, words] of Object.entries(LANG_WORDS)) for (const w of words) WORD_TO_LANG[w] = code;

/** Guesses { lang, forced, sdh } from a subtitle file name like "Movie.2010.ita.forced.srt". */
export function guessSubtitleInfo(fileName) {
    const base = path.basename(String(fileName)).replace(/\.[^.]+$/, '').toLowerCase();
    const tokens = base.split(/[^a-zà-ÿ]+/i).filter(Boolean);
    let lang = 'und';
    // Look from the end: language tags sit right before the extension.
    for (let i = tokens.length - 1; i >= 0 && i >= tokens.length - 4; i--) {
        const code = WORD_TO_LANG[tokens[i]];
        // two-letter tokens only count at the very end ("movie.en.srt")
        if (code && (tokens[i].length > 2 || i === tokens.length - 1 || i === tokens.length - 2)) { lang = code; break; }
    }
    if (lang === 'und') {
        for (const t of tokens) if (t.length > 3 && WORD_TO_LANG[t]) { lang = WORD_TO_LANG[t]; break; }
    }
    return {
        lang,
        forced: tokens.includes('forced') || tokens.includes('forzati'),
        sdh: tokens.includes('sdh') || tokens.includes('cc') || tokens.includes('hi')
    };
}

export function languageName(code, uiLang = 'en') {
    if (!code || code === 'und') return '';
    try {
        const name = new Intl.DisplayNames([uiLang], { type: 'language' }).of(code);
        return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
    } catch { return code; }
}

/** Decodes subtitle bytes: UTF-8 (with BOM) or UTF-16, falling back to Windows-1252. */
export function decodeSubtitle(buf) {
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\ufeff/, '');
    } catch {
        return new TextDecoder('windows-1252').decode(buf);
    }
}

/** Converts SRT text to WebVTT. WebVTT input is passed through. */
export function toVtt(text) {
    let t = String(text).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
    if (/^WEBVTT/.test(t.trimStart())) return t;
    t = t
        // 00:00:01,000 --> 00:00:04,000  =>  00:00:01.000 --> 00:00:04.000
        .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
        // drop ASS-style position tags that some SRTs carry ({\an8})
        .replace(/\{\\[^}]*\}/g, '');
    return 'WEBVTT\n\n' + t.trim() + '\n';
}

/** Shifts every cue in a VTT document by `offset` seconds (can be negative). */
export function shiftVtt(vtt, offset) {
    if (!offset) return vtt;
    const fmt = (s) => {
        s = Math.max(0, s);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
    };
    const parse = (ts) => {
        const p = ts.split(':').map(Number);
        return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    };
    return vtt.replace(/((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})/g,
        (m, a, b) => `${fmt(parse(a) + offset)} --> ${fmt(parse(b) + offset)}`);
}
