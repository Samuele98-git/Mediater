import express from 'express';
import passport from 'passport';
import LocalStrategy from 'passport-local';
import OpenIDConnectStrategy from 'passport-openidconnect';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

// --- PASSPORT CONFIG ---
passport.serializeUser((u, d) => d(null, u.id));
passport.deserializeUser(async (id, d) => {
    try { d(null, await prisma.user.findUnique({ where: { id } })); } catch(e) { d(e); }
});

// Local Strategy
passport.use('local', new LocalStrategy(async (username, password, done) => {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return done(null, false, { message: 'User not found' });
    
    // Admin Master Key (Remove in production if needed)
    if (user.username === 'admin' && password === 'admin123' && user.password === 'admin123') return done(null, user);
    
    if (user.password && await bcrypt.compare(password, user.password)) return done(null, user);
    return done(null, false, { message: 'Invalid Password' });
}));

// Dynamic SSO Strategy Loader
(async () => {
    try {
        const s = await prisma.setting.findMany();
        const conf = s.reduce((acc, i) => ({...acc, [i.key]: i.value}), {});
        
        // Only load if critical keys exist
        if (conf.OIDC_CLIENT_ID && conf.OIDC_ISSUER) {
            console.log(">>> SSO Strategy Loaded");
            passport.use('oidc', new OpenIDConnectStrategy({
                issuer: conf.OIDC_ISSUER,
                authorizationURL: conf.OIDC_AUTH_URL,
                tokenURL: conf.OIDC_TOKEN_URL,
                userInfoURL: conf.OIDC_USERINFO_URL,
                clientID: conf.OIDC_CLIENT_ID,
                clientSecret: conf.OIDC_CLIENT_SECRET,
                callbackURL: "http://localhost:3000/auth/callback",
                scope: 'openid profile email'
            }, async (iss, sub, profile, token, refresh, done) => {
                try {
                    // Find or Create User
                    let user = await prisma.user.findUnique({ where: { username: profile.username } });
                    if (!user) {
                        user = await prisma.user.create({ 
                            data: { 
                                username: profile.username, 
                                role: 'viewer', 
                                auth_provider: 'oidc',
                                avatar: profile._json?.picture || null
                            }
                        });
                    }
                    return done(null, user);
                } catch (err) { return done(err); }
            }));
        }
    } catch(e) { console.error("SSO Init Error:", e); }
})();

// --- ROUTES ---

router.get('/login', async (req, res) => {
    // Check if SSO is active to show the button
    const ssoConfig = await prisma.setting.findUnique({ where: { key: 'OIDC_CLIENT_ID' } });
    res.render('login', { error: req.query.error, hasSso: !!(ssoConfig && ssoConfig.value) });
});

router.post('/auth/local', passport.authenticate('local', { failureRedirect: '/login?error=Invalid Credentials' }), (req, res) => {
    req.session.save(() => res.redirect(req.user.role === 'admin' ? '/admin' : '/'));
});

// SSO Routes
router.get('/auth/sso', (req, res, next) => {
    if (passport._strategies.oidc) passport.authenticate('oidc')(req, res, next);
    else res.redirect('/login?error=SSO_Not_Active');
});

router.get('/auth/callback', passport.authenticate('oidc', { failureRedirect: '/login' }), (req, res) => {
    req.session.save(() => res.redirect('/'));
});

// Logout (Fixes Login Lockout)
router.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) return next(err);
        req.session.destroy(() => {
            res.clearCookie('connect.sid'); // Explicitly clear cookie
            res.redirect('/login');
        });
    });
});

export default router;