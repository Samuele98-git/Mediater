// Applies prisma/schema.prisma to the database before the server starts.
// Safe to run on every start: schema changes in this project are additive, and
// `prisma db push` refuses (and stops the start) if a change would lose data.
import 'dotenv/config';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'file:./dev.db';

let cli;
try {
    cli = require.resolve('prisma/build/index.js');
} catch {
    console.error('[migrate] Prisma is not installed. Run "npm install" first.');
    process.exit(1);
}
const prisma = (...args) => spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', env: process.env, cwd: ROOT });

// Regenerate the client only when the schema changed (e.g. after a git pull).
const schema = path.join(ROOT, 'prisma', 'schema.prisma');
const generated = path.join(ROOT, 'node_modules', '.prisma', 'client', 'schema.prisma');
const read = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; } };
if (read(schema) !== read(generated)) {
    console.log('[migrate] Schema changed — regenerating the Prisma client…');
    if (prisma('generate').status !== 0) {
        console.warn('[migrate] Could not regenerate the Prisma client (is another Mediater instance running?).');
    }
}

if (prisma('db', 'push', '--skip-generate').status !== 0) {
    console.error('\n[migrate] Could not update the database schema (see the message above).');
    process.exit(1);
}
