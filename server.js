// WA Blast Dashboard - server.js
// Deploy ke Railway: railway up

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino    = require('pino');
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const fs      = require('fs');
const path    = require('path');
const qrcode  = require('qrcode');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

let sock         = null;
let waStatus     = 'disconnected';
let isBlasting   = false;
let blastLog     = [];
let inbox        = [];
let blastNumbers = [];

async function connectWA() {
    const { version }          = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('sesi_dashboard');

    sock = makeWASocket({
        version,
        auth:              state,
        printQRInTerminal: false,
        logger:            pino({ level: 'silent' }),
        browser:           Browsers.ubuntu('Chrome'),
        syncFullHistory:   false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            waStatus = 'qr';
            const qrImage = await qrcode.toDataURL(qr);
            io.emit('qr', qrImage);
            io.emit('status', { status: 'qr', msg: 'Scan QR Code di bawah' });
        }

        if (connection === 'close') {
            waStatus = 'disconnected';
            const kode = lastDisconnect?.error?.output?.statusCode;
            if (kode === DisconnectReason.loggedOut) {
                io.emit('status', { status: 'disconnected', msg: 'Session expired! Klik Reset Sesi.' });
            } else {
                io.emit('status', { status: 'disconnected', msg: 'Koneksi terputus, mencoba ulang...' });
                setTimeout(() => connectWA(), 5000);
            }
        }

        if (connection === 'open') {
            waStatus = 'connected';
            const nomorWA = sock.user?.id?.split(':')[0] || '-';
            io.emit('qr', null);
            io.emit('status', { status: 'connected', msg: `✅ Terhubung: ${nomorWA}` });
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
            const text = msg.message?.conversation
                      || msg.message?.extendedTextMessage?.text
                      || msg.message?.imageMessage?.caption
                      || '[Media]';
            const time = new Date().toLocaleTimeString('id-ID');
            const inboxItem = { from, text, time };
            inbox.unshift(inboxItem);
            if (inbox.length > 100) inbox.pop();
            io.emit('inbox', inboxItem);
        }
    });
}

app.get('/api/status', (req, res) => {
    res.json({ status: waStatus, nomor: sock?.user?.id?.split(':')[0] || '-', inbox: inbox.length });
});

app.get('/api/inbox', (req, res) => res.json(inbox));
app.get('/api/blast-log', (req, res) => res.json(blastLog));

app.post('/api/blast', async (req, res) => {
    if (waStatus !== 'connected') return res.json({ success: false, error: 'WA belum terhubung!' });
    if (isBlasting) return res.json({ success: false, error: 'Blast sedang berjalan!' });
    const { nomor, pesan } = req.body;
    if (!nomor || !pesan) return res.json({ success: false, error: 'Nomor dan pesan wajib diisi!' });
    blastNumbers = nomor.split('\n').map(n => n.trim()).filter(n => /^62\d{8,13}$/.test(n));
    if (blastNumbers.length === 0) return res.json({ success: false, error: 'Tidak ada nomor valid! Awali dengan 62.' });
    blastLog   = [];
    isBlasting = true;
    res.json({ success: true, total: blastNumbers.length });
    jalankanBlast(pesan, blastNumbers);
});

app.post('/api/blast/stop', (req, res) => {
    isBlasting = false;
    io.emit('blast-stopped', {});
    res.json({ success: true });
});

app.post('/api/reset-sesi', async (req, res) => {
    try {
        if (sock) { try { sock.end(); } catch(e) {} sock = null; }
        waStatus = 'disconnected';
        fs.rmSync('sesi_dashboard', { recursive: true, force: true });
        res.json({ success: true, msg: 'Sesi dihapus. Menghubungkan ulang...' });
        setTimeout(() => connectWA(), 1500);
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

async function jalankanBlast(pesan, numbers) {
    const total = numbers.length;
    io.emit('blast-start', { total });
    for (let i = 0; i < numbers.length; i++) {
        if (!isBlasting) break;
        const no  = numbers[i];
        const jid = `${no}@s.whatsapp.net`;
        try {
            await sock.sendMessage(jid, { text: pesan });
            const log = { no, status: 'sukses', index: i + 1, total, time: new Date().toLocaleTimeString('id-ID') };
            blastLog.push(log);
            io.emit('blast-progress', log);
        } catch (err) {
            const log = { no, status: 'gagal', index: i + 1, total, time: new Date().toLocaleTimeString('id-ID') };
            blastLog.push(log);
            io.emit('blast-progress', log);
        }
        if (i < numbers.length - 1 && isBlasting) {
            const jeda = Math.floor(Math.random() * (8000 - 4000 + 1)) + 4000;
            await new Promise(r => setTimeout(r, jeda));
        }
    }
    isBlasting = false;
    const sukses = blastLog.filter(l => l.status === 'sukses').length;
    const gagal  = blastLog.filter(l => l.status === 'gagal').length;
    io.emit('blast-done', { total, sukses, gagal });
}

io.on('connection', (socket) => {
    socket.emit('status', {
        status: waStatus,
        msg: waStatus === 'connected'
            ? `✅ Terhubung: ${sock?.user?.id?.split(':')[0] || '-'}`
            : waStatus === 'qr' ? 'Scan QR Code' : 'Menghubungkan...'
    });
    socket.emit('inbox-all', inbox);
});

server.listen(PORT, () => {
    console.log(`\n🚀 WA Blast Dashboard jalan di port ${PORT}`);
});

connectWA();
