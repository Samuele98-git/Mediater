import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

export const SUPPORTED = ['en', 'it', 'tr', 'fr', 'es'];
export const LANG_LABELS = {
    en: 'English',
    it: 'Italiano',
    tr: 'Türkçe',
    fr: 'Français',
    es: 'Español'
};
export const DATE_LOCALES = {
    en: 'en-US', it: 'it-IT', tr: 'tr-TR', fr: 'fr-FR', es: 'es-ES'
};

const cache = {};

export function loadLocale(code) {
    const c = SUPPORTED.includes(code) ? code : 'en';
    if (cache[c]) return cache[c];
    try {
        const file = path.join(LOCALES_DIR, c + '.json');
        cache[c] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
        console.error(`[i18n] Failed to load locale ${c}:`, e.message);
        cache[c] = {};
    }
    return cache[c];
}

function getPath(obj, key) {
    return key.split('.').reduce((o, p) => (o && o[p] !== undefined) ? o[p] : undefined, obj);
}

export function makeT(dict) {
    const fallback = loadLocale('en');
    return function t(key, vars) {
        let v = getPath(dict, key);
        if (v === undefined) v = getPath(fallback, key);
        if (v === undefined) return key;
        if (vars && typeof v === 'string') {
            for (const [k, val] of Object.entries(vars)) {
                v = v.split('{' + k + '}').join(String(val));
            }
        }
        return v;
    };
}

export function pickLang(code) {
    return SUPPORTED.includes(code) ? code : 'en';
}
