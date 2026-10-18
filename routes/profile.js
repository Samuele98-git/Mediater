// Account settings (username, password, avatar of the signed-in account).
import express from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma.js';
import { avatarUpload, uploadPath, discardUpload } from '../middleware/upload.js';
import { isAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(isAuth);
// Kids profiles can't open account settings (like Netflix).
router.use((req, res, next) => (req.profile && req.profile.isKids ? res.redirect('/') : next()));

router.get('/', (req, res, next) => {
    prisma.user.count({ where: { parentId: req.user.id } }).then(profiles => res.render('account', {
        successMsg: req.query.success ? 1 : 0,
        errorKey: ['taken', 'failed', 'wrong_password'].includes(req.query.error) ? req.query.error : null,
        profileCount: profiles + 1
    })).catch(next);
});

router.post('/update', avatarUpload.single('avatar'), async (req, res) => {
    try {
        const { username, newPassword, currentPassword } = req.body;
        const data = {};
        const local = req.user.auth_provider === 'local';
        const wantsName = local && username && username.trim() && username.trim() !== req.user.username;
        const wantsPass = local && newPassword && newPassword.trim();
        if ((wantsName || wantsPass) && req.user.password) {
            const ok = await bcrypt.compare(String(currentPassword || ''), req.user.password);
            if (!ok) { discardUpload(req); return res.redirect('/account?error=wrong_password'); }
        }
        if (wantsName) {
            if (await prisma.user.findUnique({ where: { username: username.trim() } })) { discardUpload(req); return res.redirect('/account?error=taken'); }
            data.username = username.trim();
        }
        if (wantsPass) data.password = await bcrypt.hash(newPassword, 10);
        if (req.file) data.avatar = uploadPath(req.file);
        if (Object.keys(data).length) await prisma.user.update({ where: { id: req.user.id }, data });
        res.redirect('/account?success=1');
    } catch (e) {
        discardUpload(req);
        console.error('[account] update failed:', e);
        res.redirect('/account?error=failed');
    }
});

export default router;
