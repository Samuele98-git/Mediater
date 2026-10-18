// Central place for environment-driven configuration and filesystem layout.
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.join(__dirname, '..');
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PROD = NODE_ENV === 'production';
export const PORT = parseInt(process.env.PORT || '3000', 10);
export const HOST = process.env.HOST || (IS_PROD ? '0.0.0.0' : '127.0.0.1');

export const PUBLIC_DIR = path.join(ROOT, 'public');
// Everything the app writes at runtime (downloads, caches, saved .torrent files).
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
// Uploaded artwork / videos / subtitles. Default kept for backwards compatibility.
export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(PUBLIC_DIR, 'uploads'));
export const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(DATA_DIR, 'downloads'));
export const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(DATA_DIR, 'cache'));
export const TORRENT_FILE_DIR = path.join(DATA_DIR, 'torrents');

// BitTorrent listening port (0 = random). Open/forward it for better speeds.
export const TORRENT_PORT = parseInt(process.env.TORRENT_PORT || '0', 10) || 0;
// Set TORRENTS_ENABLED=false to turn the torrent client off completely.
export const TORRENTS_ENABLED = (process.env.TORRENTS_ENABLED || 'true').toLowerCase() !== 'false';

export function ensureDirs() {
    for (const dir of [
        path.join(UPLOAD_DIR, 'images'),
        path.join(UPLOAD_DIR, 'videos'),
        path.join(UPLOAD_DIR, 'subtitles'),
        path.join(UPLOAD_DIR, 'torrents'),
        DATA_DIR, DOWNLOAD_DIR, CACHE_DIR, TORRENT_FILE_DIR
    ]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
