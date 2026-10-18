// Resolves the `path` stored on Media / Subtitle rows to something playable.
//
//   https://...                external URL
//   /uploads/videos/x.mp4      uploaded file (inside UPLOAD_DIR)
//   dl:Folder/file.mkv         downloaded by the torrent client (inside DOWNLOAD_DIR)
//   C:\Movies\x.mkv | /mnt/x   absolute path on the server (entered by an admin)
import fs from 'fs';
import path from 'path';
import { UPLOAD_DIR, DOWNLOAD_DIR, PUBLIC_DIR } from './config.js';

function inside(base, rel) {
    const full = path.resolve(base, rel);
    const root = path.resolve(base);
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    return full;
}

export function resolveMediaPath(p) {
    if (!p) return null;
    const s = String(p).trim();
    if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s };
    if (s.startsWith('dl:')) {
        const file = inside(DOWNLOAD_DIR, s.slice(3));
        return file ? { kind: 'file', file } : null;
    }
    if (s.startsWith('/uploads/')) {
        const rel = s.slice('/uploads/'.length);
        const primary = inside(UPLOAD_DIR, rel);
        if (primary && fs.existsSync(primary)) return { kind: 'file', file: primary };
        // Files uploaded before UPLOAD_DIR was configurable live in public/uploads.
        const legacy = inside(path.join(PUBLIC_DIR, 'uploads'), rel);
        if (legacy && fs.existsSync(legacy)) return { kind: 'file', file: legacy };
        return primary ? { kind: 'file', file: primary } : null;
    }
    if (path.isAbsolute(s)) return { kind: 'file', file: path.resolve(s) };
    const rel = inside(PUBLIC_DIR, s);
    return rel ? { kind: 'file', file: rel } : null;
}

export function fileExists(p) {
    const loc = resolveMediaPath(p);
    if (!loc || loc.kind !== 'file') return false;
    try { return fs.statSync(loc.file).isFile(); } catch { return false; }
}

const VIDEO_MIME = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    // Chromium plays Matroska through its WebM demuxer.
    '.webm': 'video/webm', '.mkv': 'video/webm',
    '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t',
    '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ogv': 'video/ogg', '.flv': 'video/x-flv'
};
export const videoMime = (name) => VIDEO_MIME[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
