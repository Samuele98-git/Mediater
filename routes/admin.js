import express from 'express';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { upload } from '../middleware/upload.js'; // Ensure you import the upload middleware

const router = express.Router();
const prisma = new PrismaClient();

const isAdmin = (req, res, next) => (req.isAuthenticated() && req.user.role === 'admin') ? next() : res.redirect('/');
router.use(isAdmin);

// --- DASHBOARD VIEW ---
router.get('/', async (req, res) => {
    const media = await prisma.media.findMany({ where: { type: { in: ['movie', 'series'] } }, orderBy: { id: 'desc' } });
    const users = await prisma.user.findMany();
    res.render('admin', { media, users });
});

// --- MEDIA ROUTES ---
router.post('/media/add', upload.fields([{ name: 'thumbnail' }, { name: 'video' }]), async (req, res) => {
    try {
        const { title, type, category } = req.body;
        const thumbnail = req.files['thumbnail'] ? '/uploads/images/' + req.files['thumbnail'][0].filename : req.body.thumbnailUrl;
        const path = req.files['video'] ? '/uploads/videos/' + req.files['video'][0].filename : req.body.videoUrl;

        await prisma.media.create({ 
            data: { title, type: type || 'movie', category, thumbnail: thumbnail || '', path: path || '' }
        });
    } catch (e) { console.error(e); }
    res.redirect('/admin');
});

router.post('/media/delete/:id', async (req, res) => {
    try {
        await prisma.media.deleteMany({ where: { parentId: parseInt(req.params.id) } });
        await prisma.media.delete({ where: { id: parseInt(req.params.id) } });
    } catch(e) {}
    res.redirect('/admin');
});

router.post('/episode/add', upload.single('video'), async (req, res) => {
    try {
        const path = req.file ? '/uploads/videos/' + req.file.filename : req.body.videoUrl;
        await prisma.media.create({
            data: {
                title: req.body.title,
                path: path,
                parentId: parseInt(req.body.parentId),
                order: parseInt(req.body.order),
                type: 'episode',
                category: 'Episode'
            }
        });
    } catch (e) { console.error(e); }
    res.redirect('/admin');
});

// --- USER ROUTES ---

// 1. CREATE USER
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
    } catch(e) { console.error("User Create Error:", e); }
    res.redirect('/admin');
});

// 2. EDIT USER (THE FIX)
router.post('/user/edit', upload.single('avatar'), async (req, res) => {
    try {
        const { id, username, password, role } = req.body;
        const updateData = { username, role };

        // Only update password if user typed a new one
        if (password && password.trim() !== "") {
            updateData.password = await bcrypt.hash(password, 10);
        }

        // Only update avatar if file uploaded
        if (req.file) {
            updateData.avatar = '/uploads/images/' + req.file.filename;
        }

        await prisma.user.update({ 
            where: { id: parseInt(id) }, 
            data: updateData 
        });
    } catch(e) { console.error("User Edit Error:", e); }
    res.redirect('/admin');
});

router.post('/user/delete/:id', async (req, res) => {
    try { await prisma.user.delete({ where: { id: parseInt(req.params.id) } }); } catch(e){}
    res.redirect('/admin');
});

// --- SETTINGS ---
router.post('/settings/update', async (req, res) => {
    for (const [key, value] of Object.entries(req.body)) {
        await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    res.redirect('/admin');
});

export default router;