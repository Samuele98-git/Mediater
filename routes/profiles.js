// "Who's watching?" profiles. The signed-in account is the first profile;
// extra ones are User rows with parentId = account id.
// Profile Lock: a profile can require a 4-digit PIN (stored as a bcrypt hash).
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma.js';
import { isAuth, profileChosen, ownerProfileActive, PROFILE_COOKIE } from '../middleware/auth.js';
import { avatarUpload, uploadPath, discardUpload } from '../middleware/upload.js';
import { PUBLIC_DIR, COOKIE_SECURE } from '../lib/config.js';

const router = express.Router();
router.use(isAuth);

const MAX_PROFILES = 5;
const PIN_RE = /^\d{4}$/;
const MAX_PIN_FAILS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;
const PIN_LOCK_MAX_MS = 60 * 60 * 1000;
const BUILTIN_AVATARS = (() => {
    try {
        return fs.readdirSync(path.join(PUBLIC_DIR, 'img', 'avatars')).filter(f => f.endsWith('.svg')).sort()
            .map(f => '/img/avatars/' + f);
    } catch { return []; }
})();

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/profiles')) ? n : '/';
const owns = (req, id) => req.profiles.find(p => p.id === id);
const wantsJson = (req) => (req.get('accept') || '').includes('application/json') || req.is('application/json');

// ------------------------------------------------------------ PIN helpers
// Wrong PINs are counted per profile and per device — not per browser session,
// which anyone could simply restart: every 5 misses lock that profile on that
// device, for 5 minutes, then 10, 20, 40, up to an hour.
const pinFails = new Map(); // `${profileId}|${ip}` -> { count, until }
const failKey = (req, id) => `${id}|${req.ip || (req.socket && req.socket.remoteAddress) || ''}`;
const forgetFails = (id) => { for (const k of pinFails.keys()) if (k.startsWith(id + '|')) pinFails.delete(k); };

function lockedMinutes(req, id) {
    const f = pinFails.get(failKey(req, id));
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
}

/** Checks a PIN with the attempt limit. Returns 'ok' | 'wrong' | 'locked'. */
async function verifyPin(req, profile, pin) {
    if (!profile.pin) return 'ok';
    if (lockedMinutes(req, profile.id)) return 'locked';
    const key = failKey(req, profile.id);
    const ok = PIN_RE.test(String(pin || '')) && await bcrypt.compare(String(pin), profile.pin);
    if (ok) { pinFails.delete(key); return 'ok'; }
    const f = pinFails.get(key) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count % MAX_PIN_FAILS === 0) f.until = Date.now() + Math.min(PIN_LOCK_MAX_MS, PIN_LOCK_MS * 2 ** (f.count / MAX_PIN_FAILS - 1));
    pinFails.set(key, f);
    if (pinFails.size > 5000) pinFails.delete(pinFails.keys().next().value);
    return lockedMinutes(req, profile.id) ? 'locked' : 'wrong';
}

// The profile in use right now was already unlocked when it was chosen, and the
// account owner (in their own, unlocked profile) manages everyone else's.
const isUnlocked = (req, p) => !p.pin || (profileChosen(req) && req.session.profileId === p.id) || req.session.editUnlocked === p.id
    || (p.parentId === req.user.id && ownerProfileActive(req));

/** Remembers the chosen profile for this browser session only (see needsProfileGate). */
function rememberProfile(req, res, p) {
    const token = crypto.randomBytes(18).toString('hex');
    req.session.profileId = p.id;
    req.session.profileChosen = true;
    req.session.profileToken = token;
    res.cookie(PROFILE_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' });
}

function pinFailure(req, res, p, result, fallbackUrl) {
    if (wantsJson(req)) return res.status(403).json({ error: result, minutes: lockedMinutes(req, p.id) });
    return res.redirect(fallbackUrl);
}

// ------------------------------------------------------------ routes
router.get('/', (req, res) => {
    const lock = parseInt(req.query.lock, 10);
    res.render('profiles', {
        manage: req.query.manage === '1',
        next: safeNext(req.query.next),
        maxProfiles: MAX_PROFILES,
        openLock: req.profiles.some(p => p.id === lock && p.pin) ? lock : null,
        ownerActive: ownerProfileActive(req)
    });
});

router.post('/select/:id', async (req, res, next) => {
    try {
        const p = owns(req, parseInt(req.params.id, 10));
        const nextUrl = safeNext(req.body.next);
        if (!p) return wantsJson(req) ? res.status(404).json({ error: 'not found' }) : res.redirect('/profiles');
        if (p.pin) {
            const result = await verifyPin(req, p, req.body.pin);
            if (result !== 'ok') return pinFailure(req, res, p, result, `/profiles?lock=${p.id}&next=${encodeURIComponent(nextUrl)}`);
        }
        rememberProfile(req, res, p);
        delete req.session.editUnlocked;
        req.session.save(() => (wantsJson(req) ? res.json({ ok: true, next: nextUrl }) : res.redirect(nextUrl)));
    } catch (e) { next(e); }
});

// Unlock a locked profile for editing (Manage Profiles).
router.post('/:id/unlock', async (req, res, next) => {
    try {
        const p = owns(req, parseInt(req.params.id, 10));
        if (!p) return res.status(404).json({ error: 'not found' });
        const result = await verifyPin(req, p, req.body.pin);
        if (result !== 'ok') return pinFailure(req, res, p, result, `/profiles?manage=1&lock=${p.id}`);
        req.session.editUnlocked = p.id;
        req.session.save(() => (wantsJson(req) ? res.json({ ok: true, next: `/profiles/${p.id}/edit` }) : res.redirect(`/profiles/${p.id}/edit`)));
    } catch (e) { next(e); }
});

// A forgotten PIN: the account owner removes a family member's PIN from their own
// (unlocked) profile. The owner's own PIN can only be reset on the server
// (npm run reset-pin) — when one sign-in is shared, the account password is no secret.
router.post('/:id/reset-pin', async (req, res, next) => {
    try {
        const p = owns(req, parseInt(req.params.id, 10));
        if (!p) return res.status(404).json({ error: 'not found' });
        if (!p.parentId || !ownerProfileActive(req)) return res.status(403).json({ error: 'owner_only' });
        await prisma.user.update({ where: { id: p.id }, data: { pin: null } });
        forgetFails(p.id);
        res.json({ ok: true });
    } catch (e) { next(e); }
});

router.get('/new', (req, res) => {
    if (req.profiles.length >= MAX_PROFILES) return res.redirect('/profiles?manage=1');
    res.render('profile-edit', { editing: null, avatars: BUILTIN_AVATARS, errorKey: null, hasPassword: !!req.user.password });
});

router.get('/:id/edit', (req, res) => {
    const p = owns(req, parseInt(req.params.id, 10));
    if (!p) return res.redirect('/profiles?manage=1');
    if (!isUnlocked(req, p)) return res.redirect(`/profiles?manage=1&lock=${p.id}`);
    const errorKey = ['password', 'pin', 'current_pin'].includes(req.query.err) ? req.query.err : null;
    res.render('profile-edit', { editing: p, avatars: BUILTIN_AVATARS, errorKey, hasPassword: !!req.user.password });
});

function avatarFrom(req) {
    if (req.file) return uploadPath(req.file);
    const pick = String(req.body.avatarChoice || '');
    return BUILTIN_AVATARS.includes(pick) ? pick : undefined;
}

/** Applies the Profile Lock part of the edit form. Returns an error key or null. */
async function applyPinChange(req, p, data) {
    const action = req.body.pinAction;
    if (action !== 'set' && action !== 'remove') return null;
    // Changing a lock needs the account password (or, for SSO accounts, the current PIN —
    // except for the account owner managing a family member's profile).
    const ownerManaging = p && p.parentId && ownerProfileActive(req);
    if (req.user.password) {
        if (!(await bcrypt.compare(String(req.body.accountPassword || ''), req.user.password))) return 'password';
    } else if (p && p.pin && !ownerManaging && !(await bcrypt.compare(String(req.body.currentPin || ''), p.pin))) {
        return 'current_pin';
    }
    if (p) forgetFails(p.id);
    if (action === 'remove') { data.pin = null; return null; }
    const pin = String(req.body.newPin || '').trim();
    if (!PIN_RE.test(pin)) return 'pin';
    data.pin = await bcrypt.hash(pin, 10);
    return null;
}

router.post('/new', avatarUpload.single('avatar'), async (req, res, next) => {
    try {
        if (req.profiles.length >= MAX_PROFILES) { discardUpload(req); return res.redirect('/profiles?manage=1'); }
        const name = String(req.body.name || '').trim().slice(0, 24);
        if (!name) { discardUpload(req); return res.redirect('/profiles/new'); }
        const data = {
            username: `profile:${req.user.id}:${crypto.randomBytes(6).toString('hex')}`,
            password: null,
            role: 'viewer',
            auth_provider: 'profile',
            parentId: req.user.id,
            displayName: name,
            isKids: req.body.isKids === 'on',
            avatar: avatarFrom(req) || null
        };
        const err = await applyPinChange(req, null, data);
        if (err) { discardUpload(req); return res.render('profile-edit', { editing: null, avatars: BUILTIN_AVATARS, errorKey: err, hasPassword: !!req.user.password }); }
        await prisma.user.create({ data });
        res.redirect('/profiles?manage=1');
    } catch (e) { discardUpload(req); next(e); }
});

router.post('/:id/edit', avatarUpload.single('avatar'), async (req, res, next) => {
    try {
        const p = owns(req, parseInt(req.params.id, 10));
        if (!p) { discardUpload(req); return res.redirect('/profiles?manage=1'); }
        if (!isUnlocked(req, p)) { discardUpload(req); return res.redirect(`/profiles?manage=1&lock=${p.id}`); }
        const data = {};
        const name = String(req.body.name || '').trim().slice(0, 24);
        if (name) data.displayName = name;
        // The account's own profile can't become a kids profile (it holds admin rights).
        if (p.parentId) data.isKids = req.body.isKids === 'on';
        const av = avatarFrom(req);
        if (av !== undefined) data.avatar = av;
        const err = await applyPinChange(req, p, data);
        if (err) { discardUpload(req); return res.redirect(`/profiles/${p.id}/edit?err=${err}`); }
        await prisma.user.update({ where: { id: p.id }, data });
        delete req.session.editUnlocked;
        res.redirect('/profiles?manage=1');
    } catch (e) { discardUpload(req); next(e); }
});

router.post('/:id/delete', async (req, res, next) => {
    try {
        const p = owns(req, parseInt(req.params.id, 10));
        if (p && p.parentId) {
            if (!isUnlocked(req, p)) return res.redirect(`/profiles?manage=1&lock=${p.id}`);
            await prisma.user.delete({ where: { id: p.id } });
            if (req.session.profileId === p.id) { req.session.profileId = req.user.id; req.session.profileChosen = false; delete req.session.profileToken; }
            delete req.session.editUnlocked;
        }
        res.redirect('/profiles?manage=1');
    } catch (e) { next(e); }
});

export default router;
