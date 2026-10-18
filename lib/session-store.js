// express-session store backed by the app's SQLite database (Prisma).
// Replaces session-file-store, whose rename()-based writes fail on Windows
// when several requests touch the same session at once (EPERM).
import session from 'express-session';
import prisma from './prisma.js';

const TOUCH_EVERY_MS = 60_000;

export default class PrismaSessionStore extends session.Store {
    constructor({ ttlSeconds = 30 * 86400 } = {}) {
        super();
        this.ttlMs = ttlSeconds * 1000;
        this.touched = new Map();
        this.pruneTimer = setInterval(() => this.prune(), 6 * 3600 * 1000);
        this.pruneTimer.unref();
        setTimeout(() => this.prune(), 30_000).unref();
    }

    expiry(sess) {
        const exp = sess && sess.cookie && sess.cookie.expires;
        return exp ? new Date(exp) : new Date(Date.now() + this.ttlMs);
    }

    get(sid, cb) {
        prisma.session.findUnique({ where: { sid } })
            .then(row => {
                if (!row) return cb(null, null);
                if (row.expiresAt < new Date()) { this.destroy(sid); return cb(null, null); }
                try { cb(null, JSON.parse(row.data)); } catch { cb(null, null); }
            })
            .catch(err => cb(err));
    }

    set(sid, sess, cb) {
        const data = JSON.stringify(sess);
        const expiresAt = this.expiry(sess);
        prisma.session.upsert({ where: { sid }, update: { data, expiresAt }, create: { sid, data, expiresAt } })
            .then(() => { this.touched.set(sid, Date.now()); cb && cb(); })
            .catch(err => cb && cb(err));
    }

    touch(sid, sess, cb) {
        // Rolling sessions touch on every request; writing once a minute is plenty.
        const last = this.touched.get(sid) || 0;
        if (Date.now() - last < TOUCH_EVERY_MS) return cb && cb();
        this.touched.set(sid, Date.now());
        prisma.session.updateMany({ where: { sid }, data: { expiresAt: this.expiry(sess) } })
            .then(() => cb && cb())
            .catch(err => cb && cb(err));
    }

    destroy(sid, cb) {
        this.touched.delete(sid);
        prisma.session.deleteMany({ where: { sid } })
            .then(() => cb && cb())
            .catch(err => cb && cb(err));
    }

    prune() {
        prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
        if (this.touched.size > 10000) this.touched.clear();
    }
}
