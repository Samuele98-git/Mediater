// Loopback access for ffmpeg/ffprobe: they read torrent files (seekable HTTP)
// from a small server that only listens on 127.0.0.1 on a random port. It is
// separate from the public app, so a reverse proxy can never expose it, and
// every request needs a per-process random token.
import crypto from 'crypto';

export const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');

let base = null;
export function setLoopbackPort(port) { base = `http://127.0.0.1:${port}`; }

export function torrentLoopbackUrl(tid, fileIndex) {
    if (!base) throw new Error('Internal loopback server is not running');
    return `${base}/internal/t/${tid}/${fileIndex}?k=${INTERNAL_TOKEN}`;
}

/** Removes loopback URLs (and their token) from text that may reach a browser or a log. */
export const redactUrls = (s) => String(s || '').replace(/https?:\/\/\S+/gi, '<input>');
