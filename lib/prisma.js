// One shared Prisma client for the whole app (several clients against the
// same SQLite file cause "database is locked" errors under load).
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'file:./dev.db';

const prisma = new PrismaClient();

// WAL lets readers and the single writer work at the same time.
export async function tuneDatabase() {
    try {
        await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
        await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
    } catch (e) {
        console.warn('[db] could not enable WAL:', e.message);
    }
}

export default prisma;
