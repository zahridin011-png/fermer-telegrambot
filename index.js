'use strict';
// =====================================================================
//  Minecraft AFK bot boshqaruvchisi (Mineflayer + Telegram)
//  Ishga tushirish:  TELEGRAM_TOKEN=... node index.js
// =====================================================================
const fs = require('fs');
const path = require('path');
const TelegramBotLib = require('node-telegram-bot-api');
const TelegramBot = typeof TelegramBotLib === 'function' ? TelegramBotLib : TelegramBotLib.default;
if (typeof TelegramBot !== 'function') {
  console.error("❌ node-telegram-bot-api to'g'ri yuklanmadi. Loyiha papkasida ishga tushiring:");
  console.error('   npm install node-telegram-bot-api@0.66.0');
  process.exit(1);
}
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Farm, startAutoEat } = require('./farm');

// ---------------- SOZLAMALAR ----------------
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
const cleanToken = s => String(s || '').trim().replace(/^["']|["']$/g, '').replace(/^bot/i, '').trim();
const TOKEN = cleanToken(process.env.TELEGRAM_TOKEN || '8965474196:AAESPMZZZ4moGoZkZ909ATIO3roWg3U-nCE');
const ADMIN_ID = String(process.env.ADMIN_ID || '8161736033'); // bot egasi: faqat u /adduser qila oladi
const USERS_FILE = path.join(__dirname, 'users.json');
const allowedUsers = new Set([
  ADMIN_ID,
  '5693873756',                                  // qo'shimcha foydalanuvchi
  ...(process.env.ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
]);
const DATA_FILE = path.join(__dirname, 'bots.json');

const DEFAULT_LOGIN_DELAY_S = env('LOGIN_DELAY_SEC', 3);   // serverga kirgach /login gacha (s)
const DEFAULT_CMD_DELAY_S = env('CMD_DELAY_SEC', 15);      // /login dan keyin hub buyruqlarigacha (s)
const CONNECT_GAP_MS = env('CONNECT_GAP_MS', 12_000);      // botlar orasidagi ulanish pauzasi
const CONNECT_TIMEOUT_MS = 60_000;                         // shuncha ichida kirmasa, qayta uriniladi
const CHAT_GAP_MS = env('CHAT_GAP_MS', 1_500);             // Minecraft chat spam limiti
const CHAT_LIMIT = 256;                                    // Minecraft chat xabar uzunligi chegarasi
const REPLY_WINDOW_MS = env('REPLY_WINDOW_MS', 5_000);     // /cmd javobini shuncha vaqt yig'amiz
const RECONNECT_BASE_MS = env('RECONNECT_BASE_MS', 15_000);
const RECONNECT_MAX_MS = 120_000;
const TICK_MS = env('TICK_MS', 10_000);                    // jadval va muddat tekshiruvi oralig'i
const AFK_MOVE_MS = 45_000;
const MIN_AUTO_MS = 30_000;
const DAY = 86_400_000;

// ---------------- TARIFLAR ----------------
const PLANS = {
  w1: { label: '1 haftalik', ms: 7 * DAY },
  w2: { label: '2 haftalik', ms: 14 * DAY },
  m1: { label: '1 oylik', ms: 30 * DAY },
  inf: { label: '♾ Cheksiz', ms: null },
};

const tg = new TelegramBot(TOKEN, { polling: true });

// ---------------- YORDAMCHI ----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d} kun`);
  if (d || h) parts.push(`${h} soat`);
  if (d || h || m) parts.push(`${m} daq`);
  parts.push(`${sec} sek`);
  return parts.join(' ');
}
function humanDur(ms) {
  if (ms % DAY === 0) return `${ms / DAY} kun`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} soat`;
  if (ms % 60_000 === 0) return `${ms / 60_000} daq`;
  return `${Math.round(ms / 1000)} sek`;
}
const fmtDate = ts => new Date(ts).toLocaleString('en-GB', { hour12: false });

// "30s" "10m" "2h" "2d" "1w" -> millisekund
function parseDuration(str) {
  const m = /^(\d+(?:\.\d+)?)([smhdw])$/i.exec(String(str || '').trim());
  if (!m) return null;
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: DAY, w: 7 * DAY }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * unit);
}
function parseHostPort(text) {
  const t = text.trim();
  const i = t.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(t.slice(i + 1))) return { host: t.slice(0, i), port: Number(t.slice(i + 1)) };
  return { host: t, port: 25565 };
}
const validHost = h => /^[a-zA-Z0-9.-]{3,253}$/.test(h);
const validPort = p => Number.isInteger(p) && p > 0 && p < 65536;
const validNick = n => /^\w{3,16}$/.test(n);
const validVersion = v => /^\d+\.\d+(\.\d+)?$/.test(v);
const normCmd = s => { const t = s.trim(); return t.startsWith('/') ? t : '/' + t; };
const isAllowed = id => allowedUsers.has(String(id));
const isAdmin = id => String(id) === ADMIN_ID;
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) for (const id of JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))) allowedUsers.add(String(id));
  } catch (e) { console.error('users.json o\'qishda xato:', e.message); }
}
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify([...allowedUsers], null, 2)); }
  catch (e) { console.error('users.json saqlashda xato:', e.message); }
}

function splitMessage(text, max = 3800) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && (cur + '\n' + line).length > max) { out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}
function send(chatId, text, extra) {
  return tg.sendMessage(chatId, text, extra).catch(e => console.error('Telegram yuborish xatosi:', e.message));
}
async function sendLong(chatId, text) {
  for (const part of splitMessage(text)) await send(chatId, part);
}

// Kick sababini (NBT / JSON chat komponenti) oddiy matnga aylantirish
function collectText(node, out) {
  if (node == null) return out;
  if (Array.isArray(node)) { node.forEach(n => collectText(n, out)); return out; }
  if (typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'text') {
      if (typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object' && v.type === 'string') out.push(String(v.value));
      else collectText(v, out);
    } else if (k === 'value' || k === 'extra' || k === 'with') {
      collectText(v, out);
    }
  }
  return out;
}
function decodeReason(reason, bot) {
  try {
    if (bot && bot.registry) {
      const ChatMessage = require('prismarine-chat')(bot.registry);
      const t = ChatMessage.fromNotch(reason).toString().replace(/§./g, '').trim();
      if (t) return t.slice(0, 400);
    }
  } catch {}
  let data = reason;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return data.replace(/§./g, '').slice(0, 400); }
  }
  const text = collectText(data, []).join('').replace(/§./g, '').trim();
  return (text || JSON.stringify(reason) || "noma'lum sabab").slice(0, 400);
}

// Botlar bir vaqtda emas, navbat bilan ulanadi (IP bloklanishidan saqlash)
let lastConnectAt = 0;
function nextConnectSlot() {
  const t = now();
  const at = Math.max(t, lastConnectAt + CONNECT_GAP_MS);
  lastConnectAt = at;
  return at - t;
}

function plansKeyboard(prefix, id) {
  const cb = k => (id == null ? `${prefix}:${k}` : `${prefix}:${id}:${k}`);
  return [
    [{ text: PLANS.w1.label, callback_data: cb('w1') }, { text: PLANS.w2.label, callback_data: cb('w2') }],
    [{ text: PLANS.m1.label, callback_data: cb('m1') }, { text: PLANS.inf.label, callback_data: cb('inf') }],
  ];
}

// ---------------- BOT SINFI ----------------
class AfkBot {
  constructor(cfg) {
    // saqlanadigan maydonlar
    this.id = cfg.id;
    this.owner = cfg.owner;
    this.host = cfg.host;
    this.port = Number(cfg.port) || 25565;
    this.username = cfg.username;
    this.password = cfg.password;
    this.commands = cfg.commands || [];
    this.version = cfg.version || false;
    this.loginDelay = cfg.loginDelay ?? null;
    this.cmdDelay = cfg.cmdDelay ?? null;
    this.unlimited = cfg.unlimited ?? true;      // muddat maydoni yo'q eski botlar cheksiz hisoblanadi
    this.expiresAt = cfg.expiresAt ?? null;
    this.jobs = cfg.jobs || [];                  // [{kind:'once', cmd, runAt} | {kind:'auto', cmd, everyMs, nextAt}]
    this.nextJobId = cfg.nextJobId || (Math.max(0, ...this.jobs.map(j => j.id || 0)) + 1);
    this.farmCfg = cfg.farm || { area: null, chest: null };   // ferma maydoni va sandiqi

    // ish vaqtidagi holat (saqlanmaydi)
    this.bot = null;
    this.stopped = true;
    this.online = false;
    this.loginSent = false;
    this.status = "to'xtagan";
    this.connectedAt = null;
    this.startedAt = null;
    this.reconnects = 0;
    this.fails = 0;
    this.lastError = '-';
    this.chatLog = [];
    this.captures = [];
    this.queue = [];
    this.queueBusy = false;
    this.epoch = 0;
    this.warned = false;
    this.expiredStop = false;
    this.antiAfk = null;
    this.farm = null;
    this.farmWanted = false;   // foydalanuvchi fermani yoqqanmi (ulanish tiklanganda qayta yoqish uchun)
    this.t = {};
  }

  toJSON() {
    return {
      id: this.id, owner: this.owner, host: this.host, port: this.port,
      username: this.username, password: this.password, commands: this.commands,
      version: this.version, loginDelay: this.loginDelay, cmdDelay: this.cmdDelay,
      unlimited: this.unlimited, expiresAt: this.expiresAt, jobs: this.jobs, nextJobId: this.nextJobId,
      farm: this.farmCfg,
    };
  }

  // ---------- taymerlar ----------
  setT(name, fn, ms) {
    clearTimeout(this.t[name]);
    this.t[name] = setTimeout(() => { this.t[name] = null; fn(); }, ms);
  }
  clearT(name) { clearTimeout(this.t[name]); this.t[name] = null; }
  clearAllT() { for (const k of Object.keys(this.t)) this.clearT(k); }

  // ---------- holat ----------
  setStatus(s) { this.status = s; }
  icon() {
    if (this.isExpired()) return '⏳';
    if (this.stopped) return '⚫';
    if (this.online) return '🟢';
    return '🟡';
  }
  notify(text, extra) { send(this.owner, `[#${this.id} ${this.username}] ${text}`, extra); }
  loginSec() { return this.loginDelay ?? DEFAULT_LOGIN_DELAY_S; }
  cmdSec() { return this.cmdDelay ?? DEFAULT_CMD_DELAY_S; }

  // ---------- muddat ----------
  isExpired() { return !this.unlimited && (this.expiresAt == null || now() >= this.expiresAt); }

  remainingText() {
    if (this.unlimited) return '♾ Cheksiz';
    if (this.expiresAt == null) return 'Muddat berilmagan';
    if (this.isExpired()) return `Tugagan (${fmtDate(this.expiresAt)})`;
    return `${fmtDur(this.expiresAt - now())} qoldi (${fmtDate(this.expiresAt)} gacha)`;
  }

  applyPlan(key) {
    const plan = PLANS[key];
    if (!plan) return false;
    if (plan.ms == null) {
      this.unlimited = true;
      this.expiresAt = null;
    } else {
      const base = this.unlimited ? now() : Math.max(now(), this.expiresAt || 0);
      this.unlimited = false;
      this.expiresAt = base + plan.ms;
    }
    this.afterTimeChange();
    return true;
  }

  adjustTime(deltaMs) {
    let base = this.unlimited ? now() : (this.expiresAt || now());
    if (deltaMs > 0 && base < now()) base = now(); // tugagan muddatga hozirdan qo'shiladi
    this.unlimited = false;
    this.expiresAt = base + deltaMs;
    this.afterTimeChange();
  }

  endNow() {
    this.unlimited = false;
    this.expiresAt = now();
    this.afterTimeChange();
  }

  afterTimeChange() {
    this.warned = false;
    saveAll();
    if (!this.stopped && this.isExpired()) return this.expire();
    if (this.expiredStop && !this.isExpired()) {
      // muddat tugagani uchun to'xtagan bot, vaqt berilsa o'zi qayta yonadi
      this.expiredStop = false;
      this.start();
      this.notify('▶️ Muddat uzaytirildi, bot qayta ishga tushdi.');
    }
  }

  expire() {
    this.stop();
    this.expiredStop = true;
    this.setStatus('muddat tugagan');
    this.notify("⏳ Muddat tugadi, bot to'xtatildi.\nQayta yoqish uchun tarif tanlang:", {
      reply_markup: { inline_keyboard: plansKeyboard('plan', this.id) },
    });
  }

  // ---------- hayot sikli ----------
  start() {
    if (this.isExpired()) { this.expire(); return false; }
    if (!this.stopped) return true;
    this.stopped = false;
    this.startedAt = now();
    this.fails = 0;
    this.expiredStop = false;
    this.queueConnect();
    return true;
  }

  stop() {
    this.stopped = true;
    this.farmWanted = false;
    this.cleanupConn();
    this.setStatus("to'xtagan");
  }

  queueConnect() {
    if (this.stopped) return;
    const wait = nextConnectSlot();
    this.setStatus(wait > 1000 ? 'navbatda' : 'ulanmoqda');
    this.setT('conn', () => this.connectNow(), wait);
  }

  connectNow() {
    if (this.stopped) return;
    if (this.isExpired()) return this.expire();
    if (this.bot) return;
    this.lastError = '-';
    this.loginSent = false;
    this.online = false;
    this.setStatus('ulanmoqda');

    let bot;
    try {
      bot = mineflayer.createBot({
        host: this.host,
        port: this.port,
        username: this.username,
        version: this.version || false,
        auth: 'offline',
        checkTimeoutInterval: 90_000,
        hideErrors: true,   // protokol xatolarining to'liq stack'ini chiqarmaydi (xabar 'error' hodisasida baribir keladi)
      });
    } catch (e) {
      this.lastError = e.message;
      return this.scheduleReconnect(e.message);
    }
    this.bot = bot;
    try { bot.loadPlugin(pathfinder); } catch {}
    bot._stopEat = startAutoEat(bot);

    this.setT('connTimeout', () => {
      if (this.bot === bot && !this.connectedAt) {
        this.lastError = 'ulanish vaqti tugadi';
        try { bot.quit('timeout'); } catch {}
      }
    }, CONNECT_TIMEOUT_MS);

    bot.once('login', () => this.onLogin(bot));
    bot.on('messagestr', m => this.onChat(bot, m));
    bot.on('kicked', r => {
      this.lastError = decodeReason(r, bot);
      this.notify(`Serverdan chiqarildi ❌\nSabab: ${this.lastError}`);
    });
    bot.on('death', () => {
      this.notify("O'ldi ☠️");
      setTimeout(() => { try { if (this.bot === bot && typeof bot.respawn === 'function') bot.respawn(); } catch {} }, 1500);
    });
    bot.on('error', e => {
      this.lastError = e.message;
      console.error(`[#${this.id}] xato:`, e.message);
    });
    bot.on('end', reason => this.onEnd(bot, reason));
  }

  // Sozlangan versiya serverdagisiga mos kelmasa, ogohlantiradi
  checkServerVersion() {
    if (!this.version || this.versionChecked) return;
    this.versionChecked = true;
    try {
      const { ping } = require('minecraft-protocol');
      ping({ host: this.host, port: this.port, closeTimeout: 5000 }).then(r => {
        const sv = r && r.version && r.version.name;
        if (sv && sv !== this.version) {
          this.notify(`⚠️ Sozlangan versiya ${this.version}, server esa ${sv} deydi. Mos kelmasa buyumlar va sindirish xato ishlaydi.\n` +
            `Tavsiya: /version ${this.id} auto (keyin 🔄 Restart)`);
        }
      }).catch(() => {});
    } catch {}
  }

  onLogin(bot) {
    if (this.bot !== bot) return;
    this.clearT('connTimeout');
    this.connectedAt = now();
    this.setStatus('serverda (login kutilmoqda)');
    this.notify(`Serverga kirdi ✅ ${this.loginSec()}s dan keyin /login yuboriladi.`);
    this.setT('login', () => this.doLogin(bot), this.loginSec() * 1000);
  }

  doLogin(bot) {
    if (this.bot !== bot || this.loginSent) return;
    this.loginSent = true;
    try { bot.chat(`/login ${this.password}`); } catch (e) { this.lastError = e.message; }
    this.setStatus('login yuborildi');
    this.notify('/login yuborildi.');
    this.setT('cmd', () => this.onReady(bot), this.cmdSec() * 1000);
  }

  onReady(bot) {
    if (this.bot !== bot) return;
    this.online = true;
    this.fails = 0;
    this.setStatus('ishlayapti (AFK)');
    this.startAntiAfk(bot);
    this.notify(this.commands.length
      ? `🟢 Hub buyruqlari navbatga qo'yildi (${this.commands.length} ta).`
      : '🟢 AFK rejimda ishlayapti.');
    for (const c of this.commands) this.queue.push({ text: c, onSent: null });
    this.processQueue();
    if (this.farmWanted && this.farmCfg.area) {
      const r = this.startFarm();
      if (r.ok) this.notify('🌾 Ferma ulanish tiklangach avtomatik qayta yoqildi.');
    }
  }

  onChat(bot, raw) {
    if (this.bot !== bot) return;
    const line = String(raw || '').replace(/§./g, '').trim();
    if (!line) return;
    this.chatLog.push(line.slice(0, 200));
    if (this.chatLog.length > 15) this.chatLog.shift();
    for (const c of this.captures) c.lines.push(line.slice(0, 300));
  }

  onEnd(bot, reason) {
    if (this.bot !== bot) return;
    const err = this.lastError !== '-' ? this.lastError : String(reason || "noma'lum");
    this.cleanupConn();
    if (this.stopped) return;
    if (this.isExpired()) return this.expire();
    this.scheduleReconnect(err);
  }

  scheduleReconnect(err) {
    if (this.stopped) return;
    this.reconnects++;
    this.fails++;
    // Ko'p marta ketma-ket uzilsa, server IP ni bloklashi mumkin: uzoqroq kutamiz
    const long = this.fails >= 5;
    const wait = long ? 10 * 60_000 : Math.min(RECONNECT_BASE_MS * this.fails, RECONNECT_MAX_MS);
    this.setStatus(`qayta ulanadi (${Math.round(wait / 1000)}s)`);
    this.notify(`Aloqa uzildi ❌ (${err}).\n${Math.round(wait / 1000)}s dan keyin qayta ulanadi.` +
      (long ? "\n⚠️ Ketma-ket 5 marta uzildi: server IP ni vaqtincha bloklagan bo'lishi mumkin, shu sababli 10 daqiqa kutiladi." : ''));
    this.setT('reconnect', () => this.queueConnect(), wait);
  }

  cleanupConn() {
    this.clearAllT();
    if (this.antiAfk) clearInterval(this.antiAfk);
    this.antiAfk = null;
    this.epoch++;
    this.online = false;
    this.loginSent = false;
    this.connectedAt = null;
    this.queue = [];
    this.queueBusy = false;
    this.captures = [];
    const b = this.bot;
    this.bot = null;
    if (this.farm) this.farm.stop("bot uzildi yoki to'xtatildi");
    if (b && b._stopEat) b._stopEat();
    if (b) {
      try { b.removeAllListeners(); b.on('error', () => {}); b.quit(); } catch {}
    }
  }

  startAntiAfk(bot) {
    this.antiAfk = setInterval(() => {
      if (this.bot !== bot || !bot.entity) return;
      try {
        bot.look(Math.random() * Math.PI * 2, 0, true);
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch {} }, 300);
      } catch {}
    }, AFK_MOVE_MS);
  }

  // ---------- chat navbati ----------
  enqueue(text, onSent) {
    this.queue.push({ text, onSent: onSent || null });
    this.processQueue();
  }

  processQueue() {
    if (this.queueBusy || !this.online || !this.bot || !this.queue.length) return;
    const item = this.queue.shift();
    this.queueBusy = true;
    try { this.bot.chat(item.text); } catch (e) { this.lastError = e.message; }
    if (item.onSent) item.onSent();
    const ep = this.epoch;
    setTimeout(() => {
      if (ep !== this.epoch) return;
      this.queueBusy = false;
      this.processQueue();
    }, CHAT_GAP_MS);
  }

  // Telegramdan kelgan buyruq/matn. "/" bilan boshlansa, server javobini yig'ib qaytaramiz
  sendText(text, chatId) {
    if (!this.online || !this.bot) {
      return { ok: false, msg: "Bot serverda emas. Avval ▶️ Start bosing va login bo'lishini kuting." };
    }
    if (text.length > CHAT_LIMIT) return { ok: false, msg: `Juda uzun: ${text.length}/${CHAT_LIMIT} belgi.` };
    const isCmd = text.startsWith('/');
    this.enqueue(text, isCmd && chatId ? () => this.startCapture(chatId, text) : null);
    return { ok: true, msg: `📤 Navbatga qo'yildi: ${text}` };
  }

  startCapture(chatId, text) {
    const cap = { lines: [] };
    this.captures.push(cap);
    setTimeout(() => {
      this.captures = this.captures.filter(c => c !== cap);
      const body = cap.lines.length ? cap.lines.slice(-8).join('\n') : '(server javob bermadi)';
      send(chatId, `↩️ #${this.id} javobi (${text}):\n${body}`);
    }, REPLY_WINDOW_MS);
  }

  // ---------- jadval (rejalar) ----------
  addJob(job) {
    job.id = this.nextJobId++;
    this.jobs.push(job);
    saveAll();
  }

  removeJobByNumber(n) {
    if (!Number.isInteger(n) || n < 1 || n > this.jobs.length) return false;
    this.jobs.splice(n - 1, 1);
    saveAll();
    return true;
  }

  describeJob(j) {
    return j.kind === 'once'
      ? `bir marta, ${fmtDate(j.runAt)} da → ${j.cmd}`
      : `har ${humanDur(j.everyMs)}da → ${j.cmd}`;
  }

  runDueJobs() {
    if (this.stopped || !this.jobs.length) return;
    const t = now();
    let changed = false;
    for (const job of [...this.jobs]) {
      if (job.kind === 'once') {
        if (t < job.runAt || !this.online) continue; // bot onlayn bo'lguncha kutadi
        this.enqueue(job.cmd);
        this.notify(`⏰ Rejalashtirilgan buyruq yuborildi: ${job.cmd}`);
        this.jobs = this.jobs.filter(j => j !== job);
        changed = true;
      } else if (t >= job.nextAt) {
        job.nextAt = t + job.everyMs;
        changed = true;
        if (this.online) {
          this.enqueue(job.cmd);
          this.notify(`🔁 Jadval buyrug'i yuborildi: ${job.cmd}`);
        } else {
          this.notify(`⚠️ Jadval o'tkazib yuborildi (bot offline): ${job.cmd}`);
        }
      }
    }
    if (changed) saveAll();
  }

  // ---------- ferma ----------
  startFarm() {
    if (!this.online || !this.bot) return { ok: false, msg: "Bot serverda emas. Avval ▶️ Start bosing va login bo'lishini kuting." };
    if (this.farm && this.farm.running) return { ok: false, msg: 'Ferma allaqachon ishlayapti' };
    this.farm = new Farm(this.bot, this.farmCfg, {
      notify: t => this.notify(t),
      reconnect: () => this.forceReconnect(),
      onFarmStop: () => { this.farmWanted = false; },
    });
    const r = this.farm.start();
    if (r.ok) this.farmWanted = true;
    return r;
  }

  stopFarm() {
    this.farmWanted = false;
    if (this.farm) this.farm.stop("qo'lda to'xtatildi");
  }

  // Bot pozitsiyasi buzilganda: ulanishni uzib, onEnd orqali avtomatik qayta ulanadi
  forceReconnect() {
    if (this.bot) { try { this.bot.quit('ferma: pozitsiya buzildi'); } catch {} }
  }

  farmStatusText() {
    if (this.farm && this.online && this.bot) return this.farm.statusText();
    const a = this.farmCfg.area, c = this.farmCfg.chest;
    return [
      "🌾 Ferma: to'xtagan ⏹",
      `📍 Maydon: ${a ? `${a.x} ${a.y} ${a.z}, radius ${a.r}` : 'belgilanmagan'}`,
      `📦 Sandiq: ${c ? `${c.x} ${c.y} ${c.z}` : 'belgilanmagan'}`,
      this.online ? '' : "ℹ️ Statistika bot serverda bo'lganda ko'rinadi.",
    ].filter(Boolean).join('\n');
  }

  // ---------- holat matni ----------
  statusText() {
    const ver = this.bot && this.bot.version ? ` → ${this.bot.version}` : '';
    const lines = [
      `${this.icon()} #${this.id}  ${this.username}`,
      `🌐 Server: ${this.host}:${this.port}  (versiya: ${this.version || 'avto'}${ver})`,
      `📡 Holat: ${this.status}`,
      `⏳ Muddat: ${this.remainingText()}`,
    ];
    if (this.connectedAt && !this.stopped) lines.push(`⏱ Serverda: ${fmtDur(now() - this.connectedAt)}`);
    lines.push(`🔁 Qayta ulanishlar: ${this.reconnects}`);
    lines.push(`⚙️ Login: ${this.loginSec()}s, birinchi buyruq: ${this.cmdSec()}s keyin`);
    lines.push(`📜 Hub buyruqlari: ${this.commands.length ? this.commands.join(' | ') : "yo'q"}`);
    lines.push(`🗓 Rejalar: ${this.jobs.length ? this.jobs.length + ' ta (/jobs ' + this.id + ')' : "yo'q"}`);
    if (this.farmCfg.area) lines.push(`🌾 Ferma: ${this.farm && this.farm.running ? 'ishlayapti' : "to'xtagan"}`);
    lines.push(`⚠️ Oxirgi xato: ${this.lastError}`);
    if (this.chatLog.length) lines.push(`\n💬 Oxirgi chat:\n${this.chatLog.slice(-5).join('\n')}`);
    return lines.join('\n');
  }
}

// ---------------- BOTLAR REESTRI VA SAQLASH ----------------
const bots = new Map(); // id -> AfkBot
let nextBotId = 1;

function saveAll() {
  const data = { nextId: nextBotId, bots: [...bots.values()].map(b => b.toJSON()) };
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('Saqlashda xato:', e.message); }
}

function loadAll() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.bots || []);
    for (const cfg of arr) {
      const b = new AfkBot(cfg);
      bots.set(b.id, b);
    }
    nextBotId = Math.max(1, raw.nextId || 1, ...[...bots.keys()].map(i => i + 1));
    console.log(`${arr.length} ta bot yuklandi (to'xtagan holatda). /bots orqali ishga tushiring.`);
    if (process.env.AUTOSTART === '1') for (const b of bots.values()) b.start();
  } catch (e) { console.error("bots.json o'qishda xato:", e.message); }
}

function myBots(chatId) { return [...bots.values()].filter(b => String(b.owner) === String(chatId)); }
function getMine(chatId, idStr) {
  const b = bots.get(Number(idStr));
  return b && String(b.owner) === String(chatId) ? b : null;
}

// ---------------- QO'LLANMA (/start va /help) ----------------
const GUIDE = `📘 QO'LLANMA — Minecraft AFK bot boshqaruvi

1) BU BOT NIMA QILADI?
• Minecraft serverga oddiy o'yinchi kabi kiradi.
• O'zi /login parol yuboradi.
• Kerak bo'lsa hub buyruqlarini (masalan /server anarxiya) ketma-ket yuboradi.
• Keyin AFK turadi: anti-AFK harakat qiladi, server uni chiqarib yubormaydi.
• Har bot alohida ishlaydi. Har biriga raqam (ID) beriladi: 1, 2, 3...

2) YANGI BOT QO'SHISH — /start
Bot ketma-ket so'raydi:
1. Server manzili: ip yoki domen, port bilan. Masalan: play.example.uz:25565
2. Bot nik: 3–16 belgi (harf, raqam, _)
3. Parol: bot /login parol yuboradi. Parol xabari o'chiriladi.
4. Minecraft versiyasi: 1.21.1 kabi. Bilmasangiz - yuboring.
5. Hub buyruqlari: kirgach yuboriladigan buyruqlar, har birini yangi qatorga. Yo'q bo'lsa - yuboring.
6. Tarif: 1 haftalik, 2 haftalik, 1 oylik yoki cheksiz.

Bot ishga tushgach ketma-ketlik:
serverga kiradi → 3s kutadi (/logindelay) → /login → 15s kutadi (/cmddelay) → hub buyruqlari → AFK

3) HOLAT BELGILARI
⚫ to'xtagan   🟡 navbatda / ulanmoqda   🟢 serverda ishlayapti   ⏳ muddat tugagan

4) BOTNI BOSHQARISH
/bots — botlar menyusi. Botni tanlasangiz tugmalar chiqadi: Start, Stop, Restart, Holat, Buyruq, Jadval, Muddat, O'chirish.
/run <id> — botni ishga tushirish
/stop <id> — botni to'xtatish
/restart <id> — qayta ishga tushirish
/status [id] — to'liq holat (id bersangiz bittasi, bermasangiz hammasi)
/remove <id> — botni butunlay o'chirish

5) BUYRUQ YUBORISH
/cmd <id> <buyruq> — serverda buyruq bajarish. Javob 5 soniyadan keyin shu chatga keladi.
   Misol: /cmd 5 /tpa Nick
/say <id> <matn> — chatga oddiy matn yozish.
   Misol: /say 5 salom

6) REJALASHTIRISH (VAQT BILAN)
/delay <id> <vaqt> <buyruq> — faqat bir marta, shu vaqt o'tgach yuboradi.
   Misol: /delay 5 2d /server anarxiya
/auto <id> <vaqt> <buyruq> — har <vaqt>da takrorlaydi (kamida 30s).
   Misol: /auto 5 3d /home home
/jobs <id> — rejalar ro'yxati
/jobdel <id> <raqam> — rejani o'chirish. Misol: /jobdel 5 1

Vaqt formati: 30s = 30 soniya, 10m = 10 daqiqa, 2h = 2 soat, 2d = 2 kun, 1w = 1 hafta.

7) MUDDAT (TARIF)
/muddat <id> — muddatni ko'rish va tarif tanlash
/muddat <id> +3d — 3 kun qo'shish
/muddat <id> -1d — 1 kun kamaytirish
/muddat <id> +12h — 12 soat qo'shish
/muddat <id> cheksiz — cheksiz qilish
/muddat <id> 0 — darrov tugatish
Muddat tugagach bot o'zi to'xtaydi va Telegramga xabar keladi. Tugashidan 1 kun oldin ogohlantiradi.

8) SOZLAMALAR
/logindelay <id> <soniya> — serverga kirgach /login gacha kutish (standart 3s)
/cmddelay <id> <soniya> — /login dan keyin hub buyruqlarigacha kutish (standart 15s)
/version <id> <versiya|auto> — Minecraft versiyasi. Masalan: /version 5 1.21.1
/cancel — joriy so'rovni bekor qilish

9) MINECRAFT BUYRUQLARI MISOLLARI
/tpa Nick — Nick ga teleportatsiya so'rovi
/pay Nick 100 — Nick ga 100 pul
/home home — "home" uyiga o'tish
/sethome home — joriy joyni uy sifatida saqlash
/warp spawn — "spawn" warpiga o'tish
/spawn — spawnga qaytish
/msg Nick salom — shaxsiy xabar
Qaysi buyruq ishlashi serverga bog'liq. Server tanimasa, javobda "Unknown command" kabi xabar chiqadi va u /cmd javobida ko'rinadi.

10) NIMA BO'LADI?
• Bot offline bo'lsa, /cmd rad etiladi. /delay bot onlayn bo'lgach yuboriladi. /auto o'sha paytda o'tkazib yuboriladi.
• Server uzilsa, bot o'zi qayta ulanadi: 15s, 30s, 45s... 2 daqiqagacha.
• Buyruqlar orasida 1.5s pauza bor. Chat xabari 256 belgidan oshmasligi kerak.
• Bir IP dan juda tez ko'p bot kirsa, server bloklashi mumkin. Botlar orasida 12s pauza bor.

11) MUHIM ESLATMALAR
• Parol va bot ma'lumotlari bots.json faylida ochiq saqlanadi. Faylni hech kimga bermang.
• Server "ma'lumotlar tekshirilmoqda" desa: /cmddelay ni oshiring.
• Server "belgilangan vaqt ichida kira olmadingiz" desa: /logindelay ni kamaytiring.

12) FOYDALANUVCHILAR
Har bir odam o'z Telegram ID si bilan ishlatadi. Har kim faqat o'z botlarini ko'radi.
/myid — o'z Telegram ID ingizni ko'rsatadi (hamma uchun ishlaydi)
/adduser <id> — foydalanuvchi qo'shish (faqat admin)
/removeuser <id> — foydalanuvchini o'chirish, uning botlari to'xtatiladi (faqat admin)
/users — ruxsatli foydalanuvchilar ro'yxati (faqat admin)

13) TARVUZ FERMASI
Bot pishgan tarvuzni baltada yig'adi, ferma maydonini o'zi topadi.
/ferma <id> area x y z [r] — ferma markazi va radiusi (standart 20). Yoki: /ferma <id> area here [r] (bot turgan joy)
/ferma <id> chest x y z — tarvuzlar tashlanadigan sandiq koordinatalari
/ferma <id> start — fermani boshlash
/ferma <id> stop — to'xtatish
/ferma <id> status — yig'ilgan tarvuz, bolta chidamliligi, oxirgi harakat
Bot ochsa o'zi ovqatlanadi. Inventar to'lsa sandiqqa tashlaydi (har xil ovqatdan 16 tasi qoladi).
Bolta yoki ovqat tugasa sandiqdan o'zi oladi, shuning uchun sandiqqa oldindan yaroqli bolta va ovqat qo'ying.
Bolta sinishga yaqin bo'lsa boshqasiga o'tadi, yo'q bo'lsa fermani to'xtatib xabar beradi.
Eslatma: ferma faqat pishgan tarvuzni yig'adi, ekmaydi. Server qoidalarida avtomatlashtirish ruxsat etilganini tekshiring.

• Bu qo'llanmani qayta ko'rish uchun: /help`;

// ---------------- TELEGRAM: MENYU MATNLARI ----------------
function listText(chatId) {
  const list = myBots(chatId);
  if (!list.length) return "Hali bot yo'q. ➕ Yangi bot tugmasini bosing yoki /start yozing.";
  return `🤖 Botlaringiz (${list.length} ta)\n⚫ to'xtagan  🟡 navbatda/ulanmoqda  🟢 serverda  ⏳ muddat tugagan\n\nBirini tanlang:`;
}
function listKeyboard(chatId) {
  const rows = myBots(chatId).map(b => [{ text: `${b.icon()} #${b.id} ${b.username} → ${b.host}`, callback_data: `sel:${b.id}` }]);
  rows.push([{ text: '➕ Yangi bot', callback_data: 'new' }]);
  return { inline_keyboard: rows };
}
function botKeyboard(b) {
  return {
    inline_keyboard: [
      [{ text: '▶️ Start', callback_data: `start:${b.id}` }, { text: '⏹ Stop', callback_data: `stop:${b.id}` }],
      [{ text: '🔄 Restart', callback_data: `restart:${b.id}` }, { text: '📊 Holat', callback_data: `sel:${b.id}` }],
      [{ text: '⌨️ Buyruq', callback_data: `cmdbtn:${b.id}` }, { text: '🗓 Rejalar', callback_data: `jobs:${b.id}` }],
      [{ text: '⏳ Muddat', callback_data: `muddat:${b.id}` }, { text: "🗑 O'chirish", callback_data: `del:${b.id}` }],
      [{ text: '🌾 Ferma', callback_data: `farm:${b.id}` }],
      [{ text: '⬅️ Orqaga', callback_data: 'back' }],
    ],
  };
}
function farmKeyboard(b) {
  return { inline_keyboard: [
    [{ text: '▶️ Ferma start', callback_data: `farmstart:${b.id}` }, { text: '⏹ Ferma stop', callback_data: `farmstop:${b.id}` }],
    [{ text: '🔄 Yangilash', callback_data: `farm:${b.id}` }],
    [{ text: '⬅️ Orqaga', callback_data: `sel:${b.id}` }],
  ] };
}
function botCard(b) {
  return `${b.statusText()}\n\n🕒 Yangilandi: ${new Date().toLocaleTimeString('en-GB')}`;
}
function jobsText(b) {
  if (!b.jobs.length) {
    return `🗓 #${b.id} ${b.username}: rejalashtirilgan buyruq yo'q.\n\n` +
      `Qo'shish:\n/delay ${b.id} 2d /server anarxiya\n/auto ${b.id} 3d /home home`;
  }
  return `🗓 #${b.id} ${b.username} rejalari:\n` +
    b.jobs.map((j, i) => `${i + 1}) ${b.describeJob(j)}`).join('\n') +
    `\n\nO'chirish uchun tugmani bosing.`;
}
function jobsKeyboard(b) {
  const rows = b.jobs.map((j, i) => [{ text: `❌ ${i + 1}) ${j.cmd.slice(0, 30)}`, callback_data: `jobdel:${b.id}:${i + 1}` }]);
  rows.push([{ text: '⬅️ Orqaga', callback_data: `sel:${b.id}` }]);
  return { inline_keyboard: rows };
}
function muddatText(b) {
  return `⏳ #${b.id} ${b.username}\nMuddat: ${b.remainingText()}\n\nTarif tanlang (mavjud muddatga qo'shiladi):`;
}
function muddatKeyboard(b) {
  return {
    inline_keyboard: [
      ...plansKeyboard('plan', b.id),
      [{ text: '⛔ Darrov tugatish', callback_data: `endnow:${b.id}` }],
      [{ text: '⬅️ Orqaga', callback_data: `sel:${b.id}` }],
    ],
  };
}
function newBotDone(b) {
  return `✅ Bot #${b.id} ishga tushdi!\n` +
    `Server: ${b.host}:${b.port}\nNik: ${b.username}\n` +
    `⏳ Muddat: ${b.remainingText()}\n` +
    `Ketma-ketlik: ${b.loginSec()}s → /login → ${b.cmdSec()}s → hub buyruqlari → AFK\n\n` +
    `Holat: /status ${b.id}   Boshqarish: /bots   Qo'llanma: /help`;
}

// ---------------- YANGI BOT (QADAMMA-QADAM) ----------------
const flows = new Map(); // chatId -> { step, data, botId? }

function startFlow(chatId) {
  flows.set(chatId, { step: 'ip', data: {} });
  send(chatId, "🌐 1/6 — Server manzilini yozing (ip yoki domen, port bilan)\nMasalan: play.example.uz:25565\n\nBekor qilish: /cancel");
}

function createBotFromFlow(chatId, data, planKey) {
  const b = new AfkBot({ id: nextBotId++, owner: chatId, ...data, unlimited: true, expiresAt: null });
  bots.set(b.id, b);
  b.applyPlan(planKey);
  b.start();
  saveAll();
  return b;
}

async function handleFlow(msg, text) {
  const chatId = msg.chat.id;
  const flow = flows.get(chatId);
  if (!flow) return false;

  switch (flow.step) {
    case 'ip': {
      const { host, port } = parseHostPort(text);
      if (!validHost(host) || !validPort(port)) {
        send(chatId, "❌ Manzil noto'g'ri. Masalan: play.example.uz:25565");
        return true;
      }
      Object.assign(flow.data, { host, port });
      flow.step = 'nick';
      send(chatId, '👤 2/6 — Bot nikini yozing (3–16 belgi: harf, raqam, _)');
      return true;
    }
    case 'nick': {
      if (!validNick(text)) { send(chatId, "❌ Nik noto'g'ri. 3–16 belgi: harf, raqam yoki _"); return true; }
      flow.data.username = text;
      flow.step = 'pass';
      send(chatId, '🔑 3/6 — Parolni yozing (bot /login parol yuboradi). Parol xabari o\'chiriladi.');
      return true;
    }
    case 'pass': {
      const pass = text.replace(/^\/?login\s+/i, '').trim();
      if (!pass) { send(chatId, 'Parol bo\'sh bo\'lmasin.'); return true; }
      flow.data.password = pass;
      flow.step = 'version';
      tg.deleteMessage(chatId, msg.message_id).catch(() => {});
      send(chatId, '🎮 4/6 — Minecraft versiyasi (masalan 1.21.11). Bilmasangiz yoki server yangi bo\'lsa: - (avtomatik aniqlanadi, tavsiya etiladi)');
      return true;
    }
    case 'version': {
      if (text === '-') flow.data.version = false;
      else if (validVersion(text)) flow.data.version = text;
      else { send(chatId, '❌ Versiya formati: 1.21.1 yoki -'); return true; }
      flow.step = 'cmds';
      send(chatId, "📜 5/6 — Kirgach yuboriladigan hub buyruqlari, har birini yangi qatorga yozing.\nMasalan:\n/server anarxiya\nYo'q bo'lsa: -");
      return true;
    }
    case 'cmds': {
      const cmds = text === '-' ? [] : text.split('\n').map(s => s.trim()).filter(Boolean).map(normCmd);
      if (cmds.some(c => c.length > CHAT_LIMIT)) { send(chatId, `❌ Buyruq juda uzun (${CHAT_LIMIT} belgi chegarasi).`); return true; }
      flow.data.commands = cmds;
      flow.step = 'plan';
      send(chatId, "⏳ 6/6 — Tarifni tanlang. Muddat tugagach bot o'zi to'xtaydi:", {
        reply_markup: { inline_keyboard: plansKeyboard('fplan', null) },
      });
      return true;
    }
    case 'plan':
      send(chatId, 'Iltimos, yuqoridagi tugmalardan birini bosing (yoki /cancel).');
      return true;
    case 'botcmd': {
      flows.delete(chatId);
      const b = bots.get(flow.botId);
      if (!b || String(b.owner) !== String(chatId)) { send(chatId, 'Bot topilmadi.'); return true; }
      const r = b.sendText(text.startsWith('/') ? text : normCmd(text), chatId);
      send(chatId, r.ok ? r.msg : `❌ ${r.msg}`);
      return true;
    }
  }
  return false;
}

// ---------------- BUYRUQLAR ----------------
const COMMANDS = {};
const reg = (names, fn) => names.forEach(n => { COMMANDS[n] = fn; });

// id bilan ishlaydigan buyruqlar uchun o'ram
function withBot(usage, fn) {
  return (msg, args) => {
    const chatId = msg.chat.id;
    const m = /^(\d+)\s*([\s\S]*)$/.exec(args || '');
    if (!m) return send(chatId, usage);
    const b = getMine(chatId, m[1]);
    if (!b) return send(chatId, 'Bunday bot topilmadi.');
    return fn(msg, b, m[2].trim());
  };
}

reg(['/start', '/add'], async msg => { await sendLong(msg.chat.id, GUIDE); startFlow(msg.chat.id); });
reg(['/help'], msg => sendLong(msg.chat.id, GUIDE));
reg(['/cancel'], msg => { flows.delete(msg.chat.id); send(msg.chat.id, 'Bekor qilindi.'); });
reg(['/adduser'], (msg, args) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return send(chatId, "⛔ Faqat admin foydalanuvchi qo'sha oladi.");
  const id = args.trim();
  if (!/^\d{5,15}$/.test(id)) return send(chatId, 'Format: /adduser <telegram_id>\nMasalan: /adduser 5693873756');
  if (allowedUsers.has(id)) return send(chatId, "Bu foydalanuvchi allaqachon qo'shilgan.");
  allowedUsers.add(id);
  saveUsers();
  send(chatId, `✅ ${id} qo'shildi. U endi botdan foydalana oladi.\nU xabar ololmasa, botga /start yozsin.`);
  send(id, "✅ Sizga ruxsat berildi. Boshlash uchun /start yozing, qo'llanma: /help");
});

reg(['/removeuser'], (msg, args) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return send(chatId, "⛔ Faqat admin foydalanuvchini o'chira oladi.");
  const id = args.trim();
  if (!id) return send(chatId, 'Format: /removeuser <telegram_id>');
  if (id === ADMIN_ID) return send(chatId, "Adminni o'chirib bo'lmaydi.");
  if (!allowedUsers.has(id)) return send(chatId, 'Bunday foydalanuvchi yo\'q.');
  allowedUsers.delete(id);
  saveUsers();
  let n = 0;
  for (const b of bots.values()) if (String(b.owner) === id) { b.stop(); n++; }
  send(chatId, `🗑 ${id} o'chirildi. Uning ${n} ta boti to'xtatildi.`);
});

reg(['/users'], msg => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return send(chatId, "⛔ Faqat admin ko'ra oladi.");
  const lines = [...allowedUsers].map(id => {
    const count = [...bots.values()].filter(b => String(b.owner) === id).length;
    return `• ${id}${id === ADMIN_ID ? ' (admin)' : ''} — ${count} ta bot`;
  });
  send(chatId, `👥 Ruxsatli foydalanuvchilar (${allowedUsers.size} ta):\n` + lines.join('\n'));
});

reg(['/bots'], msg => send(msg.chat.id, listText(msg.chat.id), { reply_markup: listKeyboard(msg.chat.id) }));

reg(['/status'], (msg, args) => {
  const chatId = msg.chat.id;
  if (!args) {
    const list = myBots(chatId);
    if (!list.length) return send(chatId, "Hali bot yo'q.");
    return sendLong(chatId, list.map(b => b.statusText()).join('\n\n———\n\n'));
  }
  const b = getMine(chatId, args);
  send(chatId, b ? b.statusText() : 'Bunday bot topilmadi.');
});

reg(['/cmd'], withBot('Format: /cmd <id> <buyruq>\nMasalan: /cmd 5 /tpa Nick', (msg, b, rest) => {
  if (!rest) return send(msg.chat.id, 'Buyruq yozilmagan. Masalan: /cmd 5 /tpa Nick');
  const r = b.sendText(normCmd(rest), msg.chat.id);
  send(msg.chat.id, r.ok ? r.msg : `❌ ${r.msg}`);
}));

reg(['/say'], withBot('Format: /say <id> <matn>\nMasalan: /say 5 salom', (msg, b, rest) => {
  if (!rest) return send(msg.chat.id, 'Matn yozilmagan.');
  const r = b.sendText(rest, msg.chat.id);
  send(msg.chat.id, r.ok ? r.msg : `❌ ${r.msg}`);
}));

reg(['/delay'], withBot('Format: /delay <id> <vaqt> <buyruq>\nMasalan: /delay 5 2d /server anarxiya', (msg, b, rest) => {
  const chatId = msg.chat.id;
  const m = /^(\S+)\s+([\s\S]+)$/.exec(rest);
  const ms = m ? parseDuration(m[1]) : null;
  if (!ms) return send(chatId, "Vaqt noto'g'ri. Masalan: 30m, 2h, 2d, 1w");
  const c = normCmd(m[2]);
  if (c.length > CHAT_LIMIT) return send(chatId, `❌ Buyruq juda uzun (${CHAT_LIMIT} belgi chegarasi).`);
  b.addJob({ kind: 'once', cmd: c, runAt: now() + ms });
  send(chatId, `⏰ #${b.id}: ${humanDur(ms)}dan keyin "${c}" bir marta yuboriladi.\n` +
    (b.stopped ? "⚠️ Bot hozir to'xtagan, ishga tushgach yuboriladi." : "Bot onlayn bo'lmasa, ulanganda yuboriladi."));
}));

reg(['/auto'], withBot('Format: /auto <id> <vaqt> <buyruq>\nMasalan: /auto 5 3d /home home', (msg, b, rest) => {
  const chatId = msg.chat.id;
  const m = /^(\S+)\s+([\s\S]+)$/.exec(rest);
  const ms = m ? parseDuration(m[1]) : null;
  if (!ms) return send(chatId, "Vaqt noto'g'ri. Masalan: 30m, 2h, 3d");
  if (ms < MIN_AUTO_MS) return send(chatId, "❌ Eng kam takrorlash oralig'i: 30s");
  const c = normCmd(m[2]);
  if (c.length > CHAT_LIMIT) return send(chatId, `❌ Buyruq juda uzun (${CHAT_LIMIT} belgi chegarasi).`);
  b.addJob({ kind: 'auto', cmd: c, everyMs: ms, nextAt: now() + ms });
  send(chatId, `🔁 #${b.id}: "${c}" har ${humanDur(ms)}da takrorlanadi.\nBot offline bo'lsa, o'sha payt o'tkaziladi.`);
}));

reg(['/jobs'], withBot('Format: /jobs <id>', (msg, b) => {
  send(msg.chat.id, jobsText(b), { reply_markup: jobsKeyboard(b) });
}));

reg(['/jobdel'], withBot('Format: /jobdel <id> <raqam>\nMasalan: /jobdel 5 1', (msg, b, rest) => {
  const n = Number(rest);
  const ok = b.removeJobByNumber(n);
  send(msg.chat.id, ok ? `🗑 #${b.id} ${n}-reja o'chirildi.` : `Bunday raqamli reja yo'q. Ro'yxat: /jobs ${b.id}`);
}));

reg(['/run'], withBot('Format: /run <id>', (msg, b) => {
  const ok = b.start();
  send(msg.chat.id, ok ? `▶️ #${b.id} ishga tushmoqda...` : `⏳ #${b.id} muddati tugagan. /muddat ${b.id}`);
}));

reg(['/stop'], withBot('Format: /stop <id>', (msg, b) => {
  b.stop();
  send(msg.chat.id, `⏹ #${b.id} to'xtatildi.`);
}));

reg(['/restart'], withBot('Format: /restart <id>', async (msg, b) => {
  b.stop();
  await sleep(800);
  const ok = b.start();
  send(msg.chat.id, ok ? `🔄 #${b.id} qayta ishga tushdi.` : `⏳ #${b.id} muddati tugagan.`);
}));

reg(['/remove'], withBot('Format: /remove <id>', (msg, b) => {
  b.stop();
  bots.delete(b.id);
  saveAll();
  send(msg.chat.id, `🗑 #${b.id} o'chirildi.`);
}));

reg(['/ferma'], withBot('Format: /ferma <id> start | stop | status | area x y z [r] | area here [r] | chest x y z', (msg, b, rest) => {
  const chatId = msg.chat.id;
  const parts = rest.split(/\s+/).filter(Boolean);
  const sub = (parts[0] || 'status').toLowerCase();
  const a = parts.slice(1);

  if (sub === 'start') { const r = b.startFarm(); return send(chatId, r.ok ? r.msg : `❌ ${r.msg}`); }
  if (sub === 'stop') { b.stopFarm(); return send(chatId, "⏹ Ferma to'xtatildi."); }

  if (sub === 'area') {
    let x, y, z, r = 20;
    if (a[0] === 'here') {
      if (!b.online || !b.bot || !b.bot.entity) return send(chatId, '❌ Bot serverda emas. Avval uni ishga tushiring.');
      const p = b.bot.entity.position;
      x = Math.floor(p.x); y = Math.floor(p.y); z = Math.floor(p.z);
      if (a[1]) r = Number(a[1]);
    } else {
      [x, y, z] = a.slice(0, 3).map(Number);
      if (a[3]) r = Number(a[3]);
    }
    if (![x, y, z].every(Number.isFinite) || !(r >= 3 && r <= 64)) {
      return send(chatId, 'Format: /ferma <id> area x y z [r] (r: 3–64)\nYoki: /ferma <id> area here [r]');
    }
    b.farmCfg.area = { x, y, z, r };
    saveAll();
    return send(chatId, `✅ Ferma maydoni: ${x} ${y} ${z}, radius ${r}`);
  }

  if (sub === 'chest') {
    const [x, y, z] = a.slice(0, 3).map(Number);
    if (![x, y, z].every(Number.isFinite)) return send(chatId, 'Format: /ferma <id> chest x y z');
    b.farmCfg.chest = { x, y, z };
    saveAll();
    return send(chatId, `✅ Sandiq: ${x} ${y} ${z}`);
  }

  return send(chatId, b.farmStatusText());
}));

reg(['/muddat'], withBot('Format: /muddat <id> [+3d | -1d | +12h | cheksiz | 0]', (msg, b, arg) => {
  const chatId = msg.chat.id;
  const a = arg.toLowerCase();
  if (!a) {
    return send(chatId, muddatText(b) + `\n\nO'zgartirish: /muddat ${b.id} +3d | -1d | +12h | cheksiz | 0`,
      { reply_markup: muddatKeyboard(b) });
  }
  if (a === 'cheksiz' || a === 'inf') {
    b.applyPlan('inf');
  } else if (a === '0') {
    b.endNow();
  } else {
    const m = /^([+-])(.+)$/.exec(a);
    const ms = m ? parseDuration(m[2]) : null;
    if (!ms) return send(chatId, 'Format: +3d, -1d, +12h, cheksiz yoki 0');
    b.adjustTime(m[1] === '-' ? -ms : ms);
  }
  send(chatId, `✅ #${b.id} muddat: ${b.remainingText()}`);
}));

reg(['/logindelay'], withBot('Format: /logindelay <id> <soniya>\nMasalan: /logindelay 5 3', (msg, b, rest) => {
  const v = Number(rest);
  if (!rest || Number.isNaN(v) || v < 0 || v > 120) return send(msg.chat.id, "Soniya 0–120 oralig'ida bo'lsin.");
  b.loginDelay = v;
  saveAll();
  send(msg.chat.id, `⏱ #${b.id}: /login ${v}s dan keyin yuboriladi. Keyingi ulanishda kuchga kiradi (🔄 Restart).`);
}));

reg(['/cmddelay'], withBot('Format: /cmddelay <id> <soniya>\nMasalan: /cmddelay 5 15', (msg, b, rest) => {
  const v = Number(rest);
  if (!rest || Number.isNaN(v) || v < 0 || v > 300) return send(msg.chat.id, "Soniya 0–300 oralig'ida bo'lsin.");
  b.cmdDelay = v;
  saveAll();
  send(msg.chat.id, `⏱ #${b.id}: /login dan ${v}s keyin hub buyruqlari yuboriladi. Keyingi ulanishda kuchga kiradi (🔄 Restart).`);
}));

reg(['/version'], withBot('Format: /version <id> <versiya|auto>\nMasalan: /version 5 1.21.1', (msg, b, rest) => {
  const v = rest.toLowerCase();
  if (v === 'auto' || v === '-') b.version = false;
  else if (validVersion(rest)) b.version = rest;
  else return send(msg.chat.id, 'Versiya formati: 1.21.1 yoki auto');
  saveAll();
  send(msg.chat.id, `🎮 #${b.id}: versiya ${b.version || 'avto'}. Keyingi ulanishda kuchga kiradi (🔄 Restart).`);
}));

// ---------------- MATN XABARLARI (ROUTER) ----------------
tg.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;
  const raw = text.split(/\s+/)[0];
  const first = raw.split('@')[0].toLowerCase();
  if (first === '/myid') {
    return send(chatId, `🆔 Sizning Telegram ID: ${msg.from.id}\nBu raqamni adminga yuboring, u sizni qo'shadi.`);
  }
  if (!isAllowed(msg.from.id)) {
    if (text.startsWith('/')) send(chatId, "⛔ Ruxsat yo'q. Ruxsat uchun /myid orqali ID ni yuboring.");
    return;
  }
  if (COMMANDS[first]) return COMMANDS[first](msg, text.slice(raw.length).trim());
  if (await handleFlow(msg, text)) return;
  if (text.startsWith('/')) return send(chatId, "❓ Noma'lum buyruq. Ro'yxat: /help");
  send(chatId, 'Tushunmadim. Menyu: /bots, yordam: /help');
});

// ---------------- TUGMALAR (CALLBACK) ----------------
tg.on('callback_query', async q => {
  const chatId = q.message && q.message.chat.id;
  const msgId = q.message && q.message.message_id;
  const answer = (text, alert = false) =>
    tg.answerCallbackQuery(q.id, text ? { text, show_alert: alert } : {}).catch(() => {});
  const edit = (text, kb) =>
    tg.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: kb }).catch(() => {});

  if (!isAllowed(q.from.id)) return answer("Ruxsat yo'q", true);

  const [act, a, key] = String(q.data || '').split(':');

  if (act === 'new') { await answer(); return startFlow(chatId); }
  if (act === 'back') { await answer(); return edit(listText(chatId), listKeyboard(chatId)); }

  if (act === 'fplan') {
    const flow = flows.get(chatId);
    if (!flow || flow.step !== 'plan' || !PLANS[a]) {
      await answer('Eskirgan tugma. /start yozing', true);
      return;
    }
    flows.delete(chatId);
    const b = createBotFromFlow(chatId, flow.data, a);
    await answer('Bot ishga tushdi ▶️');
    return edit(newBotDone(b), { inline_keyboard: [] });
  }

  const b = getMine(chatId, a);
  if (!b) { await answer('Bot topilmadi'); return edit(listText(chatId), listKeyboard(chatId)); }

  switch (act) {
    case 'sel':
      await answer();
      return edit(botCard(b), botKeyboard(b));
    case 'start': {
      const ok = b.start();
      await answer(ok ? 'Ishga tushirildi ▶️' : 'Muddat tugagan ⏳', !ok);
      await sleep(800);
      return edit(botCard(b), botKeyboard(b));
    }
    case 'stop':
      b.stop();
      await answer("To'xtatildi ⏹");
      return edit(botCard(b), botKeyboard(b));
    case 'restart':
      await answer('Qayta ishga tushmoqda 🔄');
      b.stop();
      await sleep(800);
      b.start();
      await sleep(300);
      return edit(botCard(b), botKeyboard(b));
    case 'cmdbtn':
      flows.set(chatId, { step: 'botcmd', botId: b.id, data: {} });
      await answer();
      return send(chatId, `⌨️ #${b.id} uchun buyruqni yozing.\nMasalan: /tpa Nick   yoki   /pay Nick 100\nBekor qilish: /cancel`);
    case 'jobs':
      await answer();
      return edit(jobsText(b), jobsKeyboard(b));
    case 'jobdel': {
      const ok = b.removeJobByNumber(Number(key));
      await answer(ok ? "O'chirildi" : 'Topilmadi');
      return edit(jobsText(b), jobsKeyboard(b));
    }
    case 'muddat':
      await answer();
      return edit(muddatText(b), muddatKeyboard(b));
    case 'plan':
      if (!b.applyPlan(key)) { await answer("Noma'lum tarif", true); return; }
      await answer(`✅ ${PLANS[key].label} qo'shildi`);
      await sleep(400);
      return edit(botCard(b), botKeyboard(b));
    case 'endnow':
      b.endNow();
      await answer('Muddat tugatildi');
      await sleep(300);
      return edit(botCard(b), botKeyboard(b));
    case 'farm':
      await answer();
      return edit(b.farmStatusText(), farmKeyboard(b));
    case 'farmstart': {
      const r = b.startFarm();
      await answer(r.msg, !r.ok);
      await sleep(600);
      return edit(b.farmStatusText(), farmKeyboard(b));
    }
    case 'farmstop':
      b.stopFarm();
      await answer("Ferma to'xtatildi ⏹");
      return edit(b.farmStatusText(), farmKeyboard(b));
    case 'del':
      await answer();
      return edit(`🗑 #${b.id} ${b.username} ni butunlay o'chirasizmi?`, {
        inline_keyboard: [[
          { text: "✅ Ha, o'chir", callback_data: `delok:${b.id}` },
          { text: "❌ Yo'q", callback_data: `sel:${b.id}` },
        ]],
      });
    case 'delok':
      b.stop();
      bots.delete(b.id);
      saveAll();
      await answer("O'chirildi");
      return edit(listText(chatId), listKeyboard(chatId));
    default:
      return answer();
  }
});

// ---------------- MUDDAT VA REJA TEKSHIRUVI ----------------
function tick() {
  for (const b of bots.values()) {
    if (!b.stopped && b.isExpired()) { b.expire(); continue; }
    if (!b.stopped && !b.unlimited && b.expiresAt && !b.warned) {
      const left = b.expiresAt - now();
      if (left > 0 && left < DAY) {
        b.warned = true;
        b.notify(`⏰ Muddat tugashiga ${fmtDur(left)} qoldi. Uzaytirish: /muddat ${b.id}`);
      }
    }
    b.runDueJobs();
  }
}

// ---------------- ISHGA TUSHIRISH ----------------
let tokenWarned = false;
let pollRestartTimer = null;
tg.on('polling_error', e => {
  const m = String(e.message || e);
  if (/\b(401|404)\b/.test(m)) {
    if (!tokenWarned) {
      tokenWarned = true;
      console.error("\n❌ TOKEN NOTO'G'RI yoki BEKOR QILINGAN (Telegram: " + m + ').');
      console.error('   BotFather -> /mybots -> botni tanlang -> API Token orqali yangi token oling.\n');
    }
    tg.stopPolling().catch(() => {});
    process.exit(1);
  }
  if (/\b409\b/.test(m)) { console.error("⚠️ 409: boshqa nusxa ishlayapti. Ikkinchisini to'xtating."); return; }
  console.error('Telegram polling xatosi:', m);
  if (/EFATAL|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|ECONNREFUSED/i.test(m)) {
    // Tarmoq uzilgan: polling to'xtashi mumkin, qayta boshlaymiz
    clearTimeout(pollRestartTimer);
    pollRestartTimer = setTimeout(() => {
      tg.stopPolling().catch(() => {}).then(() => tg.startPolling()).catch(() => {});
    }, 5000);
  }
});

process.on('uncaughtException', e => console.error('uncaught:', e.message));
process.on('unhandledRejection', e => console.error('unhandled:', e && e.message));

function shutdown() {
  saveAll();
  for (const b of bots.values()) b.cleanupConn();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

loadUsers();
loadAll();
setInterval(tick, TICK_MS);
tg.getMe()
  .then(me => console.log(`Telegram bot ulandi: @${me.username}`))
  .catch(() => {});
console.log('Telegram bot ishga tushdi.');