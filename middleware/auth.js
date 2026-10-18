import prisma from '../lib/prisma.js';

const wantsJson = (req) => req.xhr || (req.originalUrl || '').startsWith('/api/') || (req.get('accept') || '').includes('application/json');

/** Signed-in account (never a sub-profile row). */
export function isAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated() && req.user && !req.user.parentId) return next();
    if (wantsJson(req)) return res.status(401).json({ error: 'Not signed in' });
    const nextUrl = req.method === 'GET' && req.originalUrl !== '/' ? '?next=' + encodeURIComponent(req.originalUrl) : '';
    return res.redirect('/login' + nextUrl);
}

export const displayName = (u) => (u && (u.displayName || u.username)) || '';

export function avatarUrl(u) {
    if (!u) return '/img/avatars/avatar-1.svg';
    if (u.avatar) return u.avatar;
    if (u.isKids) return '/img/avatars/kids.svg';
    return `/img/avatars/avatar-${(u.id % 8) + 1}.svg`;
}

/** True when "Who's watching?" must be shown first (several profiles, or a locked one). */
export function needsProfileGate(req) {
    if (req.session.profileChosen) return false;
    return (req.profiles && req.profiles.length > 1) || !!(req.profile && req.profile.pin);
}

/**
 * Admin rights belong to the account owner: an admin account, using its own main
 * profile (not a family member's or a kids profile), unlocked if it has a PIN.
 */
export function ownerAdmin(req) {
    const u = req.user;
    if (!u || u.parentId || u.role !== 'admin') return false;
    const p = req.profile || u;
    return p.id === u.id && !p.isKids && !needsProfileGate(req);
}

async function resolveProfile(req, res) {
    res.locals.profile = null;
    res.locals.profiles = [];
    res.locals.canAdmin = false;
    res.locals.displayName = displayName;
    res.locals.avatarUrl = avatarUrl;
    if (!req.user || req.user.parentId) return;
    const subs = await prisma.user.findMany({ where: { parentId: req.user.id }, orderBy: { id: 'asc' } });
    const all = [req.user, ...subs];
    const active = all.find(p => p.id === req.session.profileId) || req.user;
    req.profile = active;
    req.profiles = all;
    res.locals.profile = active;
    res.locals.profiles = all;
    res.locals.isKids = !!active.isKids;
    res.locals.canAdmin = ownerAdmin(req);
}

/** Resolves the active "Who's watching?" profile for this session. */
export async function loadProfile(req, res, next) {
    try { await resolveProfile(req, res); next(); } catch (e) { next(e); }
}

export async function isAdmin(req, res, next) {
    const signedIn = req.isAuthenticated && req.isAuthenticated() && req.user && !req.user.parentId;
    if (signedIn && !req.profiles) {
        // routes mounted before the profile lookup (video streams)
        try { await resolveProfile(req, res); } catch (e) { return next(e); }
    }
    if (signedIn && ownerAdmin(req)) return next();
    if (signedIn && req.user.role === 'admin' && needsProfileGate(req)) {
        if (wantsJson(req)) return res.status(403).json({ error: 'Choose a profile first' });
        return res.redirect('/profiles?next=' + encodeURIComponent(req.originalUrl));
    }
    if (wantsJson(req)) return res.status(signedIn ? 403 : 401).json({ error: signedIn ? 'Admins only' : 'Not signed in' });
    return res.redirect(signedIn ? '/' : '/login');
}

export function requireProfile(req, res, next) {
    if (needsProfileGate(req)) return res.redirect('/profiles?next=' + encodeURIComponent(req.originalUrl));
    next();
}

/** Same for JSON endpoints: no profile data until a profile has been chosen. */
export function requireProfileApi(req, res, next) {
    if (needsProfileGate(req)) return res.status(403).json({ error: 'Choose a profile first' });
    next();
}

/**
 * Light version of the profile lookup for video streams (hit many times per
 * second): who is watching, whether it's a kids profile and whether it's the
 * owner with admin rights.
 */
export async function streamViewer(req, res, next) {
    try {
        const u = req.user;
        const pid = req.session.profileId;
        let p = u;
        if (pid && pid !== u.id) {
            const sub = await prisma.user.findUnique({ where: { id: pid }, select: { id: true, parentId: true, isKids: true } });
            if (sub && sub.parentId === u.id) p = sub;
        }
        const ownerUnlocked = !u.pin || (req.session.profileChosen && p.id === u.id);
        req.viewer = { kids: !!p.isKids, admin: u.role === 'admin' && p.id === u.id && !u.isKids && ownerUnlocked };
        next();
    } catch (e) { next(e); }
}
