import express from 'express';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { upload } from '../middleware/upload.js';

const router = express.Router();
const prisma = new PrismaClient();
const isAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/login');

router.use(isAuth);

router.get('/', (req, res) => {
    res.render('profile', {
        successMsg: req.query.success || null,
        errorMsg: req.query.error || null
    });
});

router.post('/update', upload.single('avatar'), async (req, res) => {
    try {
        const { username, newPassword } = req.body;
        const updateData = {};

        if (req.user.auth_provider === 'local' && username && username.trim() !== "" && username !== req.user.username) {
            const exists = await prisma.user.findUnique({ where: { username } });
            if (exists) return res.redirect('/profile?error=Username%20already%20taken');
            updateData.username = username;
        }

        if (req.file) {
            updateData.avatar = '/uploads/images/' + req.file.filename;
        }

        if (req.user.auth_provider === 'local' && newPassword && newPassword.trim() !== "") {
            updateData.password = await bcrypt.hash(newPassword, 10);
        }

        if (Object.keys(updateData).length > 0) {
            await prisma.user.update({ where: { id: req.user.id }, data: updateData });
        }
        res.redirect('/profile?success=1');
    } catch (e) {
        console.error('Profile update error:', e);
        res.redirect('/profile?error=Update%20failed');
    }
});

export default router;
