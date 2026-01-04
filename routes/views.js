import express from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

const isAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/login');

router.get('/', isAuth, async (req, res) => {
    // Only get Movies and Series containers (hide episodes)
    const media = await prisma.media.findMany({ where: { type: { in: ['movie', 'series'] } } });
    
    const rows = {};
    media.forEach(m => {
        if (!rows[m.category]) rows[m.category] = [];
        rows[m.category].push(m);
    });

    const hero = media.length > 0 ? media[Math.floor(Math.random() * media.length)] : null;
    res.render('index', { rows, hero });
});

router.get('/watch/:id', isAuth, async (req, res) => {
    const media = await prisma.media.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!media) return res.redirect('/');
    
    if (media.type === 'series') {
        const episodes = await prisma.media.findMany({ where: { parentId: media.id }, orderBy: { order: 'asc' } });
        return res.render('series', { series: media, episodes });
    }
    
    res.render('watch', { media });
});

export default router;