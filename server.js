import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import SQLiteStore from 'connect-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import passport from 'passport';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';

// Routes
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import profileRoutes from './routes/profile.js';
import viewRoutes from './routes/views.js';

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const Store = SQLiteStore(session);

// --- 1. ENSURE UPLOAD DIRS EXIST ---
const uploadDirs = [
    path.join(__dirname, 'public/uploads/images'),
    path.join(__dirname, 'public/uploads/videos')
];
uploadDirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- 2. CONFIG ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false })); // Serves uploads automatically
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  store: new Store({ db: 'sessions.db', dir: '.' }),
  secret: 'mediater_upload_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, secure: false, sameSite: 'lax' }
}));

app.use(passport.initialize());
app.use(passport.session());

// Global Vars
app.use(async (req, res, next) => {
    try {
        const settings = await prisma.setting.findMany();
        const config = settings.reduce((acc, s) => ({ ...acc, [s.key]: s.value }), {});
        res.locals.APP_NAME = config.APP_NAME || 'MEDIATER';
        res.locals.ACCENT_COLOR = config.ACCENT_COLOR || '#E50914';
        res.locals.user = req.user || null;
        res.locals.config = config;
        next();
    } catch (e) { next(e); }
});

// Routes
app.use('/', authRoutes);
app.use('/', viewRoutes);
app.use('/admin', adminRoutes);
app.use('/profile', profileRoutes);

// Init
(async () => {
    const admin = await prisma.user.findUnique({ where: { username: 'admin' }});
    if (!admin) await prisma.user.create({ data: { username: 'admin', password: 'admin123', role: 'admin' }});
    app.listen(PORT, () => console.log(`\n🚀 MEDIATER 2.0: http://localhost:${PORT}`));
})();