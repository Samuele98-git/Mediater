import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function initDB() {
  try {
    const admin = await prisma.user.findUnique({ where: { username: 'admin' } });

    if (!admin) {
      console.log('>>> Creazione Utente Admin (NO BCRYPT)...');
      
      await prisma.user.create({
        data: {
          username: 'admin',
          // SALVIAMO LA PASSWORD IN CHIARO PER IL TEST
          password: 'admin123', 
          role: 'admin',
          email: 'admin@mediater.local',
          auth_provider: 'local'
        }
      });
      console.log('>>> ADMIN PRONTO: admin / admin123');
    }
  } catch (e) {
    console.error("DB Init Error:", e);
  }
}

export default prisma;