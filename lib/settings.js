// Admin-editable settings (stored in the Setting table) with a small cache.
import { EventEmitter } from 'events';
import prisma from './prisma.js';

export const settingsEvents = new EventEmitter();

let cache = null;
let loadedAt = 0;
const TTL = 30_000;

export async function getSettings() {
    if (cache && Date.now() - loadedAt < TTL) return cache;
    const rows = await prisma.setting.findMany();
    cache = rows.reduce((acc, s) => { acc[s.key] = s.value; return acc; }, {});
    loadedAt = Date.now();
    return cache;
}

export async function saveSettings(values) {
    for (const [key, raw] of Object.entries(values)) {
        if (!/^[A-Z0-9_]{2,64}$/.test(key)) continue;
        const value = raw == null ? '' : String(raw);
        await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    cache = null;
    const fresh = await getSettings();
    settingsEvents.emit('change', fresh);
    return fresh;
}

export function num(v, fallback) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}
