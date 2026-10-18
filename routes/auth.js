import express from 'express';
import passport from 'passport';
import LocalStrategy from 'passport-local';
import OpenIDConnectStrategy from 'passport-openidconnect';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma.js';
import { getSettings, settingsEvents } from '../lib/settings.js';
import { PORT } from '../lib/config.js';
import { PROFILE_COOKIE } from '../middleware/auth.js';

const router = express.Router();

passport.serializeUser((u, done) => done(null, u.id));
passport.deserializeUser(async (id, done) => {
    try { done(null, await prisma.user.findUnique({ where: { id } })); } catch (e) { done(e); }
});

passport.use('local', new LocalStrategy(async (username, password, done) => {
    try {
        const user = await prisma.user.findUnique({ where: { username: String(username || '').trim() } });
        // Sub-profiles have no password and can never sign in directly.
        if (!user || !user.password || user.parentId) return done(null, false);
        if (await bcrypt.compare(String(password || ''), user.password)) return done(null, user);
        return done(null, false);
    } catch (e) { return done(e); }
}));

// --- SSO (OpenID Connect), re-registered whenever settings change ---
const tokenClaims = (jwt) => {
    try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')) || {}; } catch { return {}; }
};

/**
 * Finds or creates the account for an SSO sign-in. Accounts are matched by the
 * provider's stable subject id, never by username, so an identity-provider user
 * called "admin" can't sign in as the local admin.
 */
async function ssoUser(iss, profile, idToken) {
    if (!profile || !profile.id) return false;
    const subject = `${iss}|${profile.id}`;
    const user = await prisma.user.findFirst({ where: { oidcSubject: subject }, orderBy: { id: 'asc' } });
    if (user) return user.parentId ? false : user;

    const claims = tokenClaims(idToken);
    const email = profile.emails && profile.emails[0] && profile.emails[0].value;
    const verifiedEmail = email && claims.email_verified === true ? email : null;
    const wanted = String(profile.username || verifiedEmail || profile.id).trim().slice(0, 60) || 'user';
    // SSO accounts created before subjects were stored (same naming rule as back then):
    // link them once. Local password accounts are never touched.
    const legacy = await prisma.user.findUnique({ where: { username: String(profile.username || email || profile.id) } });
    if (legacy && legacy.auth_provider === 'oidc' && !legacy.oidcSubject && !legacy.parentId) {
        return prisma.user.update({ where: { id: legacy.id }, data: { oidcSubject: subject } });
    }
    let username = wanted;
    for (let n = 2; await prisma.user.findUnique({ where: { username } }); n++) username = `${wanted}-${n}`;
    return prisma.user.create({
        data: {
            username, role: 'viewer', auth_provider: 'oidc', oidcSubject: subject,
            displayName: profile.displayName ? String(profile.displayName).slice(0, 60) : null,
            avatar: /^https:\/\//i.test(claims.picture || '') ? claims.picture : null
        }
    });
}

async function loadSso(conf) {
    passport.unuse('oidc');
    if (!(conf.OIDC_CLIENT_ID && conf.OIDC_ISSUER)) return;
    const base = (conf.PUBLIC_URL || process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
    passport.use('oidc', new OpenIDConnectStrategy({
        issuer: conf.OIDC_ISSUER,
        authorizationURL: conf.OIDC_AUTH_URL,
        tokenURL: conf.OIDC_TOKEN_URL,
        userInfoURL: conf.OIDC_USERINFO_URL,
        clientID: conf.OIDC_CLIENT_ID,
        clientSecret: conf.OIDC_CLIENT_SECRET,
        callbackURL: base + '/auth/callback',
        scope: 'openid profile email'
    }, async (iss, profile, context, idToken, done) => {
        try {
            done(null, await ssoUser(iss, profile, idToken));
        } catch (err) { return done(err); }
    }));
    console.log('[auth] SSO strategy loaded');
}
getSettings().then(loadSso).catch(e => console.error('[auth] SSO init error:', e.message));
settingsEvents.on('change', conf => loadSso(conf).catch(e => console.error('[auth] SSO reload error:', e.message)));

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login')) ? n : '/';

// Several people may share one sign-in: "Who's watching?" always comes first,
// so nobody lands in the admin's profile without picking it (and its PIN).
async function afterLogin(req, res) {
    req.session.profileId = req.user.id;
    req.session.profileChosen = false;
    delete req.session.profileToken;
    const next = safeNext(req.session.returnTo);
    delete req.session.returnTo;
    req.session.save(() => res.redirect('/profiles?next=' + encodeURIComponent(next)));
}

router.get('/login', (req, res, next) => {
    if (req.isAuthenticated() && req.user && !req.user.parentId) return res.redirect('/');
    if (req.query.next) req.session.returnTo = safeNext(req.query.next);
    getSettings()
        .then(conf => res.render('login', { error: req.query.error ? 1 : 0, hasSso: !!(conf.OIDC_CLIENT_ID && conf.OIDC_ISSUER) }))
        .catch(next);
});

router.post('/auth/local', (req, res, next) => {
    const returnTo = req.session.returnTo;
    passport.authenticate('local', (err, user) => {
        if (err) return next(err);
        if (!user) return res.redirect('/login?error=1');
        req.logIn(user, (e) => {
            if (e) return next(e);
            // passport regenerates the session on login; keep the deep link
            req.session.returnTo = returnTo;
            afterLogin(req, res).catch(next);
        });
    })(req, res, next);
});

router.get('/auth/sso', (req, res, next) => {
    if (passport._strategy('oidc')) passport.authenticate('oidc')(req, res, next);
    else res.redirect('/login?error=1');
});

router.get('/auth/callback', (req, res, next) => {
    if (!passport._strategy('oidc')) return res.redirect('/login?error=1');
    passport.authenticate('oidc', { failureRedirect: '/login?error=1' })(req, res, () => afterLogin(req, res).catch(next));
});

router.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        req.session.destroy(() => {
            res.clearCookie('mediater.sid');
            res.clearCookie(PROFILE_COOKIE);
            res.redirect('/login');
        });
    });
});

export default router;
