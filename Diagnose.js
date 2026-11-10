// Tashxis: bot server bilan qanday ulanishini ko'rsatadi.
// Ishlatish (loyiha papkasida):
//   node diagnose.js online.articraft.uz 25565 DiagBot
// Ixtiyoriy 4-argument: versiya (masalan 1.21.1). Yo'q bo'lsa avto aniqlanadi.
const mineflayer = require('mineflayer');
const { ping } = require('minecraft-protocol');

const host = process.argv[2] || 'online.articraft.uz';
const port = Number(process.argv[3] || 25565);
const username = process.argv[4] || 'DiagBot';
const version = process.argv[5] || false;

(async () => {
  console.log(`1) Ping: ${host}:${port}`);
  try {
    const r = await ping({ host, port, closeTimeout: 8000 });
    console.log(`   OK. Versiya: ${r.version.name} (protokol ${r.version.protocol}), online: ${r.players.online}`);
  } catch (e) {
    console.log(`   XATO: ${e.message}`);
  }

  console.log(`2) Bot ulanishi (nick: ${username}, versiya: ${version || 'avto'})`);
  const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline', hideErrors: true });
  bot.on('login', () => console.log(`   LOGIN OK. Bot versiyasi: ${bot.version}`));
  bot.on('spawn', () => { console.log('   SPAWN OK — ulanish to\'liq ishladi'); setTimeout(() => process.exit(0), 2000); });
  bot.on('kicked', r => console.log(`   KICK: ${JSON.stringify(r).slice(0, 400)}`));
  bot.on('error', e => console.log(`   XATO: ${e.message}`));
  bot.on('end', r => { console.log(`   END: ${r}`); process.exit(0); });
  setTimeout(() => { console.log('   60 soniya o\'tdi, to\'xtatildi'); process.exit(0); }, 60000);
})();