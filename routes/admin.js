import express from 'express';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { upload } from '../middleware/upload.js';

const router = express.Router();
const prisma = new PrismaClient();

const isAdmin = (req, res, next) => (req.isAuthenticated() && req.user.role === 'admin') ? next() : res.redirect('/');
router.use(isAdmin);

router.get('/', async (req, res) => {
    const media = await prisma.media.findMany({ where: { type: { in: ['movie', 'series'] } }, orderBy: { id: 'desc' } });
    const users = await prisma.user.findMany();
    res.render('admin', { media, users });
});

router.post('/media/add', upload.fields([
    { name: 'thumbnail' }, { name: 'video' }, { name: 'backdrop' }, { name: 'logo' }
]), async (req, res) => {
    try {
        const { title, type, category, description, releaseYear, duration, maturity, genres } = req.body;
        const thumbnail = req.files['thumbnail'] ? '/uploads/images/' + req.files['thumbnail'][0].filename : req.body.thumbnailUrl;
        const backdrop  = req.files['backdrop']  ? '/uploads/images/' + req.files['backdrop'][0].filename  : req.body.backdropUrl;
        const logo      = req.files['logo']      ? '/uploads/images/' + req.files['logo'][0].filename      : req.body.logoUrlInput;
        const filePath  = req.files['video']     ? '/uploads/videos/' + req.files['video'][0].filename     : req.body.videoUrl;

        await prisma.media.create({
            data: {
                title,
                type: type || 'movie',
                category,
                description: description || '',
                genres: genres || '',
                releaseYear: releaseYear ? parseInt(releaseYear) : null,
                duration: duration ? parseInt(duration) : null,
                maturity: maturity || null,
                thumbnail: thumbnail || '',
                backdrop: backdrop || '',
                logoUrl: logo || '',
                path: filePath || '',
                trending: req.body.trending === 'on'
            }
        });
    } catch (e) { console.error(e); }
    res.redirect('/admin');
});

router.post('/media/edit/:id', upload.fields([
    { name: 'thumbnail' }, { name: 'video' }, { name: 'backdrop' }, { name: 'logo' }
]), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { title, type, category, description, releaseYear, duration, maturity, genres } = req.body;
        const data = {
            title, type: type || 'movie', category,
            description: description || '',
            genres: genres || '',
            releaseYear: releaseYear ? parseInt(releaseYear) : null,
            duration: duration ? parseInt(duration) : null,
            maturity: maturity || null,
            trending: req.body.trending === 'on'
        };
        if (req.files['thumbnail']) data.thumbnail = '/uploads/images/' + req.files['thumbnail'][0].filename;
        if (req.files['backdrop'])  data.backdrop  = '/uploads/images/' + req.files['backdrop'][0].filename;
        if (req.files['logo'])      data.logoUrl   = '/uploads/images/' + req.files['logo'][0].filename;
        if (req.files['video'])     data.path      = '/uploads/videos/' + req.files['video'][0].filename;
        await prisma.media.update({ where: { id }, data });
    } catch (e) { console.error(e); }
    res.redirect('/admin');
});

router.post('/media/delete/:id', async (req, res) => {
    try {
        await prisma.media.deleteMany({ where: { parentId: parseInt(req.params.id) } });
        await prisma.media.delete({ where: { id: parseInt(req.params.id) } });
    } catch (e) {}
    res.redirect('/admin');
});

router.post('/episode/add', upload.fields([{ name: 'video' }, { name: 'thumbnail' }]), async (req, res) => {
    try {
        const filePath = req.files['video'] ? '/uploads/videos/' + req.files['video'][0].filename : req.body.videoUrl;
        const thumb = req.files['thumbnail'] ? '/uploads/images/' + req.files['thumbnail'][0].filename : null;
        await prisma.media.create({
            data: {
                title: req.body.title,
                description: req.body.description || '',
                duration: req.body.duration ? parseInt(req.body.duration) : null,
                thumbnail: thumb || '',
                path: filePath,
                parentId: parseInt(req.body.parentId),
                order: parseInt(req.body.order),
                type: 'episode',
                category: 'Episode'
            }
        });
    } catch (e) { console.error(e); }
    res.redirect('/admin');
});

// --- USERS ---
router.post('/user/add', upload.single('avatar'), async (req, res) => {
    try {
        const hash = await bcrypt.hash(req.body.password, 10);
        const avatar = req.file ? '/uploads/images/' + req.file.filename : '';
        await prisma.user.create({
            data: {
                username: req.body.username,
                password: hash,
                role: req.body.role,
                avatar: avatar
            }
        });
    } catch (e) { console.error("User Create Error:", e); }
    res.redirect('/admin');
});

router.post('/user/edit', upload.single('avatar'), async (req, res) => {
    try {
        const { id, username, password, role } = req.body;
        const updateData = { username, role };
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }
        if (req.file) {
            updateData.avatar = '/uploads/images/' + req.file.filename;
        }
        await prisma.user.update({
            where: { id: parseInt(id) },
            data: updateData
        });
    } catch (e) { console.error("User Edit Error:", e); }
    res.redirect('/admin');
});

router.post('/user/delete/:id', async (req, res) => {
    try { await prisma.user.delete({ where: { id: parseInt(req.params.id) } }); } catch (e) {}
    res.redirect('/admin');
});

router.post('/settings/update', async (req, res) => {
    try {
        for (const [key, value] of Object.entries(req.body || {})) {
            await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
        }
    } catch (e) {
        console.error('[settings/update] error:', e);
    }
    res.redirect('/admin');
});

export default router;
