import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import {
    NODE_ENV, IS_PROD, PORT, HOST, ROOT, PUBLIC_DIR, UPLOAD_DIR, ensureDirs
} from './lib/config.js';
import prisma, { tuneDatabase } from './lib/prisma.js';
import PrismaSessionStore from './lib/session-store.js';
import { getSettings } from './lib/settings.js';
import { loadLocale, makeT, pickLang, LANG_LABELS, DATE_LOCALES } from './lib/i18n.js';
import engine from './lib/torrents.js';
import { setLoopbackPort } from './lib/internal.js';
import { tools } from './lib/ffmpeg.js';
import { loadProfile } from './middleware/auth.js';
import { cardHtml, esc, jsonScript } from './lib/view-helpers.js';

import authRoutes from './routes/auth.js';
import profilesRoutes from './routes/profiles.js';
import browseRoutes from './routes/browse.js';
import apiRoutes from './routes/api.js';
import streamRoutes, { internalRouter } from './routes/stream.js';
import downloadsRoutes from './routes/downloads.js';
import adminRoutes from './routes/admin.js';
import accountRoutes from './routes/profile.js';

const app = express();
const TRUST_PROXY = process.env.TRUST_PROXY || (IS_PROD ? '1' : '');
const COOKIE_SECURE = (process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
const SESSION_TTL = parseInt(process.env.SESSION_TTL_DAYS || '30', 10) * 24 * 60 * 60;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ASSET_VERSION = Date.now().toString(36);

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    if (IS_PROD) {
        console.error('\n[FATAL] SESSION_SECRET is not set. Refusing to start in production without it.');
        console.error('        Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n');
        process.exit(1);
    }
    SESSION_SECRET = crypto.randomBytes(48).toString('hex');
    console.warn('[WARN] SESSION_SECRET not set — generated an ephemeral one for development. Sessions reset on restart.');
}
if (IS_PROD && ADMIN_PASSWORD === 'admin123') {
    console.warn('[WARN] ADMIN_PASSWORD is the default "admin123". Set ADMIN_PASSWORD for production deployments.');
}

ensureDirs();

if (TRUST_PROXY) app.set('trust proxy', isNaN(parseInt(TRUST_PROXY, 10)) ? TRUST_PROXY : parseInt(TRUST_PROXY, 10));
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
Object.assign(app.locals, { cardHtml, esc, jsonScript });

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});

// --- static files ---
// Only pictures are public in the uploads folder (posters, avatars…). Uploaded
// videos and subtitles are only reachable through authenticated routes.
const PUBLIC_UPLOAD = /\.(jpe?g|png|webp|gif|avif)$/i;
app.use('/uploads', (req, res, next) => {
    let p;
    try { p = decodeURIComponent(req.path).replace(/\\/g, '/').toLowerCase(); } catch { return res.status(400).end(); }
    if (!PUBLIC_UPLOAD.test(req.path) || p.includes('\0') || /(^|\/)(videos|subtitles|torrents)(\/|$)/.test(p)) return res.status(404).end();
    next();
}, express.static(UPLOAD_DIR, { index: false, dotfiles: 'ignore', maxAge: IS_PROD ? '7d' : 0 }));
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: IS_PROD ? '7d' : 0 }));
app.use('/vendor/fontawesome', express.static(path.join(ROOT, 'node_modules', '@fortawesome', 'fontawesome-free'), { index: false, maxAge: '30d' }));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb', type: ['application/json', 'text/plain'] }));

// --- sessions ---
app.use(session({
    store: new PrismaSessionStore({ ttlSeconds: SESSION_TTL }),
    name: 'mediater.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, maxAge: SESSION_TTL * 1000, secure: COOKIE_SECURE, sameSite: 'lax' }
}));
app.use(passport.initialize());
app.use(passport.session());

// --- per-request locals (branding, language) ---
app.use(async (req, res, next) => {
    try {
        const config = await getSettings();
        const lang = pickLang(config.LANGUAGE);
        const dict = loadLocale(lang);
        res.locals.APP_NAME = config.APP_NAME || 'MEDIATER';
        res.locals.ACCENT_COLOR = /^#[0-9a-f]{3,8}$/i.test(config.ACCENT_COLOR || '') ? config.ACCENT_COLOR : '#E50914';
        res.locals.user = req.user || null;
        res.locals.config = config;
        res.locals.t = makeT(dict);
        res.locals.lang = lang;
        res.locals.dateLocale = DATE_LOCALES[lang] || 'en-US';
        res.locals.langLabels = LANG_LABELS;
        res.locals.dict = dict;
        res.locals.assetVersion = ASSET_VERSION;
        res.locals.currentPath = req.path;
        res.locals.canAdmin = false; // set for real once the profile is known
        next();
    } catch (e) { next(e); }
});

// Favicon: the first letter of the app name in the accent colour.
app.get('/favicon.svg', (req, res) => {
    const letter = String(res.locals.APP_NAME || 'M').trim().charAt(0).toUpperCase().replace(/[<>&"']/g, '') || 'M';
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#000"/>` +
        `<text x="32" y="48" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="46" fill="${res.locals.ACCENT_COLOR}">${letter}</text></svg>`);
});
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
// Lets phones "install" the site as an app.
app.get('/manifest.webmanifest', (req, res) => {
    res.set('Content-Type', 'application/manifest+json').send(JSON.stringify({
        name: res.locals.APP_NAME, short_name: res.locals.APP_NAME, start_url: '/', scope: '/',
        display: 'standalone', background_color: '#141414', theme_color: '#141414',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
    }));
});
app.get('/healthz', (req, res) => res.json({ ok: true, env: NODE_ENV }));

// Streaming routes skip the profile lookup (they're hit many times per second).
app.use('/', streamRoutes);

app.use(loadProfile);
app.use('/', authRoutes);
app.use('/profiles', profilesRoutes);
app.use('/', downloadsRoutes);
app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);
app.use('/account', accountRoutes);
app.get('/profile', (req, res) => res.redirect(301, '/account'));
app.use('/', browseRoutes);

// --- errors ---
app.use((req, res) => {
    if (req.originalUrl.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(404).render('error', { code: 404 });
});
app.use((err, req, res, next) => {
    const status = Number(err && (err.status || err.statusCode)) || 500;
    if (res.headersSent) return next(err);
    // Client errors (malformed URL, bad upload…) are not server failures.
    if (status >= 400 && status < 500) {
        if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: err.message || 'Bad request' });
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).send('File too large');
        try { return res.status(status).render('error', { code: status === 404 ? 404 : 400, message: status === 400 && err.expose !== false ? err.message : null }); } catch { return res.status(status).end(); }
    }
    console.error('[ERROR]', err.stack || err.message || err);
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).send('File too large');
    if (req.originalUrl.startsWith('/api/')) return res.status(500).json({ error: err.message || 'Server error' });
    try { res.status(500).render('error', { code: 500 }); } catch { res.status(500).send('Internal Server Error'); }
});

// --- startup ---
// ffmpeg reads torrents that are still downloading through this private
// server: 127.0.0.1 only, random port, separate from the public app.
function startInternalServer() {
    const internal = express();
    internal.disable('x-powered-by');
    internal.use(internalRouter);
    internal.use((req, res) => res.status(404).end());
    return new Promise((resolve, reject) => {
        const srv = http.createServer(internal);
        srv.requestTimeout = 0;
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { setLoopbackPort(srv.address().port); resolve(srv); });
    });
}

// A stray rejected promise must never take the whole server down.
process.on('unhandledRejection', (err) => console.error('[unhandled]', (err && err.stack) || err));

async function initAdmin() {
    const existing = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } });
    if (!existing) {
        await prisma.user.create({ data: { username: ADMIN_USERNAME, password: await bcrypt.hash(ADMIN_PASSWORD, 10), role: 'admin' } });
        console.log(`[INIT] Created admin user "${ADMIN_USERNAME}"`);
    }
}

(async () => {
    try {
        await tuneDatabase();
        await initAdmin();
        const t = tools();
        console.log(t.ffmpeg
            ? `[media] ffmpeg ${t.ffmpeg.version} found — MKV/AVI/HEVC/AC3 files will be converted for the browser on the fly`
            : '[media] ffmpeg not found — only browser-native formats (MP4/WebM) will play. Install ffmpeg for full support.');
        const internalServer = await startInternalServer();
        await engine.init();
        const server = app.listen(PORT, HOST, () => {
            const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
            console.log(`\n🍿 MEDIATER (${NODE_ENV}) listening on http://${displayHost}:${PORT}`);
        });
        server.requestTimeout = 0; // long-running video streams
        server.headersTimeout = 65_000;

        let closing = false;
        const shutdown = async (signal) => {
            if (closing) return;
            closing = true;
            console.log(`\n[${signal}] Shutting down…`);
            setTimeout(() => process.exit(1), 10000).unref();
            await engine.shutdown().catch(() => {});
            internalServer.close();
            internalServer.closeAllConnections?.();
            server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
            server.closeAllConnections?.();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    } catch (e) {
        console.error('[FATAL] Startup failed:', e);
        process.exit(1);
    }
})();
