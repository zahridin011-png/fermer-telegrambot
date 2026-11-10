'use strict';
// =====================================================================
//  Tarvuz fermasi moduli:
//   - pishgan tarvuzni baltada yig'adi (bolta chidamliligi kam bo'lsa almashtiradi)
//   - inventar to'lsa sandiqqa tashlaydi, bolta/ovqat tugasa sandiqdan oladi
//   - ochsa o'zi ovqatlanadi (startAutoEat)
//   - xatolar va topilgan tarvuz soni Telegramga xabar qilinadi
// =====================================================================
const { Movements, goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');

const AXE_MIN_LEFT = 15;      // chidamlilik shundan kam bo'lsa — "sinishga yaqin", ishlatilmaydi
const AXE_SAFE_USES = 150;    // chidamlilik o'qilmasa: shuncha tarvuzdan keyin almashtiriladi
const FOOD_KEEP = 16;         // inventarda har bir ovqatdan shuncha dona qoldiriladi
const FOOD_START = 14;        // ochlik (food < 14) bo'lsa ovqatlanadi
const FULL_SLOTS = 2;         // bo'sh katak shundan kam bo'lsa sandiqqa boradi
const BAD_MELON_MS = 60_000;  // yo'lga kira olmagan tarvuzni shuncha vaqt chetlab o'tamiz
const ERR_REPEAT_EVERY = 10;  // bir xil xato har 10 marta bir marta xabar qilinadi
const DIAG_EVERY_MS = 300_000; // tarvuz topilmasa, diagnostika xabari har 5 daqiqada

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Promise ga vaqt chegarasi qo'yadi: tugamasa xato beradi (osilib qolishning oldini oladi)
function withTimeout(p, ms, label) {
  let t;
  const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} vaqti tugadi`)), ms); });
  return Promise.race([p, guard]).finally(() => clearTimeout(t));
}

class FarmStop extends Error {}

const isAxe = item => !!item && /_axe$/.test(item.name);
const isMelon = b => !!b && (b.name === 'melon' || b.name === 'melon_block');
const isAir = b => !!b && (b.name === 'air' || b.name === 'cave_air' || b.boundingBox === 'empty');
const keyOf = p => `${p.x},${p.y},${p.z}`;

// Bolta chidamliligi: maxDurability - durabilityUsed. O'qib bo'lmasa null.
// Eski mineflayer 1.21 dagi enchant/component ma'lumotini o'qiy olmasa ham xato bermaydi.
function axeLeft(item) {
  try {
    if (!item || !item.maxDurability || typeof item.durabilityUsed !== 'number') return null;
    return item.maxDurability - item.durabilityUsed;
  } catch {
    return null;
  }
}

// Buyumdagi effektlarni [{name, lvl}] ko'rinishida o'qiydi (1.21 komponent va eski nbt formatlari)
function parseEnchants(item) {
  try {
    if (Array.isArray(item.enchants) && item.enchants.length) return item.enchants;
  } catch {}
  const out = [];
  try {
    const comps = Array.isArray(item.components) ? item.components : [];
    const c = comps.find(x => x && x.type === 'enchantments');
    const levels = c && c.data && (c.data.levels || c.data);
    if (levels && typeof levels === 'object') {
      for (const [k, v] of Object.entries(levels)) out.push({ name: k.replace('minecraft:', ''), lvl: Number(v) });
    }
  } catch {}
  try {
    const list = item.nbt && item.nbt.value && item.nbt.value.Enchantments && item.nbt.value.Enchantments.value && item.nbt.value.Enchantments.value.value;
    if (Array.isArray(list)) {
      for (const e of list) out.push({ name: String(e.id.value).replace('minecraft:', ''), lvl: Number(e.lvl.value) });
    }
  } catch {}
  return out;
}

// Mineflayer'ning digTime ini o'zimiz to'g'rilaymiz: effektlarni buyumdan o'qiymiz,
// shunda bolta bilan sindirish qo'l bilan sindirishdan tez bo'ladi.
function installDigPatch(bot) {
  if (bot._digPatched) return;
  bot._digPatched = true;
  bot.digTime = (block) => {
    const held = bot.heldItem;
    const type = held ? held.type : null;
    const enchants = held ? parseEnchants(held) : [];
    const creative = !!(bot.game && bot.game.gameMode === 'creative');
    const eyeBlock = bot._getBlockAtEyeLevel ? bot._getBlockAtEyeLevel() : null;
    const inWater = !!eyeBlock && ['water', 'flowing_water'].includes(eyeBlock.name);
    return block.digTime(type, creative, inWater, !bot.entity.onGround, enchants, bot.entity.effects || {});
  };
}

// ---------------- AVTOMATIK OVQATLANISH ----------------
// Ochlik bo'lsa inventardagi eng to'yimli ovqatni yeydi. Ferma bu paytda kutadi.
function startAutoEat(bot) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || bot.farmBusy || !bot.entity || typeof bot.food !== 'number' || bot.food >= FOOD_START) return;
    busy = true;
    bot.eatingNow = true;
    try {
      const foods = (bot.registry && bot.registry.foodsByName) || {};
      const cands = bot.inventory.items()
        .filter(i => foods[i.name])
        .sort((a, b) => (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0));
      if (cands.length) {
        await bot.equip(cands[0], 'hand');
        await bot.consume();
      }
    } catch (e) {
      // ovqat yeyilmasa keyingi tsiklda qayta uriniladi
    } finally {
      bot.eatingNow = false;
      busy = false;
    }
  }, 2000);
  return () => clearInterval(timer);
}

// ---------------- FERMA ----------------
class Farm {
  // cfg: { area: {x,y,z,r}, chest: {x,y,z} }, hooks: { notify(text) }
  constructor(bot, cfg, hooks) {
    this.bot = bot;
    this.area = cfg.area || null;
    this.chest = cfg.chest || null;
    this.notify = hooks.notify;
    this.reconnect = hooks.reconnect || null;   // pozitsiya buzilganda botni qayta ulash
    this.onFarmStop = hooks.onFarmStop || null; // ferma o'zi to'xtasa (bolta/sandiq xatosi)
    this.running = false;
    this.posBadSince = 0;
    this.harvested = 0;
    this.deposits = 0;
    this.axeUses = 0;
    this.since = null;
    this.last = '-';
    this.lastRestock = 0;
    this.badMelons = new Map();   // yo'lga kirilmagan tarvuzlar: key -> vaqt
    this.errCount = 0;
    this.lastErr = null;
    this.lastDiag = 0;
    this.noMelonSince = 0;
    this.abortStreak = 0;         // ketma-ket bekor bo'lgan sindirishlar soni
    this.lastProgress = Date.now();
    this.watch = null;
    this.watchdogMs = hooks.watchdogMs || 180_000;   // 3 daqiqa harakatsizlik -> qayta ulanish
  }

  report(text) { this.notify(`🌾 ${text}`); }

  // Bot pozitsiyasi haqiqiy raqamlarmi (NaN bo'lsa, yo'l topib bo'lmaydi)
  // Kutish, lekin har 500 ms da holatni tekshiradi (NaN yoki to'xtatish darhol seziladi)
  async idleWait(ms) {
    for (let t = 0; t < ms; t += 500) {
      if (!this.running || !this.posOk()) return;
      await sleep(500);
    }
  }

  posOk() {
    const p = this.bot.entity && this.bot.entity.position;
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  }

  // Bolta sinishga yaqinmi?
  isWorn(item) {
    const left = axeLeft(item);
    return left === null ? this.axeUses >= AXE_SAFE_USES : left <= AXE_MIN_LEFT;
  }

  start() {
    if (this.running) return { ok: false, msg: 'Ferma allaqachon ishlayapti' };
    if (!this.bot.entity) return { ok: false, msg: 'Bot serverda emas' };
    if (!this.area) return { ok: false, msg: 'Avval maydon belgilang: /ferma <id> area x y z r' };
    if (!this.bot.pathfinder) return { ok: false, msg: 'Pathfinder yuklanmagan' };
    this.running = true;
    this.since = Date.now();
    this.lastProgress = Date.now();
    const limit = this.watchdogMs;
    this.watch = setInterval(() => {
      if (!this.running) return;
      const idle = Date.now() - this.lastProgress;
      if (idle > limit) {
        // Uzoq vaqt harakat yo'q: botni qayta ulaymiz, ulanish tiklangach ferma o'zi davom etadi
        this.report(`⏳ ${Math.round(limit / 1000)} soniyadan beri harakat yo'q (oxirgi: ${this.last}). Botni qayta ulayman.`);
        this.lastProgress = Date.now();
        this.stop('harakatsizlik, qayta ulanish', true);
        if (this.reconnect) this.reconnect();
      }
    }, Math.min(20_000, Math.max(200, limit / 3)));
    this.errCount = 0;
    this.lastErr = null;
    this.run().catch(e => this.stop(`kutilmagan xato: ${e.message}`));
    return { ok: true, msg: '🌾 Ferma ishga tushdi' };
  }

  stop(reason = "to'xtatildi", silent = false) {
    if (!this.running) return;
    this.running = false;
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    try { if (this.bot.pathfinder) this.bot.pathfinder.stop(); } catch {}
    if (!silent) this.report(`Ferma to'xtadi: ${reason}`);
  }

  // Yo'lga yetish: 30 soniyada tugamasa, pathfinder to'xtatiladi va xato qaytariladi
  async gotoSafe(goal, ms = 90000) {
    this.lastProgress = Date.now();
    if (!this.posOk()) throw new Error('pozitsiya NaN, harakat to\'xtatildi');
    try {
      return await withTimeout(this.bot.pathfinder.goto(goal), ms, "yo'lga yetish");
    } catch (e) {
      try { this.bot.pathfinder.stop(); } catch {}
      throw e;
    }
  }

  setupMovements() {
    const m = new Movements(this.bot);
    m.canDig = false;          // yo'lda blok sindirmaydi (ferma blokalari buzilmasin)
    // Parkur va sprint yoqilgan: qatorlar orasidagi 1 blokli kanal/bo'shliqdan sakrab o'tish kerak.
    // Bu o'chirilsa, bot ikkinchi qatorga yo'l topa olmaydi va jim turib qoladi.
    m.allowParkour = true;
    m.allowSprinting = true;
    this.bot.pathfinder.setMovements(m);
  }

  async run() {
    const bot = this.bot;
    installDigPatch(bot);
    // Pathfinder standart 5 soniyada yo'lni hisoblab ulgurmaydi: uzun yo'llar (qatorlar, spawn -> ferma) uchun vaqtni oshiramiz
    bot.pathfinder.thinkTimeout = 60_000;
    bot.pathfinder.tickTimeout = 50;
    this.setupMovements();
    const n = this.findMelons().length;
    const axe = bot.heldItem && isAxe(bot.heldItem) ? bot.heldItem : bot.inventory.items().find(isAxe);
    const eff = axe ? parseEnchants(axe).find(e => /efficiency/.test(e.name)) : null;
    const axeInfo = axe ? `${axe.name}${eff ? `, efficiency ${eff.lvl}` : ' (effekt o\'qilmadi)'}` : "bolta yo'q";
    this.report(`Ferma ishga tushdi. Markaz: ${this.area.x} ${this.area.y} ${this.area.z}, radius ${this.area.r}. ` +
      `Pishgan tarvuz: ${n} ta${n === 0 ? ' (hozircha yo\'q)' : ''}. Bolta: ${axeInfo}.`);

    while (this.running && bot.entity) {
      this.lastProgress = Date.now();
      try {
        while (this.running && bot.eatingNow) await sleep(300);
        if (!this.running) break;

        if (!this.posOk()) {
          // Pozitsiya buzilgan: harakatni darhol to'xtatamiz (server "ichki xato" deb uzmasin), so'ng qayta ulaymiz
          this.posBadSince = this.posBadSince || Date.now();
          this.last = 'bot pozitsiyasi buzildi (NaN)';
          try { bot.pathfinder.stop(); } catch {}
          try { bot.clearControlStates(); } catch {}
          if (Date.now() - this.posBadSince > 2_000) {
            this.posBadSince = 0;
            this.report("Bot pozitsiyasi buzildi (NaN). Harakat to'xtatildi, bot qayta ulanadi, ferma o'zi davom etadi.");
            this.stop('pozitsiya buzildi', true);
            if (this.reconnect) this.reconnect();
            break;
          }
          await sleep(500);
          continue;
        }
        this.posBadSince = 0;

        await this.maybeRestock();
        if (!this.running) break;
        if (bot.inventory.emptySlotCount() <= FULL_SLOTS) await this.deposit();
        if (!this.running) break;

        const melons = this.findMelons();
        if (!melons.length) {
          // Bot maydondan uzoqda bo'lsa, chunklar yuklanmagan bo'ladi: avval maydonga boramiz
          const c = new Vec3(this.area.x, this.area.y, this.area.z);
          if (bot.entity.position.distanceTo(c) > 24) {
            this.last = 'maydonga yaqinlashilmoqda';
            await this.gotoSafe(new goals.GoalNear(c.x, c.y, c.z, 4));
            continue;
          }
          const raw = this.rawMelons();
          if (raw.length) {
            this.last = `${raw.length} ta tarvuz bor, lekin hozir yo'lga kirilmaydi`;
            this.noteBlocked(raw.length);
          } else {
            this.last = 'pishgan tarvuz kutilmoqda';
            this.noteNoMelon();
          }
          await this.idleWait(10_000);
          continue;
        }
        this.noMelonSince = 0;
        const target = this.nearest(melons);

        // 1) Yetib borish (harakat — sindirishdan oldin)
        if (!this.reachOk(target)) {
          this.last = `tarvuzga yo'l izlanmoqda (${target.x} ${target.y} ${target.z})`;
          try {
            await this.goToMelon(target);
          } catch (e) {
            if (!this.running) break;
            const msg = String(e && e.message);
            // To'xtatilgan yoki vaqtinchalik xato: tarvuzni bloklamaymiz, qayta uriniladi
            if (/stopped|NaN|pozitsiya/i.test(msg)) {
              this.last = `yo'l vaqtincha to'xtadi: ${msg}`;
              await sleep(2000);
              continue;
            }
            this.badMelon(target, `yo'l topilmadi (${msg})`);
            continue;
          }
          if (!this.running) break;
        }
        // Pathfinder yetib kelgach ham pozitsiya bir oz "o'rnashadi": 2 soniya kutib, qayta tekshiramiz
        const settleUntil = Date.now() + 2000;
        while (!this.reachOk(target) && Date.now() < settleUntil && this.running && this.posOk()) {
          await sleep(100);
        }
        if (!this.reachOk(target)) {
          this.badMelon(target, "tarvuzga yetib bo'lmadi (masofa katta)");
          continue;
        }

        // 2) Sindirish: harakat va ovqatlanish aralashmasligi uchun bloklaymiz
        while (bot.eatingNow) await sleep(200);
        bot.farmBusy = true;
        try {
          await this.ensureAxe();
          if (!(await this.aimAt(target))) {
            this.badMelon(target, "tarvuz ko'rinmayapti (oldida boshqa blok bor)");
            continue;
          }
          const block = bot.blockAt(target);
          if (!isMelon(block)) {
            this.last = "tarvuz allaqachon yo'q";
            await sleep(500);
            continue;
          }
          await this.digSafe(block);
        } finally {
          bot.farmBusy = false;
        }

        this.harvested++;
        this.axeUses++;
        this.last = `tarvuz yig'ildi (${target.x} ${target.y} ${target.z})`;
        await sleep(350);
        await this.pickupDrops(target);
      } catch (e) {
        if (!this.running) break;
        if (e instanceof FarmStop) {
          this.stop(e.message);
          if (this.onFarmStop) this.onFarmStop();
          break;
        }
        this.errCount++;
        this.last = `xato: ${e.message}`;
        if (e.message !== this.lastErr || this.errCount % ERR_REPEAT_EVERY === 0) {
          this.report(`⚠️ ${e.message}${this.errCount > 1 ? ` (${this.errCount} marta)` : ''}`);
        }
        this.lastErr = e.message;
        await sleep(3000);
      }
    }
  }

  badMelon(pos, reason) {
    this.badMelons.set(keyOf(pos), Date.now());
    this.last = `chetlab o'tildi (${pos.x} ${pos.y} ${pos.z}): ${reason}`;
    this.report(`Tarvuz chetlab o'tildi (${pos.x} ${pos.y} ${pos.z}): ${reason}`);
  }

  // Ko'z balandligidan tarvuz markazigacha masofa sindirish uchun yetarlimi
  reachOk(pos) {
    const eye = this.bot.entity.position.offset(0, 1.62, 0);
    return eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.2;
  }

  // Botning ko'rish nuqtasi aynan shu tarvuzga qaratilganini tekshiradi
  async aimAt(target) {
    const bot = this.bot;
    const center = target.offset(0.5, 0.5, 0.5);
    for (let i = 0; i < 2; i++) {
      await bot.lookAt(center, true);
      const hit = bot.blockAtCursor(5);
      if (hit && hit.position && hit.position.x === target.x &&
          hit.position.y === target.y && hit.position.z === target.z) return true;
    }
    return false;
  }

  // Maydondagi pishgan tarvuzlar (yo'lga kirilmaganlarini chetlab o'tadi)
  findMelons() {
    const { x, y, z, r } = this.area;
    const now = Date.now();
    for (const [k, t] of this.badMelons) if (now - t > BAD_MELON_MS) this.badMelons.delete(k);
    const found = this.bot.findBlocks({
      point: new Vec3(x, y, z),
      maxDistance: r,
      count: 64,
      matching: isMelon,
    }) || [];
    return found.filter(p => !this.badMelons.has(keyOf(p)));
  }

  // Bloklanganlarni ham qo'shib, maydondagi barcha pishgan tarvuzlar
  rawMelons() {
    const { x, y, z, r } = this.area;
    return this.bot.findBlocks({ point: new Vec3(x, y, z), maxDistance: r, count: 64, matching: isMelon }) || [];
  }

  noteBlocked(n) {
    const now = Date.now();
    if (now - this.lastDiag < DIAG_EVERY_MS) return;
    this.lastDiag = now;
    this.report(`Maydonda ${n} ta pishgan tarvuz bor, lekin hozir hech biriga yo'l topilmayapti. ` +
      `Ular 60 soniyadan keyin qayta tekshiriladi. Agar davom etsa, /version <id> auto qilib ko'ring.`);
  }

  nearest(positions) {
    const me = this.bot.entity.position;
    return positions.slice().sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0];
  }

  // Tarvuz yonida turish mumkin bo'lgan joylar (oyoq va bosh joyi havo, ostida qattiq blok)
  standCandidates(m) {
    const out = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const p = m.offset(dx, 0, dz);
      const foot = this.bot.blockAt(p);
      const head = this.bot.blockAt(p.offset(0, 1, 0));
      const ground = this.bot.blockAt(p.offset(0, -1, 0));
      if (isAir(foot) && isAir(head) && ground && !isAir(ground)) out.push(p);
    }
    return out;
  }

  async goToMelon(m) {
    for (const p of this.standCandidates(m)) {
      if (!this.running) return;
      try {
        await this.gotoSafe(new goals.GoalBlock(p.x, p.y, p.z));
        return;
      } catch (e) {
        if (!this.running) return;
        // keyingi joyni sinab ko'ramiz
      }
    }
    // zaxira: tarvuzdan 3 blok masofagacha yaqinlashish
    await this.gotoSafe(new goals.GoalNear(m.x, m.y, m.z, 3));
  }

  // Sindirish: bekor bo'lsa yoki osilib qolsa qayta urinadi
  async digSafe(block) {
    const bot = this.bot;
    const pos = block.position;
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.lastProgress = Date.now();
      const expect = bot.digTime(block);
      const limit = Math.max(4000, expect * 3 + 3000);
      try {
        await withTimeout(bot.dig(block, true), limit, 'sindirish');
        if (!isMelon(bot.blockAt(pos))) { this.abortStreak = 0; return; }   // tarvuz haqiqatan yo'qoldi
        this.last = `sindirish takrorlanmoqda (${attempt}-urinish)`;
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/vaqti tugadi/.test(msg)) {
          // Server blok yo'qolganini yubormadi: sindirish holatini tozalaymiz
          try { bot.stopDigging(); } catch {}
          bot.targetDigBlock = null;
          bot.targetDigFace = null;
          if (!isMelon(bot.blockAt(pos))) { this.abortStreak = 0; return; }
          this.last = "sindirish osilib qoldi, qayta uriniladi";
          continue;
        }
        if (/enchant/i.test(msg)) return this.handDig(block);
        if (!/aborted/i.test(msg)) throw e;               // bekor qilingan — qayta uriniladi
        this.abortStreak++;
        if (this.abortStreak === 3) {
          this.report("Sindirish ketma-ket 3 marta bekor bo'lmoqda. Sabab ko'pincha botning versiyasi serverga mos emasligi: " +
            "Telegramda /version <id> auto yozing, so'ng 🔄 Restart qiling.");
        }
      }
      if (!this.running) return;
    }
    this.abortStreak = 0;
    throw new Error(`tarvuz sindirilmadi (${pos.x} ${pos.y} ${pos.z}), 3 urinish`);
  }

  // Zaxira: digTime umuman ishlamasa, qo'l bilan sindiradi va boltani qaytaradi
  async handDig(block) {
    const bot = this.bot;
    await bot.unequip('hand');
    await withTimeout(bot.dig(block, true), 15000, 'qo\'lda sindirish');
    if (!this.handNotified) {
      this.handNotified = true;
      this.report("Bolta effektini o'qib bo'lmadi, tarvuz qo'l bilan sindirildi. Mineflayer'ni yangilang (npm install mineflayer@latest).");
    }
    await this.ensureAxe();
  }

  // Tarvuz topilmasa: nima uchun topilmayotganini aniqlash (blok nomlari bo'yicha)
  noteNoMelon() {
    const now = Date.now();
    if (this.noMelonSince && now - this.lastDiag < DIAG_EVERY_MS) return;
    if (!this.noMelonSince) this.noMelonSince = now;
    this.lastDiag = now;
    const { x, y, z, r } = this.area;
    const counts = {};
    const all = this.bot.findBlocks({
      point: new Vec3(x, y, z),
      maxDistance: r,
      count: 3000,
      matching: b => !!b && /melon|stem/.test(b.name),
    }) || [];
    for (const p of all) {
      const b = this.bot.blockAt(p);
      const n = b ? b.name : '?';
      counts[n] = (counts[n] || 0) + 1;
    }
    const desc = Object.entries(counts).map(([n, c]) => `${n}: ${c}`).join(', ');
    const pos = this.bot.entity && this.bot.entity.position;
    const dist = pos && Number.isFinite(pos.x) ? pos.distanceTo(new Vec3(x, y, z)).toFixed(0) : 'noma\'lum';
    this.report(`Maydonda pishgan tarvuz topilmadi. Radius ${r} ichida: ${desc || "tarvuz yoki poya yo'q"}. ` +
      `Bot maydondan ${dist === 'noma\'lum' ? "masofasi noma'lum" : dist + ' blok uzoqda'}. Koordinata yoki radiusni tekshiring.`);
  }

  // Qo'lda yaroqli bolta bo'lsin. Sinishga yaqin bo'lsa boshqasiga o'tadi.
  async ensureAxe() {
    const bot = this.bot;
    const axes = bot.inventory.items().filter(isAxe);
    if (!axes.length) throw new FarmStop("inventarda bolta yo'q");

    const usable = axes
      .filter(a => !this.isWorn(a))
      .sort((a, b) => (axeLeft(b) ?? Infinity) - (axeLeft(a) ?? Infinity));
    if (!usable.length) {
      throw new FarmStop(`boltalar sinishga yaqin (chidamlilik ${AXE_MIN_LEFT} dan kam). Yangi bolta qo'shing`);
    }

    const held = bot.heldItem;
    if (!held || !isAxe(held) || this.isWorn(held)) {
      await bot.equip(usable[0], 'hand');
      this.axeUses = 0;
    }
  }

  chestBlock() {
    if (!this.chest) throw new FarmStop("sandiq joyi belgilanmagan (/ferma <id> chest x y z)");
    const pos = new Vec3(this.chest.x, this.chest.y, this.chest.z);
    const block = this.bot.blockAt(pos);
    if (!block || !/chest|barrel/.test(block.name)) {
      throw new FarmStop(`sandiq topilmadi (${pos.x} ${pos.y} ${pos.z})`);
    }
    return block;
  }

  // Bolta yoki ovqat kerak bo'lsa sandiqdan oladi (30 soniyada bir martadan ko'p emas)
  async maybeRestock() {
    if (!this.chest) return;              // sandiq yo'q bo'lsa, ensureAxe aniq xabar beradi
    const bot = this.bot;
    const items = bot.inventory.items();
    const foods = (bot.registry && bot.registry.foodsByName) || {};
    const needAxe = !items.some(a => isAxe(a) && !this.isWorn(a));
    const needFood = !items.some(i => foods[i.name]) && bot.food < FOOD_START;
    if (!needAxe && !needFood) return;
    if (Date.now() - this.lastRestock < 30_000) return;
    this.lastRestock = Date.now();
    await this.restock(needAxe, needFood);
  }

  async restock(needAxe, needFood) {
    const bot = this.bot;
    const block = this.chestBlock();
    await this.goNear(block.position);

    let win;
    try {
      win = await bot.openContainer(block);
    } catch (e) {
      throw new FarmStop(`sandiqni ochib bo'lmadi: ${e.message}`);
    }
    const foods = (bot.registry && bot.registry.foodsByName) || {};
    let gotAxe = false, gotFood = false;
    try {
      for (const item of win.containerItems()) {
        if (needAxe && !gotAxe && isAxe(item) && !this.isWorn(item)) {
          await win.withdraw(item.type, null, item.count);
          gotAxe = true;
        } else if (needFood && !gotFood && foods[item.name]) {
          await win.withdraw(item.type, null, Math.min(item.count, FOOD_KEEP));
          gotFood = true;
        }
      }
    } catch (e) {
      throw new FarmStop(`sandiqdan olishda xato: ${e.message}`);
    } finally {
      try { win.close(); } catch {}
    }
    const got = [gotAxe && 'bolta', gotFood && 'ovqat'].filter(Boolean);
    this.last = got.length ? `sandiqdan olindi: ${got.join(', ')}` : "sandiqda kerakli narsa yo'q";
  }

  async goNear(pos) {
    if (this.bot.entity.position.distanceTo(pos) <= 3.5) return;
    await this.gotoSafe(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
  }

  async deposit() {
    const bot = this.bot;
    const block = this.chestBlock();
    await this.goNear(block.position);
    let win;
    try {
      win = await bot.openContainer(block);
    } catch (e) {
      throw new FarmStop(`sandiqni ochib bo'lmadi: ${e.message}`);
    }

    const foods = (bot.registry && bot.registry.foodsByName) || {};
    const foodKept = {};
    try {
      for (const item of bot.inventory.items()) {
        let n = item.count;
        if (isAxe(item)) {
          if (!this.isWorn(item)) continue;          // yaroqli boltani qoldiramiz
        } else if (foods[item.name]) {
          const keep = Math.max(0, Math.min(n, FOOD_KEEP - (foodKept[item.name] || 0)));
          foodKept[item.name] = (foodKept[item.name] || 0) + keep;
          n -= keep;
          if (n <= 0) continue;
        }
        await win.deposit(item.type, null, n);
      }
    } catch (e) {
      throw new FarmStop(`sandiqqa joylashda xato (ehtimol to'lgan): ${e.message}`);
    } finally {
      try { win.close(); } catch {}
    }
    this.deposits++;
    this.last = 'inventar sandiqqa tashlandi';
  }

  async pickupDrops(center) {
    const bot = this.bot;
    const drops = Object.values(bot.entities)
      .filter(e => e && (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(center) <= 4)
      .slice(0, 6);
    for (const d of drops) {
      if (!this.running) return;
      try {
        await this.gotoSafe(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.5));
      } catch {}
    }
  }

  statusText() {
    const bot = this.bot;
    const held = bot.heldItem && isAxe(bot.heldItem) ? bot.heldItem : null;
    const left = held ? axeLeft(held) : null;
    const axes = bot.inventory.items().filter(isAxe).length;
    return [
      `🌾 Ferma: ${this.running ? 'ISHLAYAPTI ▶️' : "to'xtagan ⏹"}`,
      `📍 Maydon: ${this.area ? `${this.area.x} ${this.area.y} ${this.area.z}, radius ${this.area.r}` : 'belgilanmagan'}`,
      `📦 Sandiq: ${this.chest ? `${this.chest.x} ${this.chest.y} ${this.chest.z}` : 'belgilanmagan'}`,
      `🍉 Yig'ilgan tarvuz: ${this.harvested} ta`,
      `🗄 Sandiqqa tashlash: ${this.deposits} marta`,
      `🪓 Qo'lda: ${held ? held.name + (left !== null ? ` (chidamlilik ${left})` : ` (ishlatilgan ${this.axeUses})`) : "yo'q"}`,
      `🪓 Inventarda boltalar: ${axes} ta`,
      `⚠️ Xatolar: ${this.errCount} ta`,
      `🕒 Ish vaqti: ${this.since ? Math.round((Date.now() - this.since) / 60000) + ' daq' : '-'}`,
      `📝 Oxirgi: ${this.last}`,
    ].join('\n');
  }
}

module.exports = { Farm, startAutoEat, FarmStop, installDigPatch, parseEnchants };
