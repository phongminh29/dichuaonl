// Chánh Điện Tịnh Tâm — live server
// Runs on the streaming PC. Serves the overlay + control panel, listens to a TikTok LIVE room,
// keeps the list of seated viewers, generates Vietnamese voice lines with Edge TTS and pushes
// everything to the overlay over WebSocket.
//
//   cd live && npm install && node server.mjs        → http://localhost:3000/live/control.html
//
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');            // repo root: serves /assets, /live
const TTS_DIR = path.join(__dirname, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} }
const PORT = +process.env.PORT || 3000;

/* ------------------------------------------------------------------ state */
const settings = {
  title: 'Chánh Điện Tịnh Tâm',
  subtitle: 'Nam Mô A Di Đà Phật',
  voice: 'vi-VN-NamMinhNeural',      // or vi-VN-HoaiMyNeural
  pitch: -18,                        // Hz
  rate: -20,                         // %
  music: true, mo: true, moBpm: 52,
  autoChant: true, chantEveryMin: 5,
  seatMode: 'auto',                  // auto | 24 | 36 | 64 | 100
  joinOnEnter: false,                // also seat viewers who only enter the room
  ambient: false,                    // sample guests and teachers say a short light line now and then (off by default)
  ambientEvery: 5,                   // seconds between lines, on average
  // one "HH:MM text" per line; a line with "thiền" starts a guided meditation at that time ("N phút" sets its length)
  schedule: '20:00 Tụng kinh, nghe pháp\n21:00 Thiền dẫn 10 phút\n21:15 Niệm Phật, nhạc thiền\n22:00 Thiền dẫn 10 phút\n22:15 Nhạc thiền dễ ngủ',
  meditateMin: 10,
  likeZoom: 50,                      // a viewer's taps that zoom the camera onto their seat (then 4×, 10×, 20×, …)
  likeRush: 300,                     // taps from the whole room within one minute for the "đồng tâm" moment
  goalTarget: 5000,                  // incense-stick milestone: the bar fills to the next multiple of this
  gifts: { readAll: true, minDiamonds: 1 },
};
const viewers = new Map();           // id -> { id, name, skin, avatar, coins, joinedAt, lastAt, lastText, lastTextAt, demo }
const startedAt = Date.now();
let tiktok = null, tiktokState = { status: 'idle', uniqueId: '', error: '' };
const log = [];
function addLog(s){ const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`; log.push(line); if (log.length > 300) log.shift(); broadcast({ t:'log', line }, 'control'); console.log(line); }

const CAPS = [24, 36, 64, 100];
function capacity(){ if (settings.seatMode !== 'auto') return +settings.seatMode; const n = viewers.size; return CAPS.find(c => n <= c) || 100; }

/* skins: sprites that exist in /assets. Walking strips exist for man / woman / granny. */
// A comment changes the outfit only when it IS the keyword (≤ 3 words), so "Nam mô A Di Đà Phật" never reads as "nam".
const SKIN_WORDS = [
  ['master', ['cao tăng','cao tang']], ['monk', ['sư','su','sư thầy','su thay','thầy','thay']], ['nun', ['ni','ni cô','ni co','sư cô','su co']],
  ['child', ['tiểu','tieu','chú tiểu','chu tieu','bé','be']], ['granny', ['bà','ba','áo nâu','ao nau','cụ','cu']],
  ['woman', ['nữ','nu','chị','chi','gái','gai']], ['man', ['nam','anh','trai']],
];
function skinFromText(t){
  const w = String(t).toLowerCase().normalize('NFC').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!w || w.split(' ').length > 3 || /^nam m[oô]\b/.test(w)) return null;   // "nam mô" is a greeting, not "nam"
  for (const [skin, words] of SKIN_WORDS) if (words.some(k => w === k || w.startsWith(k + ' '))) return skin;
  return null;
}
const DEFAULT_SKINS = ['man', 'woman', 'woman', 'man', 'granny'];

function pub(v){ return { id:v.id, name:v.name, skin:v.skin, avatar:v.avatar||'', coins:v.coins, demo:!!v.demo }; }
function snapshot(){ return { t:'state', settings, viewers:[...viewers.values()].map(pub), cap: capacity(), startedAt, tiktok: tiktokState,
  goal: goalMsg(), nextChantAt, rituals: RITUALS, program: programMsg(), med: medMsg() }; }

function seat(id, name, opts = {}){
  let v = viewers.get(id);
  if (v){ v.lastAt = Date.now(); if (opts.avatar) v.avatar = opts.avatar; return { v, isNew:false }; }
  if (viewers.size >= 100){                     // full: the longest-quiet non-donor stands up
    const quiet = [...viewers.values()].filter(x => x.coins === 0).sort((a,b) => a.lastAt - b.lastAt)[0];
    if (!quiet) return { v:null, isNew:false };
    viewers.delete(quiet.id); broadcast({ t:'leave', id: quiet.id });
  }
  v = { id, name: (name||id).slice(0, 18), skin: opts.skin || DEFAULT_SKINS[viewers.size % DEFAULT_SKINS.length],
        avatar: opts.avatar || '', coins: 0, joinedAt: Date.now(), lastAt: Date.now(), demo: !!opts.demo };
  viewers.set(id, v);
  broadcast({ t:'join', v: pub(v), cap: capacity() });
  return { v, isNew:true };
}

/* ------------------------------------------------------------- events in */
function onChat(id, name, text, avatar){
  text = String(text || '').slice(0, 120);
  const want = skinFromText(text);
  const { v, isNew } = seat(id, name, { avatar, skin: want || undefined });
  if (!v) return;
  if (!isNew && want && want !== v.skin){ v.skin = want; broadcast({ t:'skin', id, skin: want }); }
  v.lastText = text; v.lastTextAt = Date.now();
  broadcast({ t:'chat', id, name: v.name, text });
  touch(id);
  onKeyword(v, text);
}

function onGift(id, name, giftName, count, diamonds, avatar){
  giftName = String(giftName || 'quà').slice(0, 30); count = Math.max(1, Math.min(9999, +count || 1));
  const { v } = seat(id, name, { avatar });
  if (!v) return;
  const coins = Math.max(1, (diamonds || 1) * (count || 1));
  v.coins += coins;
  const prayer = (v.lastText && Date.now() - v.lastTextAt < 90_000 && v.lastText.length > 6) ? v.lastText : pickPrayer();
  const r = ritualFor(diamonds || 1);
  const tier = Math.max(r.tier, coins >= 99 ? 3 : coins >= 10 ? 2 : 1);
  const line = `Nam mô A Di Đà Phật. Phật tử ${spoken(v.name)} thành tâm ${r.verb}${count > 1 ? ', ' + count + ' lần' : ''}. ${prayer}.`;
  broadcast({ t:'gift', id, name: v.name, giftName, count, coins, total: v.coins, tier, prayer, ritual: r.key, verb: r.verb });
  if (settings.gifts.readAll || coins >= settings.gifts.minDiamonds) say(line, { tag:'gift', id });
  hoiHuong.add(v.name); touch(id); addIncense(coins * 10);
}

// a new follow is welcomed as "quy y"; a share is thanked. Both are throttled so a burst never floods the voice queue.
let lastShareSay = 0;
function onFollow(id, name, avatar){
  if (!id || !cool(id, 'follow', 3_600_000)) return;
  const { v } = seat(id, name, { avatar });
  broadcast({ t:'follow', id, name: v?.name || name });
  sayLow(`Hoan hỷ Phật tử ${spoken(name)} đã theo dõi kênh. Nguyện phước lành luôn đồng hành.`, { tag:'follow' });
  hoiHuong.add(v?.name || name); touch(id); addIncense(10);
}
function onShare(id, name){
  if (!id || !cool(id, 'share', 60_000)) return;
  broadcast({ t:'share', id, name });
  if (Date.now() - lastShareSay > 20_000){ lastShareSay = Date.now(); sayLow(`Cảm ơn ${spoken(name)} đã chia sẻ, lan tỏa an lành đến mọi người.`, { tag:'share' }); }
  touch(id); addIncense(5);
}

const likeCount = new Map();          // id -> { n: taps this session, k: milestones passed }
const likeWin = []; let lastRush = 0; // [time, taps] over the last minute, for the room-wide rush
const likeStep = (T, k) => k < 4 ? [1, 4, 10, 20][k] * T : 20 * T * (k - 2);
function onLike(id, n, name, avatar){
  n = Math.max(1, Math.min(100, +n || 1));
  broadcast({ t:'like', id, n });
  touch(id); addIncense(n);           // one tap = one incense stick
  const now = Date.now();
  likeWin.push([now, n]); while (likeWin.length && now - likeWin[0][0] > 60_000) likeWin.shift();
  if (now - lastRush > 180_000){
    const sum = likeWin.reduce((a, [, k]) => a + k, 0);
    if (sum >= settings.likeRush){
      lastRush = now; likeWin.length = 0;
      broadcast({ t:'rush', n: sum });
      say(`Nam mô A Di Đà Phật. Đại chúng đồng tâm, ${sum} tim trong một phút. Nguyện tất cả thân tâm an lạc.`, { tag:'rush' });
      addLog(`💗 Đồng tâm: ${sum} tim trong 1 phút`);
    }
  }
  if (!id) return;
  if (likeCount.size > 20_000) likeCount.clear();
  const L = likeCount.get(id) || { n: 0, k: 0 }; L.n += n; likeCount.set(id, L);
  const reached = likeStep(settings.likeZoom, L.k);
  if (L.n < reached) return;
  while (L.n >= likeStep(settings.likeZoom, L.k)) L.k++;
  const { v } = seat(id, name || viewers.get(id)?.name || id, { avatar }); if (!v) return;
  broadcast({ t:'spot', id, name: v.name, likes: reached });
  sayLow(`Cảm ơn Phật tử ${spoken(v.name)} đã thả ${reached} tim.`, { tag:'spot', id });
  addLog(`❤ ${v.name} đạt ${reached} tim · zoom`);
}

/* ----------------------------------------------------- rituals for gifts */
// The value of ONE gift (in xu / diamonds) picks the ritual; the overlay legend is built from this table.
const RITUALS = [
  { min: 99, key: 'festival', tier: 3, icon: '🪷', label: 'Lễ hội hoa sen', verb: 'khai mở Lễ hội hoa sen' },
  { min: 30, key: 'lantern',  tier: 2, icon: '🏮', label: 'Đèn hoa sen',    verb: 'thắp đèn hoa sen' },
  { min: 5,  key: 'lotus',    tier: 2, icon: '🌸', label: 'Hoa sen',        verb: 'dâng hoa sen' },
  { min: 1,  key: 'incense',  tier: 1, icon: '🌹', label: 'Dâng hương',     verb: 'dâng hương' },
];
const ritualFor = dia => RITUALS.find(r => dia >= r.min) || RITUALS[RITUALS.length - 1];

/* ------------------------------------------ daily incense goal + people */
// Taps, "A Di Đà Phật" comments and gifts light incense sticks toward a shared goal. Kept per calendar day in
// live/data.json so a server restart mid-stream does not zero the bar. (The static server never serves .json from /live.)
const DATA_FILE = path.join(__dirname, 'data.json');
const today = () => new Date().toLocaleDateString('sv-SE');           // YYYY-MM-DD, local time
let day = { date: today(), incense: 0, people: new Set(), loc: new Map() };
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (d.date === day.date) day = { date: d.date, mo: Math.max(0, +d.mo || 0), incense: Math.max(0, +d.incense || 0), people: new Set(d.people || []), loc: new Map(Object.entries(d.loc || {})) };
} catch {}
let dayDirty = false, goalTimer = null;
setInterval(() => {
  if (!dayDirty) return; dayDirty = false;
  const out = { date: day.date, mo: day.mo || 0, incense: day.incense, people: [...day.people], loc: Object.fromEntries(day.loc) };
  fs.writeFile(DATA_FILE, JSON.stringify(out), e => e && addLog('Không lưu được data.json: ' + e.message));
}, 10_000);
function rollDay(){ if (day.date !== today()){ day = { date: today(), incense: 0, people: new Set(), loc: new Map() }; dayDirty = true; queueGoal(); } }
function goalMsg(){
  const g = settings.goalTarget;
  return { t:'goal', mo: day.mo || 0, incense: day.incense, target: Math.ceil((day.incense + 1) / g) * g, people: day.people.size };
}
function queueGoal(){ if (!goalTimer) goalTimer = setTimeout(() => { goalTimer = null; broadcast(goalMsg()); }, 400); }   // likes arrive in bursts
function touch(id){ rollDay(); if (id && !day.people.has(id)){ day.people.add(id); dayDirty = true; queueGoal(); } }
function addIncense(n){
  rollDay(); n = Math.max(0, Math.round(n)); if (!n) return;
  const g = settings.goalTarget, before = Math.floor(day.incense / g);
  day.incense += n; dayDirty = true; queueGoal();
  if (Math.floor(day.incense / g) > before){
    const reached = Math.floor(day.incense / g) * g;
    broadcast({ t:'goalReached', count: reached });
    say(`Nam mô A Di Đà Phật. Đại chúng đã cùng thắp đủ ${reached.toLocaleString('vi-VN')} nén hương. Nguyện công đức này hồi hướng cho tất cả chúng sinh.`, { tag:'goal' });
    addLog(`🎉 Đạt mốc ${reached} nén hương`);
  }
}

/* --------------------------------------------------------- chat keywords */
// xin lộc · cầu an + tên · cầu siêu + tên · mất + đồ · meo · A Di Đà Phật. Matching ignores accents ("cau an" works too);
// the name after the keyword is taken from the original text so accents survive on screen.
const plain = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanTarget = s => String(s).normalize('NFC').replace(/[^\p{L}\p{N}\s.,-]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^cho\s+/i, '').slice(0, 24).trim();
const LOC = [
  ['Lộc bình an', 'Hôm nay ra đường thuận lợi, gặp toàn người tử tế.'], ['Lộc vui', 'Được ai đó khen một câu thật lòng.'],
  ['Lộc sức khỏe', 'Tối nay ngủ ngon, sáng mai thức dậy nhẹ người.'], ['Lộc gia đạo', 'Cả nhà quây quần bên một bữa cơm ấm.'],
  ['Lộc công việc', 'Việc khó hôm nay bỗng gỡ được nút thắt.'], ['Lộc tài', 'Có một khoản nhỏ bất ngờ, đủ mời bạn ly trà đá.'],
  ['Lộc nhân duyên', 'Gặp lại một người bạn cũ đã lâu không gặp.'], ['Lộc an tâm', 'Chuyện lo hôm qua hóa ra không đáng lo.'],
  ['Lộc trí tuệ', 'Học được một điều hay từ người bên cạnh.'], ['Lộc hiếu thảo', 'Gọi điện cho cha mẹ sẽ nghe được tin vui.'],
  ['Lộc thảnh thơi', 'Có một khoảng lặng uống trà, thở chậm.'], ['Lộc may mắn', 'Đi đâu cũng gặp đèn xanh.'],
  ['Lộc thiện duyên', 'Giúp được một người, lòng nhẹ tênh.'], ['Lộc bình yên', 'Tối nay về nhà, mọi thứ đều ổn.'],
  ['Lộc tình thân', 'Có người nhắn hỏi thăm đúng lúc.'], ['Lộc nhẫn nhịn', 'Nhịn một câu, êm cả ngày.'],
].map(([title, text]) => ({ title, text }));
// "cầu <kind> <tên>": every alternative maps to one overlay/TTS kind
const PRAY_KIND = { 'binh an':'an', an:'an', sieu:'sieu', 'tinh duyen':'duyen', duyen:'duyen', 'tai loc':'tai', tai:'tai', loc:'tai',
                    'thi do':'thi', thi:'thi', 'hoc gioi':'thi', 'suc khoe':'khoe', khoe:'khoe' };
const PRAY_RE = new RegExp(`^cau (${Object.keys(PRAY_KIND).sort((a, b) => b.length - a.length).join('|')})\\b`);
const PRAY_LINE = {
  an:    t => `Nguyện cầu cho ${t} thân tâm an lạc, mọi sự bình an.`,
  sieu:  t => `Nguyện cầu hương linh ${t} sớm vãng sanh Tịnh Độ.`,
  duyen: t => `Nguyện cầu cho ${t} sớm gặp nhân duyên lành, tình duyên viên mãn.`,
  tai:   t => `Nguyện cầu cho ${t} công việc hanh thông, tài lộc dồi dào.`,
  thi:   t => `Nguyện cầu cho ${t} trí tuệ sáng suốt, thi cử đỗ đạt.`,
  khoe:  t => `Nguyện cầu cho ${t} thân thể khỏe mạnh, bệnh tật tiêu trừ.`,
};
const XAM = [
  ['Thượng cát', 'Mây tan trăng hiện, việc đang chờ sắp có tin vui.'], ['Thượng cát', 'Gió thuận buồm xuôi, cứ mạnh dạn bước tới.'],
  ['Thượng cát', 'Cây lành trái ngọt, việc thiện hôm qua nay trổ quả.'], ['Trung cát', 'Đường xa mới biết ngựa hay, kiên nhẫn thêm chút nữa.'],
  ['Trung cát', 'Nước chảy đá mòn, chăm chỉ ắt có ngày thành.'], ['Trung cát', 'Có quý nhân phù trợ, đừng ngại nhờ người thân.'],
  ['Tiểu cát', 'Lời nói như mật, giữ hòa khí thì mọi việc êm.'], ['Tiểu cát', 'Chậm mà chắc, hôm nay chưa vội quyết việc lớn.'],
  ['Bình an', 'Trời quang mây tạnh, lòng yên thì cảnh yên.'], ['Bình an', 'Uống chén trà, thở thật chậm, mọi chuyện rồi sẽ ổn.'],
];
const kwLast = new Map();            // `${id}:${kind}` -> last time, per-viewer cooldowns
function cool(id, kind, ms){
  const k = id + ':' + kind, now = Date.now();
  if (now - (kwLast.get(k) || 0) < ms) return false;
  if (kwLast.size > 5000) kwLast.clear();
  kwLast.set(k, now); return true;
}
const lastPet = {};                   // kind -> last call, one walk-in per animal every 15 s
const hoiHuong = new Set();           // names read out at the next dedication (gift givers, prayer requests)
function sayLow(text, meta){ if (ttsQueue.length < 4) say(text, meta); }   // keyword lines never crowd out gift lines
function onKeyword(v, text){
  const p = plain(text), id = v.id;
  const words = String(text).split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  let m;
  if (/^xin loc\b/.test(p)){
    if (!day.loc.has(id)){ day.loc.set(id, Math.floor(Math.random() * LOC.length)); dayDirty = true; }   // one card per viewer per day
    if (!cool(id, 'loc', 60_000)) return;
    const card = LOC[day.loc.get(id) % LOC.length];
    broadcast({ t:'loc', id, name: v.name, card });
    sayLow(`Phật tử ${spoken(v.name)} nhận ${card.title}. ${card.text}`, { tag:'loc' });
  } else if ((m = p.match(PRAY_RE))){
    const kind = PRAY_KIND[m[1]];
    const target = cleanTarget(words.slice(m[1].split(' ').length + 1).join(' ')) || (kind === 'sieu' ? 'cửu huyền thất tổ' : v.name);
    if (!cool(id, 'pray', 20_000)) return;
    broadcast({ t:'pray', kind, id, name: v.name, target });
    sayLow(PRAY_LINE[kind](spoken(target)), { tag:'pray' });
    hoiHuong.add(v.name); addIncense(3);
  } else if ((m = p.match(/^(chuc mung sinh nhat|mung sinh nhat|sinh nhat|happy birthday|hpbd)\b/))){
    const target = cleanTarget(words.slice(m[1].split(' ').length).join(' ')) || v.name;
    if (!cool(id, 'sinh', 60_000)) return;
    broadcast({ t:'pray', kind:'sinh', id, name: v.name, target });
    sayLow(`Chúc mừng sinh nhật ${spoken(target)}. Nguyện tuổi mới thân tâm an lạc, phước thọ tăng long.`, { tag:'pray' });
    hoiHuong.add(target); addIncense(3);
  } else if (/^(xin xam|xin que|gieo que|rut xam)\b/.test(p)){
    if (!cool(id, 'xam', 60_000)) return;
    const n = 1 + Math.floor(Math.random() * 100), [level, verse] = XAM[Math.floor(Math.random() * XAM.length)];
    broadcast({ t:'loc', id, name: v.name, card: { title: `Quẻ số ${n} · ${level}`, text: verse }, head: '🎋 QUẺ XĂM' });
    sayLow(`Phật tử ${spoken(v.name)} gieo được quẻ số ${n}, ${level}. ${verse}`, { tag:'loc' });
  } else if (/^(go mo|mo mo|coc coc|cong duc|\+1 cong duc|1 cong duc)\b|^mo$/.test(p)){
    if (!cool(id, 'mo', 3_000)) return;
    rollDay(); day.mo = (day.mo || 0) + 1; dayDirty = true;
    broadcast({ t:'mo', id, n: day.mo }); addIncense(1);
  } else if (['mất', 'mat'].includes(words[0]?.toLowerCase().normalize('NFC')) && words.length >= 2 && words.length <= 6){   // not "mát"
    const target = cleanTarget(words.slice(1).join(' '));
    if (!target || !cool(id, 'lost', 20_000)) return;
    broadcast({ t:'pray', kind:'lost', id, name: v.name, target });
    sayLow(`Nguyện cầu Phật tử ${spoken(v.name)} sớm tìm lại ${spoken(target)}.`, { tag:'pray' });
  } else if ((m = p.match(/^(meo|meo meo|meow|goi meo|gau|gau gau|gau gau gau|goi cun|hiu|hiu hiu|huou|goi huou)$/))){
    const kind = /gau|cun/.test(m[1]) ? 'dog' : /hiu|huou/.test(m[1]) ? 'deer' : 'cat';
    if (Date.now() - (lastPet[kind] || 0) < 15_000) return;
    lastPet[kind] = Date.now(); broadcast({ t:'cat', kind, id, name: v.name });
  } else if (/a ?di ?da ?phat|nam mo|mo phat/.test(p)){
    if (cool(id, 'bow', 8_000)){ addIncense(1); broadcast({ t:'bow', id }); }
  }
}

function pickPrayer(){
  const P = ['Nguyện cầu gia đạo bình an, vạn sự cát tường', 'Nguyện cầu cha mẹ mạnh khỏe, sống lâu', 'Nguyện hồi hướng công đức cho khắp pháp giới chúng sinh',
             'Nguyện cầu thân tâm an lạc, phiền não tiêu trừ', 'Nguyện cầu công việc hanh thông, gia đình hạnh phúc'];
  return P[Math.floor(Math.random() * P.length)];
}
const spoken = s => String(s).replace(/[_@.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim() || 'ẩn danh';

/* ------------------------------------------------------------------ TTS */
const ttsQueue = []; let ttsBusy = false, ttsSeq = 0;
function esc(s){ return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])); }
function say(text, meta = {}){ if (ttsQueue.length >= 15) { addLog('Hàng đợi giọng đọc đầy, bỏ qua 1 câu'); return; } ttsQueue.push({ text: String(text).slice(0, 500), meta }); pumpTTS(); }
async function pumpTTS(){
  if (ttsBusy || !ttsQueue.length) return; ttsBusy = true;
  const { text, meta } = ttsQueue.shift();
  for (let attempt = 1; attempt <= 3; attempt++){       // the Edge service drops ~1 in 3 requests mid-stream; the same text usually works on retry
    try {
      const audio = await synth(text);
      const file = `tts_${Date.now()}_${++ttsSeq}.mp3`;
      fs.writeFileSync(path.join(TTS_DIR, file), audio);
      broadcast({ t:'tts', url: `/live/tts/${file}`, text, ...meta });
      const old = fs.readdirSync(TTS_DIR).sort(); while (old.length > 40) { try { fs.unlinkSync(path.join(TTS_DIR, old.shift())); } catch {} }
      break;
    } catch (e) {
      if (attempt === 3) addLog('TTS lỗi (đã thử 3 lần): ' + (e?.message || e));
      else await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  ttsBusy = false; setTimeout(pumpTTS, 50);
}
async function synth(text){
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(esc(text), { pitch: `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`, rate: `${settings.rate >= 0 ? '+' : ''}${settings.rate}%` });
    const chunks = [];
    await new Promise((res, rej) => { audioStream.on('data', c => chunks.push(c)); audioStream.on('close', res); audioStream.on('error', rej); });
    return Buffer.concat(chunks);
  } finally { try { tts.close(); } catch {} }
}

const CHANTS = [
  'Nam mô Bổn Sư Thích Ca Mâu Ni Phật. Nguyện đem công đức này, hướng về khắp tất cả, đệ tử và chúng sinh, đều trọn thành Phật đạo.',
  'Nam mô A Di Đà Phật. Nguyện sanh Tây Phương Tịnh Độ trung, cửu phẩm liên hoa vi phụ mẫu.',
  'Nam mô Đại Bi Quán Thế Âm Bồ Tát. Nguyện cho tất cả chúng sinh thân tâm an lạc, tai qua nạn khỏi.',
  'Quán Tự Tại Bồ Tát hành thâm Bát Nhã Ba La Mật Đa thời, chiếu kiến ngũ uẩn giai không, độ nhất thiết khổ ách.',
];
let chantIdx = 0, chantTimer = null, nextChantAt = 0;
// Each chant is also the dedication ("lễ hồi hướng"): it names everyone who gave or asked for a prayer since the last one.
function chant(){
  const names = [...hoiHuong]; hoiHuong.clear();
  let text = CHANTS[chantIdx++ % CHANTS.length];
  if (names.length) text += ` Hồi hướng công đức cho Phật tử ${names.slice(0, 6).map(spoken).join(', ')}${names.length > 6 ? ` và ${names.length - 6} Phật tử khác` : ''}. Nguyện tất cả thân tâm an lạc.`;
  broadcast({ t:'chant', text, dedication: names.length > 0 }); say(text, { tag:'chant' });
}
// a timeout chain (not setInterval) so the overlay countdown always knows the exact next time
function scheduleChant(){
  clearTimeout(chantTimer); nextChantAt = 0;
  if (settings.autoChant){
    const ms = Math.max(1, settings.chantEveryMin) * 60_000;
    nextChantAt = Date.now() + ms;
    chantTimer = setTimeout(() => { if (!med) chant(); scheduleChant(); }, ms);   // no chant over a meditation
  }
  broadcast({ t:'next', at: nextChantAt });
}
setImmediate(scheduleChant);          // after the WebSocket server below exists

/* ------------------------------------------ program schedule + guided meditation */
function parseSchedule(){
  return String(settings.schedule || '').normalize('NFC').split(/\r?\n/).map(l => l.trim().match(/^(\d{1,2})[:h.](\d{2})\s+(.+)$/i)).filter(Boolean)
    .map(([, h, m, text]) => ({ min: (+h % 24) * 60 + +m, at: `${String(+h % 24).padStart(2, '0')}:${m}`, text: text.slice(0, 60) }))
    .sort((a, b) => a.min - b.min);
}
function programMsg(){
  const list = parseSchedule(); if (!list.length) return { t:'program', now: null, next: null };
  const d = new Date(), cur = d.getHours() * 60 + d.getMinutes(), i = list.findLastIndex(x => x.min <= cur);
  return { t:'program', now: list[i >= 0 ? i : list.length - 1], next: list.length > 1 ? list[(i + 1) % list.length] : null };   // before the first item, last night's is still on
}
let progKey = '';
const medFired = new Set();
function programTick(){
  const p = programMsg(), key = JSON.stringify([p.now, p.next]);
  if (key !== progKey){ progKey = key; broadcast(p); }
  const n = p.now, d = new Date();
  // only within its own minute, so restarting the server later never starts it again
  if (n && !med && d.getHours() * 60 + d.getMinutes() === n.min && /thiền|thien/i.test(n.text) && !medFired.has(today() + n.at)){
    medFired.add(today() + n.at); startMeditation(+(n.text.match(/(\d+)\s*ph/i)?.[1]) || settings.meditateMin);
  }
}
setInterval(programTick, 10_000); setImmediate(programTick);

// offsets are for a 600 s session and scale to the chosen length
const MED_LINES = [
  [0,   'Mời đại chúng ngồi thẳng lưng, thả lỏng đôi vai, nhẹ nhàng khép mắt lại.'],
  [25,  'Hít vào, tôi biết tôi đang hít vào. Thở ra, tôi biết tôi đang thở ra.'],
  [70,  'Hít vào, thân tâm lắng dịu. Thở ra, mỉm cười thật nhẹ.'],
  [130, 'Nếu tâm chạy đi đâu, chỉ cần nhẹ nhàng đưa nó trở về với hơi thở.'],
  [190, 'Cảm nhận đôi vai, cánh tay, đôi bàn tay đang thả lỏng.'],
  [250, 'Hít vào, tôi vững chãi như núi. Thở ra, tôi tĩnh lặng như mặt hồ.'],
  [300, 'Đã được nửa thời thiền. Cứ nhẹ nhàng, không cần cố gắng.'],
  [360, 'Hít vào, nhớ đến một người thân yêu. Thở ra, gửi đến họ lời chúc bình an.'],
  [420, 'Hít vào, tôi biết ơn ngày hôm nay. Thở ra, tôi buông xuống những lo âu.'],
  [490, 'Chỉ còn ít phút. Hãy an trú trong từng hơi thở.'],
  [550, 'Từ từ cử động các ngón tay, ngón chân.'],
  [600, 'Nhẹ nhàng mở mắt. Nguyện công đức thời thiền này hồi hướng cho tất cả chúng sinh. Nam mô A Di Đà Phật.'],
];
let med = null, medTimers = [];
function medMsg(){ return { t:'med', start: med?.start || 0, end: med?.end || 0 }; }
function startMeditation(min){
  stopMeditation(true);
  min = clamp(min, 1, 60); const ms = min * 60_000, start = Date.now();
  med = { start, end: start + ms }; broadcast(medMsg()); addLog(`🧘 Bắt đầu thiền dẫn ${min} phút`);
  for (const [off, text] of MED_LINES) medTimers.push(setTimeout(() => { broadcast({ t:'medLine', text }); say(text, { tag:'med' }); }, off / 600 * (ms - 15_000)));
  medTimers.push(setTimeout(() => stopMeditation(), ms));
}
function stopMeditation(silent){
  medTimers.forEach(clearTimeout); medTimers = [];
  if (!med) return;
  med = null; broadcast(medMsg()); if (!silent) addLog('🧘 Kết thúc thiền dẫn');
}

/* --------------------------------------------------------------- TikTok */
let TikTokLib = null;
async function connectTikTok(uniqueId){
  uniqueId = String(uniqueId || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!uniqueId) return;
  await disconnectTikTok();
  tiktokState = { status: 'connecting', uniqueId, error: '' }; broadcast({ t:'tiktok', ...tiktokState });
  try {
    TikTokLib ||= await import('tiktok-live-connector');
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = TikTokLib;
    // gift/list signing needs a paid Euler plan; giftDetails on each gift event is enough
    const conn = new TikTokLiveConnection(uniqueId, { enableExtendedGiftInfo: false, processInitialData: false });
    const av = u => u?.profilePicture?.url?.[0] || u?.profilePicture?.urlList?.[0] || u?.avatarThumb?.urlList?.[0] || u?.avatarThumb?.url?.[0] || '';
    const nm = u => u?.nickname || uid(u) || 'ẩn danh';
    // connector 2.x (proto v3): handle is user.displayId, numeric id is user.id; uniqueId/userId kept for older payloads
    const uid = u => u?.displayId || u?.uniqueId || u?.id || u?.userId || '';
    conn.on(WebcastEvent.CHAT, d => { const id = uid(d.user); if (id) onChat(id, nm(d.user), d.content ?? d.comment, av(d.user)); });
    conn.on(WebcastEvent.GIFT, d => {
      const type = d.gift?.type ?? d.giftDetails?.giftType ?? d.extendedGiftInfo?.type;
      if (type === 1 && !d.repeatEnd) return;                       // streak still running
      const gname = d.gift?.name || d.giftDetails?.giftName || d.extendedGiftInfo?.name || 'quà';
      const dia = d.gift?.diamondCount ?? d.giftDetails?.diamondCount ?? d.extendedGiftInfo?.diamond_count ?? 1;
      const id = uid(d.user); if (!id) return;
      onGift(id, nm(d.user), gname, d.repeatCount || 1, dia, av(d.user));
      addLog(`🎁 ${nm(d.user)} tặng ${gname} x${d.repeatCount || 1}`);
    });
    conn.on(WebcastEvent.MEMBER, d => { const id = uid(d.user); if (settings.joinOnEnter && id) seat(id, nm(d.user), { avatar: av(d.user) }); });
    conn.on(WebcastEvent.FOLLOW, d => onFollow(uid(d.user), nm(d.user), av(d.user)));
    conn.on(WebcastEvent.SHARE, d => onShare(uid(d.user), nm(d.user)));
    conn.on(WebcastEvent.LIKE, d => onLike(uid(d.user), d.count || d.likeCount || 1, nm(d.user), av(d.user)));
    conn.on(ControlEvent.DISCONNECTED, () => { tiktokState = { ...tiktokState, status: 'disconnected' }; broadcast({ t:'tiktok', ...tiktokState }); addLog('TikTok: mất kết nối'); });
    conn.on(ControlEvent.ERROR, e => addLog('TikTok lỗi: ' + (e?.info || e?.message || e)));
    const st = await conn.connect();
    tiktok = conn;
    tiktokState = { status: 'connected', uniqueId, error: '', roomId: st?.roomId || '' };
    addLog(`✅ Đã kết nối live @${uniqueId}`);
  } catch (e) {
    tiktokState = { status: 'error', uniqueId, error: String(e?.message || e) };
    addLog(`❌ Không kết nối được @${uniqueId}: ${tiktokState.error}`);
  }
  broadcast({ t:'tiktok', ...tiktokState });
}
async function disconnectTikTok(){ if (tiktok){ try { await tiktok.disconnect(); } catch {} tiktok = null; } tiktokState = { status:'idle', uniqueId:'', error:'' }; broadcast({ t:'tiktok', ...tiktokState }); }

/* ------------------------------------------------------------- test data */
const DEMO_NAMES = ['Diệu Hạnh','Minh Tâm','Thiện Đức','Huệ An','Tịnh Nhã','Quảng Trí','Chơn Như','Pháp Hỷ','Nguyên Thanh','Tâm Đăng','Diệu Liên','Trí Hải','Phước Lộc','Hạnh Nguyện','Như Ý','Bảo Châu','Thanh Lương','Từ Tâm','An Lạc','Giác Hoa','Tuệ Minh','Liên Hương','Thu Hà','Ngọc Lan','Đức Anh','Hải Đăng','Mai Anh','Phương Thảo','Trung Kiên','Quang Huy','Bảo Ngọc','Diệu Linh'];
function fillDemo(n){
  const have = [...viewers.values()].filter(v => v.demo).length;
  for (let i = have; i < n && viewers.size < 100; i++){
    const name = DEMO_NAMES[i % DEMO_NAMES.length] + (i >= DEMO_NAMES.length ? ' ' + (Math.floor(i / DEMO_NAMES.length) + 1) : '');
    seat('demo_' + i, name, { demo: true, skin: ['man','woman','woman','man','granny','monk','nun','child'][i % 8] });
  }
}
function clearSeats(){ viewers.clear(); broadcast(snapshot()); addLog('Đã làm trống bồ đoàn'); }

/* ------------------------------------------------------------- control */
function onControl(m){
  switch (m.cmd){
    case 'connect': connectTikTok(m.uniqueId); break;
    case 'disconnect': disconnectTikTok(); addLog('Đã ngắt kết nối TikTok'); break;
    case 'chat': { const n = String(m.name || 'Khách').slice(0, 18); onChat('sim_' + n, n, String(m.text || 'Nam mô A Di Đà Phật').slice(0, 120)); break; }
    case 'gift': { const n = String(m.name || 'Khách').slice(0, 18); onGift('sim_' + n, n, String(m.gift || 'Hoa hồng').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000)); break; }
    case 'fill': fillDemo(clamp(m.n, 1, 100)); addLog(`Đổ người mẫu: ${viewers.size} người`); break;
    case 'clear': clearSeats(); break;
    case 'bell': broadcast({ t:'bell' }); break;
    case 'mo': broadcast({ t:'mo1' }); break;
    case 'like': { const n = String(m.name || 'Khách').slice(0, 18); onLike('sim_' + n, clamp(m.n, 1, 100), n); break; }
    case 'follow': { const n = String(m.name || 'Khách').slice(0, 18); onFollow('sim_' + n, n); break; }
    case 'share':  { const n = String(m.name || 'Khách').slice(0, 18); onShare('sim_' + n, n); break; }
    case 'chant': chant(); scheduleChant(); break;
    case 'say': if (m.text) say(String(m.text).slice(0, 400), { tag:'say' }); break;
    case 'settings': {
      const before = `${settings.autoChant}/${settings.chantEveryMin}`;
      applySettings(m.settings || {});
      if (`${settings.autoChant}/${settings.chantEveryMin}` !== before) scheduleChant();   // toggling music must not reset the countdown
      broadcast({ t:'settings', settings, cap: capacity() }); broadcast(goalMsg()); break;
    }
    case 'meditate': startMeditation(settings.meditateMin); break;
    case 'medStop': stopMeditation(); break;
    case 'goalReset': day.incense = 0; day.mo = 0; day.people.clear(); day.loc.clear(); dayDirty = true; broadcast(goalMsg()); addLog('Đã đặt lại nén hương, số Phật tử và lộc hôm nay'); break;
    case 'bots': setBots(!!m.on, +m.n || 12, m.pace); break;
  }
}

// Only known keys, right types, sane ranges: the panel is local, but nothing from the socket is trusted blindly.
const SETTING_RULES = {
  title: v => String(v).slice(0, 40), subtitle: v => String(v).slice(0, 60),
  voice: v => ['vi-VN-NamMinhNeural', 'vi-VN-HoaiMyNeural'].includes(v) ? v : settings.voice,
  pitch: v => clamp(v, -50, 50), rate: v => clamp(v, -50, 50), moBpm: v => clamp(v, 20, 120), chantEveryMin: v => clamp(v, 1, 60),
  music: Boolean, mo: Boolean, autoChant: Boolean, joinOnEnter: Boolean, ambient: Boolean, ambientEvery: v => clamp(v, 3, 120),
  schedule: v => String(v ?? '').slice(0, 2000), meditateMin: v => clamp(v, 1, 60),
  seatMode: v => ['auto', '24', '36', '64', '100'].includes(String(v)) ? String(v) : 'auto',
  goalTarget: v => clamp(v, 100, 10_000_000),
  likeZoom: v => clamp(v, 10, 100_000),
  likeRush: v => clamp(v, 50, 1_000_000),
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
function applySettings(o){ for (const [k, fn] of Object.entries(SETTING_RULES)) if (k in o) settings[k] = fn(o[k]); }

/* ----------------------------------------------------------------- bots */
let botTimer = null;
const BOT_LINES = ['Nam mô A Di Đà Phật', 'Nam mô Bổn Sư Thích Ca Mâu Ni Phật', 'Cầu cho gia đình bình an', 'Con xin thành tâm sám hối', 'nữ', 'nam', 'bà',
  'Nguyện cầu cha mẹ mạnh khỏe', 'Mô Phật, an lạc quá', 'Chúc mọi người một ngày bình an', 'sư', 'Cầu công việc hanh thông',
  'xin lộc', 'cầu an gia đình', 'cầu siêu ông bà nội', 'mất ví', 'meo', 'A di đà phật', 'gõ mõ', 'gõ mõ', 'xin xăm', 'cầu duyên', 'cầu tài lộc cho mẹ', 'cầu thi đỗ cho con', 'cầu sức khỏe bố', 'sinh nhật Lan', 'gâu', 'hiu'];
function setBots(on, n, pace){
  clearInterval(botTimer); botTimer = null;
  if (on){
    n = clamp(n, 1, 100);
    for (let i = 0; i < n; i++) seat('bot_' + i, DEMO_NAMES[(i + 7) % DEMO_NAMES.length], { demo: true });
    const every = { slow: 4000, mid: 1800, fast: 700 }[pace] || 1800;
    botTimer = setInterval(() => {
      const ids = [...viewers.keys()].filter(id => id.startsWith('bot_')); if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)], v = viewers.get(id), r = Math.random();
      if (r < .62) onChat(id, v.name, BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)]);
      else onLike(id, 1 + Math.floor(Math.random() * 4));
      // no simulated gifts: with no "bot" label they would read as real donations to the audience
    }, every);
    addLog(`🤖 Bật ${n} bot, nhịp ${pace}`);
  } else {
    for (const id of [...viewers.keys()]) if (id.startsWith('bot_')) { viewers.delete(id); broadcast({ t:'leave', id }); }
    addLog('🤖 Tắt bot');
  }
  broadcast({ t:'bots', on }, 'control');
}

/* -------------------------------------------------------------- server */
// Security notes (this file is meant to be shared publicly):
//  • listens on 127.0.0.1 only; nothing is reachable from the LAN or internet unless HOST is changed on purpose
//  • Host header must be localhost/127.0.0.1 (blocks DNS-rebinding pages from talking to the server)
//  • WebSocket only accepts pages served by this server (Origin check), so other sites open in the
//    same browser cannot send control commands
//  • static files: only /assets and /live, no dot-files, no node_modules, no server source, no path escapes
//  • no TikTok password, cookie or session is ever used or stored; only public room events are read
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.mp3':'audio/mpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const okHost = h => ALLOWED_HOSTS.has(String(h || '').toLowerCase());
const SEP = path.sep;
function resolveStatic(urlPath){
  let p = urlPath === '/' ? '/live/control.html' : urlPath;
  if (!/^\/(assets|live)\//.test(p)) return null;
  if (p.split('/').some(seg => seg.startsWith('.') || seg === 'node_modules')) return null;
  if (/\.(mjs|json|md|log)$/i.test(p) && !p.startsWith('/assets/')) return null;      // never serve server code / package files
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + SEP)) return null;
  return file;
}
const server = http.createServer((req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(421).end('wrong host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  const file = resolveStatic(p);
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/live/tts/') ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!okHost(req.headers.host)) return false;
    if (!origin) return true;                                   // OBS / non-browser clients send no Origin
    try { return okHost(new URL(origin).host); } catch { return false; }
  } });
function broadcast(msg, only){ const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1 && (!only || c.role === only)) c.send(s); }
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'control' ? 'control' : 'overlay';
  ws.send(JSON.stringify(snapshot()));
  if (ws.role === 'control') ws.send(JSON.stringify({ t:'logs', lines: log }));
  ws.on('message', buf => {
    if (ws.role !== 'control') return;                          // overlays only listen
    try { const m = JSON.parse(buf); if (m && m.t === 'ctl') onControl(m); } catch (e) { addLog('Lệnh lỗi: ' + e.message); }
  });
});
server.listen(PORT, HOST, () => addLog(`Server chạy tại http://localhost:${PORT}  ·  Bảng điều khiển: http://localhost:${PORT}/live/control.html  ·  Overlay: http://localhost:${PORT}/live/overlay.html`));
