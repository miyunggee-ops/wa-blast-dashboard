// ─── Routes Admin: User Management ───────────────────────────────────────────

// GET detail 1 user
app.get('/api/admin/users/:id', requireAdmin, (req, res) => {
    const users = readJSON('data/users.json');
    const pool  = readJSON('data/wa-pool.json');
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.json({ success: false, error: 'User tidak ditemukan!' });
    const wp = user.assignedWA ? pool.find(p => p.id === user.assignedWA) : null;
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role, plan: user.plan||'-', licenseActive: user.licenseActive, licenseExpiry: user.licenseExpiry, quotaHarian: user.quotaHarian, quotaTerpakai: user.quotaTerpakai, assignedWA: user.assignedWA, assignedNomor: wp?.nomor||null, banned: user.banned||false, createdAt: user.createdAt } });
});

// Reset password user
app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.json({ success: false, error: 'Password min. 6 karakter!' });
    const users = readJSON('data/users.json');
    const idx   = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.json({ success: false, error: 'User tidak ditemukan!' });
    if (users[idx].role === 'admin') return res.json({ success: false, error: 'Tidak bisa reset password admin dari sini!' });
    users[idx].password = await bcrypt.hash(newPassword, 10);
    writeJSON('data/users.json', users);
    res.json({ success: true, msg: `✅ Password ${users[idx].username} berhasil direset.` });
});

// Ban / Unban user
app.post('/api/admin/users/:id/ban', requireAdmin, (req, res) => {
    const users = readJSON('data/users.json');
    const idx   = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.json({ success: false, error: 'User tidak ditemukan!' });
    if (users[idx].role === 'admin') return res.json({ success: false, error: 'Tidak bisa ban admin!' });
    users[idx].banned = !users[idx].banned;
    writeJSON('data/users.json', users);
    if (users[idx].banned) {
        // Kick session user
        io.to(`user:${users[idx].id}`).emit('force-logout', { msg: 'Akun kamu telah dinonaktifkan oleh admin.' });
    }
    res.json({ success: true, banned: users[idx].banned, msg: users[idx].banned ? `🚫 ${users[idx].username} dibanned.` : `✅ ${users[idx].username} di-unban.` });
});

// Extend lisensi user (tambah hari)
app.post('/api/admin/users/:id/extend', requireAdmin, (req, res) => {
    const { days } = req.body;
    if (!days || isNaN(days) || days < 1) return res.json({ success: false, error: 'Jumlah hari tidak valid!' });
    const users = readJSON('data/users.json');
    const idx   = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.json({ success: false, error: 'User tidak ditemukan!' });
    const current = users[idx].licenseExpiry ? new Date(users[idx].licenseExpiry) : new Date();
    // Kalau sudah expired, mulai dari sekarang
    const base   = current < new Date() ? new Date() : current;
    base.setDate(base.getDate() + parseInt(days));
    users[idx].licenseExpiry  = base.toISOString();
    users[idx].licenseActive  = true;
    writeJSON('data/users.json', users);
    res.json({ success: true, msg: `✅ Lisensi ${users[idx].username} diperpanjang ${days} hari. Berlaku s/d ${base.toLocaleDateString('id-ID')}.`, newExpiry: base.toISOString() });
});

// Hapus user
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
    const users = readJSON('data/users.json');
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.json({ success: false, error: 'User tidak ditemukan!' });
    if (user.role === 'admin') return res.json({ success: false, error: 'Tidak bisa hapus akun admin!' });
    // Putuskan WA session kalau ada
    const ses = getUserSession(user.id);
    if (ses.sock) { try { ses.sock.end(); } catch(e) {} }
    delete sessions[user.id];
    // Kick
    io.to(`user:${user.id}`).emit('force-logout', { msg: 'Akun kamu telah dihapus.' });
    writeJSON('data/users.json', users.filter(u => u.id !== req.params.id));
    res.json({ success: true, msg: `✅ User ${user.username} berhasil dihapus.` });
});
