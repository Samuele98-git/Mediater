// Removes the PIN from an account's own profile — for when the admin forgets it.
// It runs on the server only, on purpose: when one sign-in is shared, the account
// password is no secret, so it can't be allowed to remove the admin's PIN.
//
//   npm run reset-pin              → the first admin account
//   npm run reset-pin -- <username>
import 'dotenv/config';
import prisma from '../lib/prisma.js';

const name = process.argv[2];
try {
    const user = name
        ? await prisma.user.findUnique({ where: { username: name } })
        : await prisma.user.findFirst({ where: { role: 'admin', parentId: null }, orderBy: { id: 'asc' } });
    if (!user || user.parentId) {
        console.error(name ? `No account called "${name}".` : 'No admin account found.');
        process.exitCode = 1;
    } else if (!user.pin) {
        console.log(`"${user.displayName || user.username}" has no PIN.`);
    } else {
        await prisma.user.update({ where: { id: user.id }, data: { pin: null } });
        console.log(`PIN removed from "${user.displayName || user.username}". Set a new one in Manage Profiles → Profile Lock.`);
    }
} finally {
    await prisma.$disconnect();
}
