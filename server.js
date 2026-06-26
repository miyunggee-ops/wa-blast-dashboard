// WA Blast Dashboard v3 - WA Pool + OTP Login
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino    = require('pino');
const express = require('express');
const session = require('express-session');
const http    = require('http');
const { Server } = require('socket.io');
const fs      = require('fs');
const path    = require('path');
const qrcode  = require('qrcode');
const bcrypt  = require('bcryptjs');
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT           = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'wa-blast-secret-2026';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ─── Pastikan folder ada ──────────────────────────────────────────────────────
if (!fs.existsSync('data'))    fs.mkdirSync('data',    { recursive: true });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads', { recursive: true });

// ─── Helper JSON ─────────────────────────────────────────────────────────────
function readJSON(file)       { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } }
function writeJSON(file, data){ fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ─── Seed data ────────────────────────────────────────────────────────────────
function seedData() {
    let users = readJSON('data/users.json');
    if (!fs.existsSync('data/licenses.json')) writeJSON('data/licenses.json', [
        { key: 'STARTER-DEMO-2026', plan: 'Starter', quotaHarian: 500,  durasiHari: 30, usedBy: null, usedAt: null, createdAt: new Date().toISOString() },
        { key: 'PRO-DEMO-2026',     plan: 'Pro',     quotaHarian: 2000, durasiHari: 30, usedBy: null, usedAt: null, createdAt: new Date().toISOString() }
    ]);
    if (!fs.existsSync('data/wa-pool.json')) writeJSON('data/wa-pool.json', []);
    const freshHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    const adminIdx  = users.findIndex(u => u.id === 'admin-001' || u.username === ADMIN_USERNAME);
    if (adminIdx === -1) {
        users.unshift({ id: 'admin-001', username: ADMIN_USERNAME, password: freshHash, role: 'admin', licenseKey: 'ADMIN-FREE-FOREVER', licenseActive: true, licenseExpiry: null, plan: 'Admin', quotaHarian: 999999, quotaTerpakai: 0, lastReset: '', assignedWA: null, createdAt: new Date().toISOString() });
    } else {
        users[adminIdx].password = freshHash;
        users[adminIdx].role = 'admin';
        users[adminIdx].licenseActive = true;
        users[adminIdx].quotaHarian = 999999;
        if (!users[adminIdx].assignedWA) users[adminIdx].assignedWA = null;
    }
    writeJSON('data/users.json', users);
    console.log(`📌 Admin synced: ${ADMIN_USERNAME}`);
}
seedData();

// ─── Multer ───────────────────────────────────────────────────────────────────
const upload = multer({ dest: 'uploads/', fileFilter: (req, file, cb) => { const ext = path.extname(file.originalname).toLowerCase(); ['.txt','.csv'].includes(ext) ? cb(null,true) : cb(new Error('Hanya .txt/.csv')); }, limits: { fileSize: 2*1024*1024 } });

// ─── Session ──────────────────────────────────────────────────────────────────
const sessionMiddleware = session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 24*60*60*1000 } });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use('/dashboard', express.static(path.join(__dirname, 'public')));
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireLogin(req, res, next) { if (!req.session.userId) return res.status(401).json({ success: false, error: 'Login dulu!' }); next(); }
function requireAdmin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ success: false, error: 'Login dulu!' });
    const user = readJSON('data/users.json').find(u => u.id === req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ success: false, error: 'Akses ditolak!' });
    next();
}

// ─── WA Pool store (in-memory socks) ─────────────────────────────────────────
// poolSessions[poolId] = { sock, status, otpResolve }
const poolSessions = {};

function getPoolSession(poolId) {
    if (!poolSessions[poolId]) poolSessions[poolId] = { sock: null, status: 'disconnected', otpResolve: null };
    return poolSessions[poolId];
}

// ─── Per-user blast sessions ──────────────────────────────────────────────────
const sessions = {};
function getUserSession(userId) {
    if (!sessions[userId]) sessions[userId] = { sock: null, status: 'disconnected', isBlasting: false, blastLog: [], inbox: [], poolId: null };
    return sessions[userId];
}

function cekResetQuota(user) {
    const hari = new Date().toDateString();
    if (user.lastReset !== hari) { user.quotaTerpakai = 0; user.lastReset = hari; }
    return user;
}

// ─── Connect WA Pool via OTP ──────────────────────────────────────────────────
async function connectPoolOTP(poolId, nomor) {
    const ps = getPoolSession(poolId);
    if (ps.status === 'connected' || ps.status === 'connecting') return;
    ps.status = 'connecting';

    const sesiDir = `sesi_pool_${poolId}`;
    const { version }          = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sesiDir);

    ps.sock = makeWASocket({
        version, auth: state, printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
    });

    ps.sock.ev.on('creds.update', saveCreds);

    // Request OTP
    try {
        const nomorBersih = nomor.replace(/\D/g, '');
        await ps.sock.requestPairingCode(nomorBersih);
        ps.status = 'otp_sent';
        io.to(`admin`).emit('pool-otp-sent', { poolId, nomor });
    } catch(e) {
        ps.status = 'disconnected';
        io.to(`admin`).emit('pool-error', { poolId, error: e.message });
        return;
    }

    ps.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            ps.status = 'disconnected';
            const kode = lastDisconnect?.error?.output?.statusCode;
            if (kode !== DisconnectReason.loggedOut) {
                setTimeout(() => reconnectPool(poolId), 5000);
            } else {
                // Update pool status
                const pool = readJSON('data/wa-pool.json');
                const idx  = pool.findIndex(p => p.id === poolId);
                if (idx !== -1) { pool[idx].status = 'expired'; writeJSON('data/wa-pool.json', pool); }
                io.to('admin').emit('pool-status', { poolId, status: 'expired' });
            }
        }
        if (connection === 'open') {
            ps.status = 'connected';
            const nomorWA = ps.sock.user?.id?.split(':')[0] || nomor;
            // Update pool record
            const pool = readJSON('data/wa-pool.json');
            const idx  = pool.findIndex(p => p.id === poolId);
            if (idx !== -1) { pool[idx].status = 'connected'; pool[idx].nomor = nomorWA; writeJSON('data/wa-pool.json', pool); }
            io.to('admin').emit('pool-status', { poolId, status: 'connected', nomor: nomorWA });
            // Kirim status ke semua user yang assign nomor ini
            const users = readJSON('data/users.json');
            users.filter(u => u.assignedWA === poolId).forEach(u => {
                const ses = getUserSession(u.id);
                ses.sock   = ps.sock;
                ses.status = 'connected';
                ses.poolId = poolId;
                io.to(`user:${u.id}`).emit('status', { status: 'connected', msg: `✅ Terhubung: ${nomorWA}` });
            });
        }
    });

    ps.sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const from = msg.key.remoteJid?.replace('@s.whatsapp.net','') || '';
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[Media]';
            const time = new Date().toLocaleTimeString('id-ID');
            const item = { from, text, time };
            // Forward ke semua user yang pakai nomor ini
            const users = readJSON('data/users.json');
            users.filter(u => u.assignedWA === poolId).forEach(u => {
                const ses = getUserSession(u.id);
                ses.inbox.unshift(item);
                if (ses.inbox.length > 100) ses.inbox.pop();
                io.to(`user:${u.id}`).emit('inbox', item);
            });
        }
    });
}

async function reconnectPool(poolId) {
    const pool = readJSON('data/wa-pool.json');
    const p    = pool.find(p => p.id === poolId);
    if (!p || p.status === 'expired') return;
    const ps = getPoolSession(poolId);
    if (ps.status === 'connected') return;
    ps.status = 'disconnected';
    // reconnect pakai sesi yang sudah ada (tanpa OTP lagi)
    await connectPoolReuse(poolId);
}

async function connectPoolReuse(poolId) {
    const ps = getPoolSession(poolId);
    if (ps.status === 'connected' || ps.status === 'connecting') return;
    ps.status = 'connecting';
    const sesiDir = `sesi_pool_${poolId}`;
    if (!fs.existsSync(sesiDir)) return;
    const { version }          = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sesiDir);
    const pool   = readJSON('data/wa-pool.json');
    const poolRec = pool.find(p => p.id === poolId);
    const nomor  = poolRec?.nomor || '';
    ps.sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'), syncFullHistory: false });
    ps.sock.ev.on('creds.update', saveCreds);
    ps.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            ps.status = 'disconnected';
            const kode = lastDisconnect?.error?.output?.statusCode;
            if (kode !== DisconnectReason.loggedOut) setTimeout(() => connectPoolReuse(poolId), 5000);
            else {
                const pool2 = readJSON('data/wa-pool.json');
                const idx2  = pool2.findIndex(p => p.id === poolId);
                if (idx2 !== -1) { pool2[idx2].status = 'expired'; writeJSON('data/wa-pool.json', pool2); }
                io.to('admin').emit('pool-status', { poolId, status: 'expired' });
            }
        }
        if (connection === 'open') {
            ps.status = 'connected';
            const nomorWA = ps.sock.user?.id?.split(':')[0] || nomor;
            const pool2 = readJSON('data/wa-pool.json');
            const idx2  = pool2.findIndex(p => p.id === poolId);
            if (idx2 !== -1) { pool2[idx2].status = 'connected'; pool2[idx2].nomor = nomorWA; writeJSON('data/wa-pool.json', pool2); }
            io.to('admin').emit('pool-status', { poolId, status: 'connected', nomor: nomorWA });
            const users = readJSON('data/users.json');
            users.filter(u => u.assignedWA === poolId).forEach(u => {
                const ses = getUserSession(u.id);
                ses.sock   = ps.sock;
                ses.status = 'connected';
                ses.poolId = poolId;
                io.to(`user:${u.id}`).emit('status', { status: 'connected', msg: `✅ Terhubung: ${nomorWA}` });
            });
        }
    });
    ps.sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const from = msg.key.remoteJid?.replace('@s.whatsapp.net','') || '';
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[Media]';
            const time = new Date().toLocaleTimeString('id-ID');
            const item = { from, text, time };
            const users = readJSON('data/users.json');
            users.filter(u => u.assignedWA === poolId).forEach(u => {
                const ses = getUserSession(u.id);
                ses.inbox.unshift(item);
                if (ses.inbox.length > 100) ses.inbox.pop();
                io.to(`user:${u.id}`).emit('inbox', item);
            });
        }
    });
}

// ─── Auto-reconnect pool saat startup ────────────────────────────────────────
function autoReconnectPool() {
    const pool = readJSON('data/wa-pool.json');
    pool.filter(p => p.status === 'connected').forEach(p => {
        console.log(`🔄 Reconnect pool: ${p.nomor}`);
        connectPoolReuse(p.id);
    });
}

// ─── Routes: Pages ───────────────────────────────────────────────────────────
app.get('/', (req, res) => { if (req.session.userId) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/dashboard', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ─── Routes: Auth ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Username & password wajib diisi!' });
    const users = readJSON('data/users.json');
    if (users.find(u => u.username === username)) return res.json({ success: false, error: 'Username sudah dipakai!' });
    const hashed = await bcrypt.hash(password, 10);
    users.push({ id: uuidv4(), username, password: hashed, role: 'user', licenseKey: null, licenseActive: false, licenseExpiry: null, plan: null, quotaHarian: 0, quotaTerpakai: 0, lastReset: '', assignedWA: null, createdAt: new Date().toISOString() });
    writeJSON('data/users.json', users);
    res.json({ success: true, msg: 'Akun berhasil dibuat! Silakan login.' });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const users = readJSON('data/users.json');
    const user  = users.find(u => u.username === username);
    if (!user) return res.json({ success: false, error: 'Username tidak ditemukan!' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ success: false, error: 'Password salah!' });
    req.session.userId = user.id; req.session.username = user.username; req.session.role = user.role;
    res.json({ success: true, role: user.role });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/me', requireLogin, (req, res) => {
    const users = readJSON('data/users.json');
    const user  = users.find(u => u.id === req.session.userId);
    if (!user) return res.json({ success: false });
    cekResetQuota(user); writeJSON('data/users.json', users);
    const pool   = readJSON('data/wa-pool.json');
    const waPool = user.assignedWA ? pool.find(p => p.id === user.assignedWA) : null;
    res.json({ success: true, userId: user.id, username: user.username, role: user.role, licenseActive: user.licenseActive, licenseExpiry: user.licenseExpiry, plan: user.plan || '-', quotaHarian: user.quotaHarian, quotaTerpakai: user.quotaTerpakai, sisaQuota: Math.max(0, user.quotaHarian - user.quotaTerpakai), assignedWA: user.assignedWA, assignedNomor: waPool?.nomor || null });
});

// ─── Routes: Lisensi ─────────────────────────────────────────────────────────
app.post('/api/aktivasi', requireLogin, (req, res) => {
    const { key } = req.body;
    if (!key) return res.json({ success: false, error: 'Key tidak boleh kosong!' });
    const licenses = readJSON('data/licenses.json');
    const lic = licenses.find(l => l.key === key.trim().toUpperCase());
    if (!lic)       return res.json({ success: false, error: 'Key tidak ditemukan!' });
    if (lic.usedBy) return res.json({ success: false, error: 'Key sudah dipakai!' });
    const users = readJSON('data/users.json');
    const idx   = users.findIndex(u => u.id === req.session.userId);
    const expiry = new Date(); expiry.setDate(expiry.getDate() + lic.durasiHari);
    users[idx] = { ...users[idx], licenseKey: key, licenseActive: true, licenseExpiry: expiry.toISOString(), quotaHarian: lic.quotaHarian, plan: lic.plan };
    writeJSON('data/users.json', users);
    lic.usedBy = req.session.userId; lic.usedAt = new Date().toISOString();
    writeJSON('data/licenses.json', licenses);
    res.json({ success: true, msg: `✅ Lisensi ${lic.plan} aktif! Berlaku ${lic.durasiHari} hari. Quota: ${lic.quotaHarian}/hari.` });
});

// ─── Routes: WA Pool (Admin) ──────────────────────────────────────────────────
// GET semua pool
app.get('/api/admin/wa-pool', requireAdmin, (req, res) => res.json(readJSON('data/wa-pool.json')));

// Tambah nomor ke pool + request OTP
app.post('/api/admin/wa-pool/add', requireAdmin, async (req, res) => {
    const { nomor } = req.body;
    if (!nomor) return res.json({ success: false, error: 'Nomor wajib diisi!' });
    const nomorBersih = nomor.replace(/\D/g,'');
    if (!/^62\d{8,13}$/.test(nomorBersih)) return res.json({ success: false, error: 'Format nomor salah! Awali 62.' });
    const pool = readJSON('data/wa-pool.json');
    if (pool.find(p => p.nomor === nomorBersih)) return res.json({ success: false, error: 'Nomor sudah ada di pool!' });
    const poolId = uuidv4();
    pool.push({ id: poolId, nomor: nomorBersih, status: 'pending', assignedTo: null, createdAt: new Date().toISOString() });
    writeJSON('data/wa-pool.json', pool);
    res.json({ success: true, poolId, msg: `Nomor ditambahkan. Mengirim OTP ke ${nomorBersih}...` });
    // connect async
    connectPoolOTP(poolId, nomorBersih);
});

// Submit OTP
app.post('/api/admin/wa-pool/otp', requireAdmin, async (req, res) => {
    const { poolId, otp } = req.body;
    if (!poolId || !otp) return res.json({ success: false, error: 'poolId dan OTP wajib diisi!' });
    const ps = getPoolSession(poolId);
    if (!ps.sock) return res.json({ success: false, error: 'Sesi tidak ditemukan!' });
    try {
        // Baileys pairing code: masukkan OTP sebagai pairing code
        // OTP sudah dikirim saat add, user tinggal tunggu connected
        res.json({ success: true, msg: 'OTP diterima. Menunggu konfirmasi WhatsApp...' });
    } catch(e) {
        res.json({ success: false, error: e.message });
    }
});

// Hapus nomor dari pool
app.delete('/api/admin/wa-pool/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    let pool = readJSON('data/wa-pool.json');
    const ps = getPoolSession(id);
    if (ps.sock) { try { ps.sock.end(); } catch(e) {} delete poolSessions[id]; }
    pool = pool.filter(p => p.id !== id);
    writeJSON('data/wa-pool.json', pool);
    // unassign users
    const users = readJSON('data/users.json');
    users.forEach(u => { if (u.assignedWA === id) { u.assignedWA = null; const ses = getUserSession(u.id); ses.status = 'disconnected'; ses.sock = null; io.to(`user:${u.id}`).emit('status', { status: 'disconnected', msg: 'Nomor WA dicabut admin.' }); } });
    writeJSON('data/users.json', users);
    res.json({ success: true });
});

// Assign nomor ke user
app.post('/api/admin/wa-pool/assign', requireAdmin, (req, res) => {
    const { poolId, userId } = req.body;
    if (!poolId || !userId) return res.json({ success: false, error: 'poolId dan userId wajib!' });
    const pool = readJSON('data/wa-pool.json');
    const p    = pool.find(p => p.id === poolId);
    if (!p) return res.json({ success: false, error: 'Pool tidak ditemukan!' });
    if (p.status !== 'connected') return res.json({ success: false, error: 'Nomor belum connected!' });
    const users = readJSON('data/users.json');
    const idx   = users.findIndex(u => u.id === userId);
    if (idx === -1) return res.json({ success: false, error: 'User tidak ditemukan!' });
    // Unassign dari user lain kalau ada
    users.forEach(u => { if (u.assignedWA === poolId && u.id !== userId) u.assignedWA = null; });
    users[idx].assignedWA = poolId;
    writeJSON('data/users.json', users);
    // Update pool record
    const pidx = pool.findIndex(p => p.id === poolId);
    pool[pidx].assignedTo = userId;
    writeJSON('data/wa-pool.json', pool);
    // Langsung set ses user
    const ps  = getPoolSession(poolId);
    const ses = getUserSession(userId);
    ses.sock   = ps.sock;
    ses.status = ps.status;
    ses.poolId = poolId;
    io.to(`user:${userId}`).emit('status', { status: ps.status, msg: ps.status === 'connected' ? `✅ Terhubung: ${p.nomor}` : 'Menghubungkan...' });
    res.json({ success: true, msg: `✅ Nomor ${p.nomor} di-assign ke ${users[idx].username}` });
});

// Unassign nomor dari user
app.post('/api/admin/wa-pool/unassign', requireAdmin, (req, res) => {
    const { userId } = req.body;
    const users = readJSON('data/users.json');
    const idx   = users.findIndex(u => u.id === userId);
    if (idx === -1) return res.json({ success: false, error: 'User tidak ditemukan!' });
    users[idx].assignedWA = null;
    writeJSON('data/users.json', users);
    const ses = getUserSession(userId);
    ses.sock   = null; ses.status = 'disconnected'; ses.poolId = null;
    io.to(`user:${userId}`).emit('status', { status: 'disconnected', msg: 'Nomor WA dicabut.' });
    res.json({ success: true });
});

// ─── Routes: Admin lainnya ────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
    const pool  = readJSON('data/wa-pool.json');
    res.json(readJSON('data/users.json').map(u => { const wp = u.assignedWA ? pool.find(p=>p.id===u.assignedWA) : null; return { id: u.id, username: u.username, role: u.role, plan: u.plan||'-', licenseActive: u.licenseActive, licenseExpiry: u.licenseExpiry, quotaHarian: u.quotaHarian, quotaTerpakai: u.quotaTerpakai, assignedWA: u.assignedWA, assignedNomor: wp?.nomor||null, createdAt: u.createdAt }; }));
});

app.post('/api/admin/generate-key', requireAdmin, (req, res) => {
    const { plan, quotaHarian, durasiHari } = req.body;
    if (!plan || !quotaHarian || !durasiHari) return res.json({ success: false, error: 'Lengkapi semua field!' });
    const key = `${plan.toUpperCase()}-${uuidv4().slice(0,8).toUpperCase()}`;
    const licenses = readJSON('data/licenses.json');
    licenses.push({ key, plan, quotaHarian: parseInt(quotaHarian), durasiHari: parseInt(durasiHari), usedBy: null, usedAt: null, createdAt: new Date().toISOString() });
    writeJSON('data/licenses.json', licenses);
    res.json({ success: true, key });
});

app.get('/api/admin/licenses', requireAdmin, (req, res) => res.json(readJSON('data/licenses.json')));

// ─── Routes: WA (user) ───────────────────────────────────────────────────────
app.get('/api/status', requireLogin, (req, res) => {
    const users  = readJSON('data/users.json');
    const user   = users.find(u => u.id === req.session.userId);
    const poolId = user?.assignedWA;
    if (poolId) {
        const ps = getPoolSession(poolId);
        const pool = readJSON('data/wa-pool.json');
        const p    = pool.find(p => p.id === poolId);
        return res.json({ status: ps.status, nomor: p?.nomor || '-', mode: 'pool' });
    }
    const ses = getUserSession(req.session.userId);
    res.json({ status: ses.status, nomor: ses.sock?.user?.id?.split(':')[0]||'-', mode: 'personal' });
});

app.get('/api/inbox',     requireLogin, (req,res) => res.json(getUserSession(req.session.userId).inbox));
app.get('/api/blast-log', requireLogin, (req,res) => res.json(getUserSession(req.session.userId).blastLog));

app.post('/api/blast', requireLogin, async (req, res) => {
    const users = readJSON('data/users.json');
    const user  = users.find(u => u.id === req.session.userId);
    if (!user)              return res.json({ success: false, error: 'User tidak ditemukan!' });
    if (!user.licenseActive) return res.json({ success: false, error: 'Aktifkan lisensi dulu!' });
    if (user.licenseExpiry && new Date() > new Date(user.licenseExpiry)) return res.json({ success: false, error: 'Lisensi expired!' });

    // Tentukan sock yang dipakai
    let sock;
    if (user.assignedWA) {
        const ps = getPoolSession(user.assignedWA);
        if (ps.status !== 'connected') return res.json({ success: false, error: 'Nomor WA pool belum connected!' });
        sock = ps.sock;
    } else {
        const ses = getUserSession(req.session.userId);
        if (ses.status !== 'connected') return res.json({ success: false, error: 'WA belum terhubung!' });
        sock = ses.sock;
    }

    const ses = getUserSession(req.session.userId);
    if (ses.isBlasting) return res.json({ success: false, error: 'Blast sedang berjalan!' });

    const { nomor, pesan } = req.body;
    if (!nomor || !pesan) return res.json({ success: false, error: 'Nomor dan pesan wajib diisi!' });
    const allNomor = nomor.split('\n').map(n=>n.trim()).filter(n=>/^62\d{8,13}$/.test(n));
    if (!allNomor.length) return res.json({ success: false, error: 'Tidak ada nomor valid!' });
    cekResetQuota(user);
    const sisa = user.quotaHarian - user.quotaTerpakai;
    if (sisa <= 0) return res.json({ success: false, error: 'Quota harian habis!' });
    const blastNomor = allNomor.slice(0, sisa);
    ses.blastLog = []; ses.isBlasting = true;
    res.json({ success: true, total: blastNomor.length, catatan: blastNomor.length < allNomor.length ? `Hanya ${blastNomor.length} dari ${allNomor.length} dikirim (sisa quota)` : null });
    jalankanBlast(req.session.userId, sock, pesan, blastNomor);
});

app.post('/api/blast/stop', requireLogin, (req, res) => {
    getUserSession(req.session.userId).isBlasting = false;
    io.to(`user:${req.session.userId}`).emit('blast-stopped', {});
    res.json({ success: true });
});

app.post('/api/reset-sesi', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const users  = readJSON('data/users.json');
    const user   = users.find(u => u.id === userId);
    if (user?.assignedWA) return res.json({ success: false, error: 'Kamu pakai nomor pool. Hubungi admin untuk reset.' });
    const ses = getUserSession(userId);
    try {
        if (ses.sock) { try { ses.sock.end(); } catch(e){} ses.sock = null; }
        ses.status = 'disconnected';
        fs.rmSync(`sesi_${userId}`, { recursive: true, force: true });
        res.json({ success: true, msg: 'Sesi dihapus. Menghubungkan ulang...' });
        setTimeout(() => connectPersonal(userId), 1500);
    } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Connect WA personal (scan QR) ───────────────────────────────────────────
async function connectPersonal(userId) {
    const ses = getUserSession(userId);
    if (ses.status === 'connected' || ses.status === 'connecting') return;
    ses.status = 'connecting';
    const { version }          = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(`sesi_${userId}`);
    ses.sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'), syncFullHistory: false });
    ses.sock.ev.on('creds.update', saveCreds);
    ses.sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) { ses.status = 'qr'; const qrImage = await qrcode.toDataURL(qr); io.to(`user:${userId}`).emit('qr', qrImage); io.to(`user:${userId}`).emit('status', { status: 'qr', msg: 'Scan QR Code' }); }
        if (connection === 'close') { ses.status = 'disconnected'; const kode = lastDisconnect?.error?.output?.statusCode; if (kode !== DisconnectReason.loggedOut) { io.to(`user:${userId}`).emit('status', { status: 'disconnected', msg: 'Terputus, mencoba ulang...' }); setTimeout(() => connectPersonal(userId), 5000); } else { io.to(`user:${userId}`).emit('status', { status: 'disconnected', msg: 'Session expired! Reset sesi.' }); } }
        if (connection === 'open') { ses.status = 'connected'; const n = ses.sock.user?.id?.split(':')[0]||'-'; io.to(`user:${userId}`).emit('qr', null); io.to(`user:${userId}`).emit('status', { status: 'connected', msg: `✅ Terhubung: ${n}` }); }
    });
    ses.sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const from = msg.key.remoteJid?.replace('@s.whatsapp.net','') || '';
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[Media]';
            const item = { from, text, time: new Date().toLocaleTimeString('id-ID') };
            ses.inbox.unshift(item); if (ses.inbox.length > 100) ses.inbox.pop();
            io.to(`user:${userId}`).emit('inbox', item);
        }
    });
}

app.post('/api/upload-nomor', requireLogin, upload.single('file'), (req, res) => {
    try {
        const content = fs.readFileSync(req.file.path, 'utf8'); fs.unlinkSync(req.file.path);
        const unique = [...new Set(content.split(/[\n,;]+/).map(n=>n.replace(/\D/g,'')).filter(n=>/^62\d{8,13}$/.test(n)))];
        res.json({ success: true, nomor: unique, total: unique.length });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Blast worker ─────────────────────────────────────────────────────────────
async function jalankanBlast(userId, sock, pesan, numbers) {
    const ses = getUserSession(userId);
    io.to(`user:${userId}`).emit('blast-start', { total: numbers.length });
    for (let i = 0; i < numbers.length; i++) {
        if (!ses.isBlasting) break;
        let status = 'gagal';
        try {
            await sock.sendMessage(`${numbers[i]}@s.whatsapp.net`, { text: pesan });
            status = 'sukses';
            const users = readJSON('data/users.json');
            const idx   = users.findIndex(u => u.id === userId);
            if (idx !== -1) { users[idx].quotaTerpakai = (users[idx].quotaTerpakai||0)+1; writeJSON('data/users.json', users); }
        } catch(err) {}
        const log = { no: numbers[i], status, index: i+1, total: numbers.length, time: new Date().toLocaleTimeString('id-ID') };
        ses.blastLog.push(log);
        io.to(`user:${userId}`).emit('blast-progress', log);
        if (i < numbers.length-1 && ses.isBlasting) await new Promise(r => setTimeout(r, Math.floor(Math.random()*4000)+4000));
    }
    ses.isBlasting = false;
    io.to(`user:${userId}`).emit('blast-done', { total: numbers.length, sukses: ses.blastLog.filter(l=>l.status==='sukses').length, gagal: ses.blastLog.filter(l=>l.status==='gagal').length });
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    const userId = socket.request.session?.userId;
    if (!userId) return;
    socket.join(`user:${userId}`);
    const users = readJSON('data/users.json');
    const user  = users.find(u => u.id === userId);
    // Join admin room kalau admin
    if (user?.role === 'admin') socket.join('admin');
    // Kirim status
    if (user?.assignedWA) {
        const ps   = getPoolSession(user.assignedWA);
        const pool = readJSON('data/wa-pool.json');
        const p    = pool.find(p => p.id === user.assignedWA);
        socket.emit('status', { status: ps.status, msg: ps.status === 'connected' ? `✅ Terhubung: ${p?.nomor||'-'}` : 'Menghubungkan...' });
        const ses = getUserSession(userId);
        if (ps.status === 'connected') { ses.sock = ps.sock; ses.status = 'connected'; ses.poolId = user.assignedWA; }
    } else {
        const ses = getUserSession(userId);
        socket.emit('status', { status: ses.status, msg: ses.status === 'connected' ? `✅ Terhubung: ${ses.sock?.user?.id?.split(':')[0]||'-'}` : ses.status === 'qr' ? 'Scan QR' : 'Menghubungkan...' });
        socket.emit('inbox-all', ses.inbox);
        if (ses.status === 'disconnected') connectPersonal(userId);
    }
    socket.on('join-me', () => {
        socket.join(`user:${userId}`);
        if (user?.role === 'admin') socket.join('admin');
    });
});

server.listen(PORT, () => {
    console.log(`\n🚀 WA Blast Dashboard v3 jalan di port ${PORT}`);
    console.log(`📌 Login: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
    setTimeout(autoReconnectPool, 3000);
});
