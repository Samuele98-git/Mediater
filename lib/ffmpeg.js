// ffmpeg / ffprobe integration: probing, browser playback decisions,
// on-the-fly remux/transcode, subtitle extraction and image extraction.
// Everything degrades gracefully when ffmpeg is not installed.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { redactUrls } from './internal.js';

let detected = null;

function detect(name, envVar) {
    const candidates = [];
    if (process.env[envVar]) candidates.push(process.env[envVar]);
    candidates.push(name);
    for (const bin of candidates) {
        try {
            const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
            if (r.status === 0 && /version/i.test(r.stdout || '')) {
                return { path: bin, version: ((r.stdout.match(/version\s+(\S+)/) || [])[1] || '').trim() };
            }
        } catch { /* try next */ }
    }
    return null;
}

export function tools() {
    if (!detected) detected = { ffmpeg: detect('ffmpeg', 'FFMPEG_PATH'), ffprobe: detect('ffprobe', 'FFPROBE_PATH') };
    return detected;
}
export const hasFfmpeg = () => !!tools().ffmpeg;
export const hasFfprobe = () => !!tools().ffprobe;

// ---------------------------------------------------------------- languages
const ISO3 = {
    eng: 'en', ita: 'it', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', tur: 'tr', por: 'pt',
    dut: 'nl', nld: 'nl', rus: 'ru', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', ara: 'ar', pol: 'pl',
    swe: 'sv', nor: 'no', nob: 'no', dan: 'da', fin: 'fi', gre: 'el', ell: 'el', heb: 'he', hin: 'hi',
    hun: 'hu', cze: 'cs', ces: 'cs', rum: 'ro', ron: 'ro', ukr: 'uk', tha: 'th', vie: 'vi', ind: 'id',
    may: 'ms', msa: 'ms', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', slo: 'sk', slk: 'sk', cat: 'ca',
    per: 'fa', fas: 'fa', lat: 'la', est: 'et', lav: 'lv', lit: 'lt', ice: 'is', isl: 'is'
};
export function normLang(l) {
    if (!l) return 'und';
    const s = String(l).toLowerCase().trim();
    if (s.length === 2) return s;
    return ISO3[s] || (s === 'und' ? 'und' : s);
}

// ---------------------------------------------------------------- probing
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'subviewer1']);

function summarize(j) {
    const streams = j.streams || [];
    const fmt = j.format || {};
    const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const audio = streams.filter(s => s.codec_type === 'audio').map((s, n) => ({
        index: s.index, n, codec: s.codec_name || '', profile: s.profile || '',
        channels: s.channels || 2, lang: normLang(s.tags && s.tags.language),
        title: (s.tags && s.tags.title) || '', default: !!(s.disposition && s.disposition.default)
    }));
    const subs = streams.filter(s => s.codec_type === 'subtitle').map(s => ({
        index: s.index, codec: s.codec_name || '', lang: normLang(s.tags && s.tags.language),
        title: (s.tags && s.tags.title) || '', default: !!(s.disposition && s.disposition.default),
        forced: !!(s.disposition && s.disposition.forced), text: TEXT_SUBS.has(s.codec_name)
    }));
    let duration = parseFloat(fmt.duration);
    if (!Number.isFinite(duration) && v) duration = parseFloat(v.duration);
    const bits = v ? (parseInt(v.bits_per_raw_sample, 10) || (/10le|10be|p010/.test(v.pix_fmt || '') ? 10 : 8)) : 0;
    return {
        format: fmt.format_name || '',
        start: parseFloat(fmt.start_time) || 0,
        duration: Number.isFinite(duration) ? duration : 0,
        bitrate: parseInt(fmt.bit_rate, 10) || 0,
        video: v ? {
            index: v.index, codec: v.codec_name || '', profile: v.profile || '',
            width: v.width || 0, height: v.height || 0, pixFmt: v.pix_fmt || '', bits,
            hdr: /smpte2084|arib-std-b67/.test(v.color_transfer || '')
        } : null,
        audio, subs
    };
}

export function probe(input, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
        const t = tools();
        if (!t.ffprobe) return reject(new Error('ffprobe is not installed'));
        const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
            '-probesize', '20M', '-analyzeduration', '20M', input];
        const p = spawn(t.ffprobe.path, args, { windowsHide: true });
        let out = '', err = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { err += d; });
        const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffprobe timed out')); }, timeoutMs);
        p.on('error', e => { clearTimeout(timer); reject(e); });
        p.on('close', code => {
            clearTimeout(timer);
            // (the input may be a loopback URL with a secret token: never put it in the message)
            if (code !== 0) return reject(new Error(redactUrls(err.trim().split('\n').pop()) || `ffprobe exited with ${code}`));
            try { resolve(summarize(JSON.parse(out))); } catch (e) { reject(e); }
        });
    });
}

/**
 * Time (seconds from the start of the file) of the last video keyframe at or
 * before `t`: a stream-copy (remux) seek really starts there, not at `t`.
 * Resolves null when it can't tell.
 */
export function keyframeBefore(input, t, { timeoutMs = 10000, signal = null } = {}) {
    return new Promise((resolve) => {
        const tl = tools();
        if (!tl.ffprobe || !(t > 0)) return resolve(null);
        // "+T" seeks relative to the file's start time, exactly like ffmpeg's -ss.
        const args = ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `+${t.toFixed(3)}%+#1`,
            '-show_entries', 'packet=pts_time,dts_time,flags:format=start_time', '-of', 'json', input];
        const p = spawn(tl.ffprobe.path, args, { windowsHide: true });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.resume();
        const kill = () => { try { p.kill('SIGKILL'); } catch { /* gone */ } };
        const timer = setTimeout(kill, timeoutMs);
        if (signal) signal.addEventListener('abort', kill, { once: true });
        p.on('error', () => { clearTimeout(timer); resolve(null); });
        p.on('close', () => {
            clearTimeout(timer);
            try {
                const j = JSON.parse(out || '{}');
                const pk = (j.packets || [])[0];
                if (!pk || !String(pk.flags || '').includes('K')) return resolve(null);
                const pts = parseFloat(pk.pts_time !== undefined && pk.pts_time !== 'N/A' ? pk.pts_time : pk.dts_time);
                const start = parseFloat(j.format && j.format.start_time) || 0;
                resolve(Number.isFinite(pts) ? Math.max(0, pts - start) : null);
            } catch { resolve(null); }
        });
    });
}

export function qualityLabel(info) {
    const h = info && info.video ? info.video.height : 0;
    const w = info && info.video ? info.video.width : 0;
    if (h >= 1600 || w >= 3200) return '4K';
    if (h >= 700 || w >= 1260) return 'HD';
    return h ? 'SD' : null;
}

// ---------------------------------------------------------------- decisions
const AUDIO_CAP = { aac: 'aac', mp3: 'mp3', mp2: 'mp3', opus: 'opus', vorbis: 'vorbis', flac: 'flac', ac3: 'ac3', eac3: 'eac3', alac: 'alac' };

function videoSupported(v, caps) {
    switch (v.codec) {
        case 'h264':
            // 10-bit / 4:2:2 / 4:4:4 H.264 does not decode in browsers
            return v.bits <= 8 && /yuv420p|yuvj420p|nv12/.test(v.pixFmt || 'yuv420p');
        case 'hevc': return caps.has('hevc');
        case 'vp9': return caps.has('vp9');
        case 'vp8': return caps.has('vp8') || caps.has('vp9');
        case 'av1': return caps.has('av1');
        default: return false;
    }
}

/**
 * Picks how a file reaches the browser:
 *  direct    - the browser plays the original bytes (range requests)
 *  remux     - ffmpeg copies the video, converts audio/container to fragmented MP4 (cheap)
 *  transcode - ffmpeg re-encodes video to H.264 (CPU heavy)
 */
export function decidePlayback(info, caps, { audioIndex = null } = {}) {
    const v = info.video;
    const isMp4 = /mp4|mov|m4a|3gp/.test(info.format);
    const isMatroska = /matroska|webm/.test(info.format);
    const webmish = isMatroska && (!v || ['vp8', 'vp9', 'av1'].includes(v.codec)) &&
        info.audio.every(a => ['opus', 'vorbis'].includes(a.codec));
    const containerOk = isMp4 || (webmish && caps.has('webm')) || (isMatroska && caps.has('mkv'));
    const videoOk = !v || videoSupported(v, caps);

    const chosen = audioIndex != null
        ? info.audio.find(a => a.index === Number(audioIndex))
        : (info.audio.find(a => a.default) || info.audio[0]);
    const audioOk = !chosen || caps.has(AUDIO_CAP[chosen.codec] || chosen.codec);
    // Browsers always play the first audio track of a file.
    const firstTrack = !chosen || chosen.n === 0;

    let mode;
    if (containerOk && videoOk && audioOk && firstTrack) mode = 'direct';
    else if (videoOk) mode = 'remux';
    else mode = 'transcode';
    return {
        mode,
        audioIndex: chosen ? chosen.index : null,
        copyAudio: !!chosen && audioOk && ['aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3', 'alac'].includes(chosen.codec)
    };
}

// ---------------------------------------------------------------- streaming
let activeTranscodes = 0;
export const transcodeStats = () => ({ active: activeTranscodes });

function encoderArgs(maxHeight) {
    const enc = process.env.FFMPEG_VIDEO_ENCODER || 'libx264';
    const scale = ['-vf', `scale=-2:'min(${maxHeight},ih)':flags=bicubic,format=yuv420p`];
    if (/nvenc/.test(enc)) return ['-c:v', enc, '-preset', 'p4', '-cq', '23', ...scale];
    if (/qsv/.test(enc)) return ['-c:v', enc, '-global_quality', '23', ...scale];
    if (/amf/.test(enc)) return ['-c:v', enc, '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24', ...scale];
    if (/videotoolbox/.test(enc)) return ['-c:v', enc, '-q:v', '60', ...scale];
    return ['-c:v', 'libx264', '-preset', process.env.FFMPEG_X264_PRESET || 'veryfast', '-crf', '22',
        '-profile:v', 'high', '-level', '4.1', ...scale];
}

/**
 * Spawns ffmpeg producing fragmented MP4 on stdout, starting at `start` seconds.
 * Returns the child process (stdout is the stream).
 */
export function spawnPlaybackStream(input, { start = 0, mode = 'remux', audioIndex = null, copyAudio = false, videoCodec = '', maxHeight = 1080 } = {}) {
    const t = tools();
    if (!t.ffmpeg) throw new Error('ffmpeg is not installed');
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    // Torrent files are read over loopback HTTP; when a download finishes the
    // connection drops once and the file is then served from disk.
    if (/^https?:/i.test(input)) args.push('-seekable', '1', '-multiple_requests', '1', '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '4');
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', input);
    args.push('-map', '0:v:0?');
    args.push('-map', audioIndex != null ? `0:${audioIndex}?` : '0:a:0?');
    if (mode === 'remux') {
        args.push('-c:v', 'copy');
        if (videoCodec === 'hevc') args.push('-tag:v', 'hvc1');
    } else {
        args.push(...encoderArgs(maxHeight));
    }
    if (copyAudio && mode === 'remux') args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
        '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '4096',
        '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000',
        'pipe:1');
    const proc = spawn(t.ffmpeg.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeTranscodes++;
    let errText = '';
    proc.stderr.on('data', d => { if (errText.length < 4000) errText += d; });
    proc.on('close', (code, signal) => {
        activeTranscodes--;
        if (code && code !== 255 && !signal && errText.trim()) console.warn('[ffmpeg]', errText.trim().split('\n').slice(-3).join(' | '));
    });
    return proc;
}

// ---------------------------------------------------------------- helpers
function run(args, { timeoutMs = 120000, collect = false, nice = false } = {}) {
    return new Promise((resolve, reject) => {
        const t = tools();
        if (!t.ffmpeg) return reject(new Error('ffmpeg is not installed'));
        const proc = spawn(t.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true });
        const chunks = []; let err = '';
        if (collect) proc.stdout.on('data', d => chunks.push(d));
        else proc.stdout.resume();
        proc.stderr.on('data', d => { if (err.length < 4000) err += d; });
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
        // Background work (thumbnails, subtitles) must not starve playback.
        if (nice) { try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ } }
        proc.on('error', e => { clearTimeout(timer); reject(e); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(redactUrls(err.trim()) || `ffmpeg exited with ${code}`));
            resolve(collect ? Buffer.concat(chunks) : undefined);
        });
    });
}

/** Extracts one embedded text subtitle track as WebVTT. */
export async function extractSubtitleVtt(input, streamIndex) {
    const buf = await run(['-i', input, '-map', `0:${Number(streamIndex)}`, '-f', 'webvtt', 'pipe:1'], { collect: true, timeoutMs: 300000, nice: true });
    return buf.toString('utf8');
}

/** Converts a subtitle file ffmpeg understands (e.g. .ass) to WebVTT. */
export async function convertSubtitleToVtt(input) {
    const buf = await run(['-i', input, '-f', 'webvtt', 'pipe:1'], { collect: true, timeoutMs: 60000 });
    return buf.toString('utf8');
}

/** Grabs a still frame (JPEG) at `at` seconds. */
export async function extractFrame(input, outFile, { at = 60, width = 1280 } = {}) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await run(['-ss', String(Math.max(0, at)), '-i', input, '-frames:v', '1', '-an', '-sn',
        '-vf', `scale=${width}:-2`, '-q:v', '3', '-y', outFile], { timeoutMs: 90000, nice: true });
    return outFile;
}

/**
 * Builds "trickplay" sprite sheets for scrubbing previews:
 * one 240px-wide frame every `interval` seconds, tiled 10x10 per JPEG.
 */
export async function generateTrickplay(input, outDir, { duration, interval = 10 } = {}) {
    fs.mkdirSync(outDir, { recursive: true });
    const cols = 10, rows = 10, width = 240;
    await run(['-skip_frame', 'nokey', '-i', input, '-an', '-sn', '-dn',
        '-vf', `fps=1/${interval},scale=${width}:-2,tile=${cols}x${rows}`,
        '-q:v', '5', '-y', path.join(outDir, 'sprite_%03d.jpg')], { timeoutMs: 45 * 60 * 1000, nice: true });
    const sprites = fs.readdirSync(outDir).filter(f => /^sprite_\d+\.jpg$/.test(f)).sort();
    const manifest = { interval, cols, rows, width, count: Math.ceil((duration || 0) / interval), sprites, version: 1 };
    // Read the real tile height from the first JPEG (SOF0 marker).
    try {
        const b = fs.readFileSync(path.join(outDir, sprites[0]));
        for (let i = 2; i < b.length - 9; i++) {
            if (b[i] === 0xFF && (b[i + 1] === 0xC0 || b[i + 1] === 0xC2)) {
                const h = b.readUInt16BE(i + 5);
                manifest.height = Math.round(h / rows);
                break;
            }
        }
    } catch { /* ignore */ }
    if (!manifest.height) manifest.height = Math.round(width * 9 / 16);
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
    return manifest;
}
