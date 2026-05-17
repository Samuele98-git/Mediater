import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import path from 'path';
import { fileURLToPath } from 'url';
import passport from 'passport';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import { loadLocale, makeT, pickLang, LANG_LABELS, DATE_LOCALES } from './lib/i18n.js';

// Routes
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import profileRoutes from './routes/profile.js';
import viewRoutes from './routes/views.js';

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// --- ENV CONFIG ---
const NODE_ENV       = process.env.NODE_ENV || 'development';
const IS_PROD        = NODE_ENV === 'production';
const PORT           = parseInt(process.env.PORT || '3000', 10);
const HOST           = process.env.HOST || (IS_PROD ? '0.0.0.0' : '127.0.0.1');
const TRUST_PROXY    = process.env.TRUST_PROXY || (IS_PROD ? '1' : '');
const COOKIE_SECURE  = (process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
const SESSION_TTL    = parseInt(process.env.SESSION_TTL_DAYS || '30', 10) * 24 * 60 * 60;
const UPLOAD_DIR     = process.env.UPLOAD_DIR || path.join(__dirname, 'public/uploads');
const SESSION_DIR    = process.env.SESSION_DIR || path.join(__dirname, 'sessions');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    if (IS_PROD) {
        console.error('\n[FATAL] SESSION_SECRET is not set. Refusing to start in production without it.');
        console.error('        Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
        console.error('        Then set it in your .env file or environment.\n');
        process.exit(1);
    }
    SESSION_SECRET = crypto.randomBytes(48).toString('hex');
    console.warn('[WARN] SESSION_SECRET not set — generated an ephemeral one for development. Sessions will reset on each restart.');
}

if (IS_PROD && ADMIN_PASSWORD === 'admin123') {
    console.warn('[WARN] ADMIN_PASSWORD is using the default "admin123". Set ADMIN_PASSWORD in your env for production deployments.');
}

// --- ENSURE DIRS EXIST ---
[
    path.join(UPLOAD_DIR, 'images'),
    path.join(UPLOAD_DIR, 'videos'),
    SESSION_DIR
].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- TRUST PROXY (so secure cookies + req.ip work behind nginx/traefik) ---
if (TRUST_PROXY) {
    const v = isNaN(parseInt(TRUST_PROXY, 10)) ? TRUST_PROXY : parseInt(TRUST_PROXY, 10);
    app.set('trust proxy', v);
}

// --- CORE MIDDLEWARE ---
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: IS_PROD ? '7d' : 0 }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const FileStore = FileStoreFactory(session);

app.use(session({
    store: new FileStore({
        path: SESSION_DIR,
        retries: 1,
        ttl: SESSION_TTL,
        reapInterval: 24 * 60 * 60
    }),
    name: 'mediater.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        maxAge: SESSION_TTL * 1000,
        secure: COOKIE_SECURE,
        sameSite: 'lax'
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// --- BASIC SECURITY HEADERS ---
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-XSS-Protection', '0');
    next();
});

// --- GLOBAL VARS FROM SETTINGS ---
app.use(async (req, res, next) => {
    try {
        const settings = await prisma.setting.findMany();
        const config = settings.reduce((acc, s) => ({ ...acc, [s.key]: s.value }), {});
        const lang = pickLang(config.LANGUAGE);
        const dict = loadLocale(lang);
        res.locals.APP_NAME = config.APP_NAME || 'MEDIATER';
        res.locals.ACCENT_COLOR = config.ACCENT_COLOR || '#E50914';
        res.locals.user = req.user || null;
        res.locals.config = config;
        res.locals.t = makeT(dict);
        res.locals.lang = lang;
        res.locals.dateLocale = DATE_LOCALES[lang] || 'en-US';
        res.locals.langLabels = LANG_LABELS;
        res.locals.dict = dict;
        next();
    } catch (e) { next(e); }
});

// --- ROUTES ---
app.use('/', authRoutes);
app.use('/', viewRoutes);
app.use('/admin', adminRoutes);
app.use('/profile', profileRoutes);

// --- HEALTHCHECK ---
app.get('/healthz', (req, res) => res.json({ ok: true, env: NODE_ENV }));

// --- ERROR HANDLER ---
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.stack || err.message || err);
    if (res.headersSent) return next(err);
    res.status(500).send('Internal Server Error');
});

// --- INIT + LISTEN ---
async function initAdmin() {
    const existing = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } });
    if (!existing) {
        const hashed = await bcrypt.hash(ADMIN_PASSWORD, 10);
        await prisma.user.create({
            data: { username: ADMIN_USERNAME, password: hashed, role: 'admin' }
        });
        console.log(`[INIT] Created admin user "${ADMIN_USERNAME}"`);
    }
}

(async () => {
    try {
        await initAdmin();
        const server = app.listen(PORT, HOST, () => {
            const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
            console.log(`\n🚀 MEDIATER (${NODE_ENV}) listening on http://${displayHost}:${PORT}`);
        });

        const shutdown = (signal) => {
            console.log(`\n[${signal}] Shutting down…`);
            server.close(() => {
                prisma.$disconnect().finally(() => process.exit(0));
            });
            setTimeout(() => process.exit(1), 10000).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT',  () => shutdown('SIGINT'));
    } catch (e) {
        console.error('[FATAL] Startup failed:', e);
        process.exit(1);
    }
})();
