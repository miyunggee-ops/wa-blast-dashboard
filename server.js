// Route: Balas pesan inbox
app.post('/api/reply', requireLogin, async (req, res) => {
    const { to, pesan } = req.body;
    if (!to || !pesan) return res.json({ success: false, error: 'Nomor dan pesan wajib diisi!' });

    const users = readJSON('data/users.json');
    const user  = users.find(u => u.id === req.session.userId);
    if (!user) return res.json({ success: false, error: 'User tidak ditemukan!' });

    // Ambil sock yang dipakai user
    let sock;
    if (user.assignedWA) {
        const ps = getPoolSession(user.assignedWA);
        if (ps.status !== 'connected') return res.json({ success: false, error: 'Nomor WA pool belum connected!' });
        sock = ps.sock;
    } else if (user.role === 'admin') {
        // Admin: coba rotasi pool dulu, fallback personal
        sock = getRotasiSock(req.session.userId);
        if (!sock) {
            const ses = getUserSession(req.session.userId);
            if (ses.status !== 'connected') return res.json({ success: false, error: 'WA belum terhubung!' });
            sock = ses.sock;
        }
    } else {
        const ses = getUserSession(req.session.userId);
        if (ses.status !== 'connected') return res.json({ success: false, error: 'WA belum terhubung!' });
        sock = ses.sock;
    }

    try {
        const jid = to.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: pesan });
        res.json({ success: true, msg: `✅ Pesan terkirim ke ${to}` });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});
