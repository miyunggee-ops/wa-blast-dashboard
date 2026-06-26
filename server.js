// WA Blast Dashboard v2 - Multi User + License + Upload CSV
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason
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

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'wa-blast-secret-2026';

// ─── ADMIN DEFAULT ────────────────────────────────────────────────────────────
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ─── Pastikan folder ada ──────────────────────────────────────────────────────
if (!fs.existsSync('data'))    fs.mkdirSync('data',    { recursive: true });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads', { recursive: true });

// ─── Helper: baca/tulis JSON ──────────────────────────────────────────────────
function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── Seed / sync data saat startup ───────────────────────────────────────────
function seedData() {
    // --- users.json ---
    let users = readJSON('data/users.json');

    // Buat licenses.json kalau belum ada
    if (!fs.existsSync('data/licenses.json')) {
        writeJSON('data/licenses.json', [
            { key: 'STARTER-DEMO-2026', plan: 'Starter', quotaHarian: 500,  durasiHari: 30, usedBy: null, usedAt: null, createdAt: new Date().toISOString() },
            { key: 'PRO-DEMO-2026',     plan: 'Pro',     quotaHarian: 2000, durasiHari: 30, usedBy: null, usedAt: null, createdAt: new Date().toISOString() }
        ]);
        console.log('📌 data/licenses.json dibuat');
    }

    // Cek apakah admin sudah ada
    const adminIdx = users.findIndex(u => u.id === 'admin-001' || u.username === ADMIN_USERNAME);

    // Selalu hash ulang password admin dari env/default
    const freshHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);

    if (adminIdx === -1) {
        // Admin belum ada → buat baru
        users.unshift({
            id:            'admin-001',
            username:      ADMIN_USERNAME,
            password:      freshHash,
            role:          'admin',
            licenseKey:    'ADMIN-FREE-FOREVER',
            licenseActive: true,
            licenseExpiry: null,
            plan:          'Admin',
            quotaHarian:   999999,
            quotaTerpakai: 0,
            lastReset:     '',
            createdAt:     new Date().toISOString()
        });
        console.log(`📌 Admin dibuat: ${ADMIN_USERNAME}`);
    } else {
        // Admin ada → update password & pastikan field lengkap
        users[adminIdx].password      = freshHash;
        users[adminIdx].role          = 'admin';
        users[adminIdx].licenseActive = true;
        users[adminIdx].quotaHarian   = 999999;
        users[adminIdx].plan          = users[adminIdx].plan || 'Admin';
        console.log(`📌 Password admin di-sync: ${ADMIN_USERNAME}`);
    }

    writeJSON('data/users.json', users);
}

seedData();

// ─── Multer upload ────────────────────────────────────────────────────────────
const upload = multer({
    dest: 'uploads/',
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.txt', '.csv'].includes(ext)) cb(null, true);
        else cb(new Error('Hanya file .txt atau .csv'));
    },
    limits: { fileSize: 2 * 1024 * 1024 }
});

// ─── Session middleware ───────────────────────────────────────────────────────
const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use('/dashboard', express.static(path.join(__dirname, 'public')));

// Share session dengan Socket.IO
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ success: false, error: 'Login dulu!' });
    next();
}
function requireAdmin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ success: false, error: 'Login dulu!' });
    const users = readJSON('data/users.json');
    const user  = users.find(u => u.id === req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ success: false, error: 'Akses ditolak!' });
    next();
}

// ─── Per-user WA session store ────────────────────────────────────────────────
const sessions = {};

function getUserSession(userId) {
    if (!sessions[userId]) {
        sessions[userId] = { sock: null, status: 'disconnected', isBlasting: false, blastLog: [], inbox: [], blastNumbers: [] };
    }
    return sessions[userId];
}

// ─── Reset quota harian ───────────────────────────────────────────────────────
function cekResetQuota(user) {
    const hari = new Date().toDateString();
    if (user.lastReset !== hari) { user.quotaTerpakai = 0; user.lastReset = hari; }
    return user;
}

// ─── Connect WA per user ──────────────────────────────────────────────────────
async function connectWA(userId) {
    const ses = getUserSession(userId);
    if (ses.status === 'connected' || ses.status === 'connecting') return;
    ses.status = 'connecting';

    const sesiDir = `sesi_${userId}`;
    const { version }          = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sesiDir);

    ses.sock = makeWASocket({
        version, auth: state, printQRInTerminal: false,
        logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'), syncFullHistory: false,
    });

    ses.sock.ev.on('creds.update', saveCreds);

    ses.sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
            ses.status = 'qr';
            const qrImage = await qrcode.toDataURL(qr);
            io.to(`user:${userId}`).emit('qr', qrImage);
            io.to(`user:${userId}`).emit('status', { status: 'qr', msg: 'Scan QR Code di bawah' });
        }
        if (connection === 'close') {
            ses.status = 'disconnected';
            const kode = lastDisconnect?.error?.output?.statusCode;
            if (kode === DisconnectReason.loggedOut) {
                io.to(`user:${userId}`).emit('status', { status: 'disconnected', msg: 'Session expired! Klik Reset Sesi.' });
            } else {
                io.to(`user:${userId}`).emit('status', { status: 'disconnected', msg: 'Koneksi terputus, mencoba ulang...' });
                setTimeout(() => connectWA(userId), 5000);
            }
        }
        if (connection === 'open') {
            ses.status = 'connected';
            const nomorWA = ses.sock.user?.id?.split(':')[0] || '-';
            io.to(`user:${userId}`).emit('qr', null);
            io.to(`user:${userId}`).emit('status', { status: 'connected', msg: `✅ Terhubung: ${nomorWA}` });
        }
    });

    ses.sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '[Media]';
            const time = new Date().toLocaleTimeString('id-ID');
            const item = { from, text, time };
            ses.inbox.unshift(item);
            if (ses.inbox.length > 100) ses.inbox.pop();
            io.to(`user:${userId}`).emit('inbox', item);
        }
    });
}

// ─── Routes: Auth ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/dashboard', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Username & password wajib diisi!' });
    const users = readJSON('data/users.json');
    if (users.find(u => u.username === username)) return res.json({ success: false, error: 'Username sudah dipakai!' });
    const hashed  = await bcrypt.hash(password, 10);
    users.push({ id: uuidv4(), username, password: hashed, role: 'user', licenseKey: null, licenseActive: false, licenseExpiry: null, plan: null, quotaHarian: 0, quotaTerpakai: 0, lastReset: '', createdAt: new Date().toISOString() });
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
    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.role     = user.role;
    res.json({ success: true, role: user.role });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/me', requireLogin, (req, res) => {
    const users = readJSON('data/users.json');
    const user  = users.find(u => u.id === req.session.userId);
    if (!user) return res.json({ success: false });
    const u = cekResetQuota(user);
    writeJSON('data/users.json', users);
    res.json({ success: true, userId: u.id, username: u.username, role: u.role, licenseActive: u.licenseActive, licenseExpiry: u.licenseExpiry, plan: u.plan || '-', quotaHarian: u.quotaHarian, quotaTerpakai: u.quotaTerpakai, sisaQuota: Math.max(0, u.quotaHarian - u.quotaTerpakai) });
});

// ─── Routes: Lisensi ─────────────────────────────────────────────────────────
app.post('/api/aktivasi', requireLogin, (req, res) => {
    const { key } = req.body;
    if (!key) return res.json({ success: false, error: 'Key tidak boleh kosong!' });
    const licenses = readJSON('data/licenses.json');
    const lic      = licenses.find(l => l.key === key.trim().toUpperCase());
    if (!lic)       return res.json({ success: false, error: 'Key tidak ditemukan!' });
    if (lic.usedBy) return res.json({ success: false, error: 'Key sudah dipakai!' });
    const users  = readJSON('data/users.json');
    const idx    = users.findIndex(u => u.id === req.session.userId);
    const expiry = new Date(); expiry.setDate(expiry.getDate() + lic.durasiHari);
    users[idx] = { ...users[idx], licenseKey: key, licenseActive: true, licenseExpiry: expiry.toISOString(), quotaHarian: lic.quotaHarian, plan: lic.plan };
    writeJSON('data/users.json', users);
    lic.usedBy = req.session.userId; lic.usedAt = new Date().toISOString();
    writeJSON('data/licenses.json', licenses);
    res.json({ success: true, msg: `✅ Lisensi ${lic.plan} aktif! Berlaku ${lic.durasiHari} hari. Quota: ${lic.quotaHarian}/hari.` });
});

// ─── Routes: Admin ────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
    res.json(readJSON('data/users.json').map(u => ({ id: u.id, username: u.username, role: u.role, plan: u.plan || '-', licenseActive: u.licenseActive, licenseExpiry: u.licenseExpiry, quotaHarian: u.quotaHarian, quotaTerpakai: u.quotaTerpakai, createdAt: u.createdAt })));
});

app.post('/api/admin/generate-key', requireAdmin, (req, res) => {
    const { plan, quotaHarian, durasiHari } = req.body;
    if (!plan || !quotaHarian || !durasiHari) return res.json({ success: false, error: 'Lengkapi semua field!' });
    const key      = `${plan.toUpperCase()}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const licenses = readJSON('data/licenses.json');
    licenses.push({ key, plan, quotaHarian: parseInt(quotaHarian), durasiHari: parseInt(durasiHari), usedBy: null, usedAt: null, createdAt: new Date().toISOString() });
    writeJSON('data/licenses.json', licenses);
    res.json({ success: true, key, msg: `Key baru: ${key}` });
});

app.get('/api/admin/licenses', requireAdmin, (req, res) => res.json(readJSON('data/licenses.json')));

// ─── Routes: WA ──────────────────────────────────────────────────────────────
app.get('/api/status',    requireLogin, (req, res) => { const ses = getUserSession(req.session.userId); res.json({ status: ses.status, nomor: ses.sock?.user?.id?.split(':')[0] || '-' }); });
app.get('/api/inbox',     requireLogin, (req, res) => res.json(getUserSession(req.session.userId).inbox));
app.get('/api/blast-log', requireLogin, (req, res) => res.json(getUserSession(req.session.userId).blastLog));

app.post('/api/blast', requireLogin, async (req, res) => {
    const users = readJSON('data/users.json');
    const user  = users.find(u => u.id === req.session.userId);
    if (!user)              return res.json({ success: false, error: 'User tidak ditemukan!' });
    if (!user.licenseActive) return res.json({ success: false, error: 'Aktifkan lisensi dulu!' });
    if (user.licenseExpiry && new Date() > new Date(user.licenseExpiry)) return res.json({ success: false, error: 'Lisensi expired!' });
    const ses = getUserSession(req.session.userId);
    if (ses.status !== 'connected') return res.json({ success: false, error: 'WA belum terhubung!' });
    if (ses.isBlasting)             return res.json({ success: false, error: 'Blast sedang berjalan!' });
    const { nomor, pesan } = req.body;
    if (!nomor || !pesan) return res.json({ success: false, error: 'Nomor dan pesan wajib diisi!' });
    const allNomor = nomor.split('\n').map(n => n.trim()).filter(n => /^62\d{8,13}$/.test(n));
    if (!allNomor.length) return res.json({ success: false, error: 'Tidak ada nomor valid! Awali dengan 62.' });
    cekResetQuota(user);
    const sisa = user.quotaHarian - user.quotaTerpakai;
    if (sisa <= 0) return res.json({ success: false, error: `Quota harian habis! Reset besok.` });
    const blastNomor = allNomor.slice(0, sisa);
    ses.blastLog = []; ses.isBlasting = true;
    res.json({ success: true, total: blastNomor.length, catatan: blastNomor.length < allNomor.length ? `Hanya ${blastNomor.length} dari ${allNomor.length} dikirim (sisa quota)` : null });
    jalankanBlast(req.session.userId, pesan, blastNomor);
});

app.post('/api/blast/stop', requireLogin, (req, res) => {
    getUserSession(req.session.userId).isBlasting = false;
    io.to(`user:${req.session.userId}`).emit('blast-stopped', {});
    res.json({ success: true });
});

app.post('/api/reset-sesi', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const ses    = getUserSession(userId);
    try {
        if (ses.sock) { try { ses.sock.end(); } catch(e) {} ses.sock = null; }
        ses.status = 'disconnected';
        fs.rmSync(`sesi_${userId}`, { recursive: true, force: true });
        res.json({ success: true, msg: 'Sesi dihapus. Menghubungkan ulang...' });
        setTimeout(() => connectWA(userId), 1500);
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/upload-nomor', requireLogin, upload.single('file'), (req, res) => {
    try {
        const content = fs.readFileSync(req.file.path, 'utf8');
        fs.unlinkSync(req.file.path);
        const unique = [...new Set(content.split(/[\n,;]+/).map(n => n.replace(/\D/g, '')).filter(n => /^62\d{8,13}$/.test(n)))];
        res.json({ success: true, nomor: unique, total: unique.length });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── Blast worker ─────────────────────────────────────────────────────────────
async function jalankanBlast(userId, pesan, numbers) {
    const ses = getUserSession(userId);
    io.to(`user:${userId}`).emit('blast-start', { total: numbers.length });
    for (let i = 0; i < numbers.length; i++) {
        if (!ses.isBlasting) break;
        let status = 'gagal';
        try {
            await ses.sock.sendMessage(`${numbers[i]}@s.whatsapp.net`, { text: pesan });
            status = 'sukses';
            const users = readJSON('data/users.json');
            const idx   = users.findIndex(u => u.id === userId);
            if (idx !== -1) { users[idx].quotaTerpakai = (users[idx].quotaTerpakai || 0) + 1; writeJSON('data/users.json', users); }
        } catch (err) {}
        const log = { no: numbers[i], status, index: i + 1, total: numbers.length, time: new Date().toLocaleTimeString('id-ID') };
        ses.blastLog.push(log);
        io.to(`user:${userId}`).emit('blast-progress', log);
        if (i < numbers.length - 1 && ses.isBlasting) await new Promise(r => setTimeout(r, Math.floor(Math.random() * 4000) + 4000));
    }
    ses.isBlasting = false;
    io.to(`user:${userId}`).emit('blast-done', { total: numbers.length, sukses: ses.blastLog.filter(l => l.status === 'sukses').length, gagal: ses.blastLog.filter(l => l.status === 'gagal').length });
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    const userId = socket.request.session?.userId;
    if (!userId) return;
    socket.join(`user:${userId}`);
    const ses = getUserSession(userId);
    socket.emit('status', { status: ses.status, msg: ses.status === 'connected' ? `✅ Terhubung: ${ses.sock?.user?.id?.split(':')[0] || '-'}` : ses.status === 'qr' ? 'Scan QR Code' : 'Menghubungkan...' });
    socket.emit('inbox-all', ses.inbox);
    if (ses.status === 'disconnected') connectWA(userId);
    socket.on('join-me', () => { socket.join(`user:${userId}`); if (ses.status === 'disconnected') connectWA(userId); });
});

server.listen(PORT, () => {
    console.log(`\n🚀 WA Blast Dashboard v2 jalan di port ${PORT}`);
    console.log(`📌 Login: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
});
