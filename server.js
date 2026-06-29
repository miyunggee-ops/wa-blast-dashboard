// MESIN-WA v3 - Proxy + Reply Inbox
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
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT           = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'wa-blast-secret-2026';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

if (!fs.existsSync('data'))    fs.mkdirSync('data',    { recursive: true });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads', { recursive: true });

function readJSON(file)        { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function parseSpintax(text) {
    let result = text, limit = 50;
    while (result.includes('{') && limit-- > 0)
        result = result.replace(/\{([^{}]+)\}/g, (m, c) => { const o = c.split('|'); return o[Math.floor(Math.random()*o.length)]; });
    return result;
}

function makeProxyAgent(proxyUrl) {
    if (!proxyUrl || !proxyUrl.trim()) return null;
    try {
        const url = new URL(proxyUrl.trim());
        if (['socks5:', 'socks4:', 'socks:'].includes(url.protocol)) return new SocksProxyAgent(proxyUrl.trim());
        if (['http:', 'https:'].includes(url.protocol)) return new HttpsProxyAgent(proxyUrl.trim());
        return null;
    } catch (e) { console.error(`[Proxy] invalid: ${proxyUrl}`); return null; }
}

function seedData() {
    let users = readJSON('data/users.json');
    if (!fs.existsSync('data/licenses.json')) writeJSON('data/licenses.json', [
        { key:'STARTER-DEMO-2026', plan:'Starter', quotaHarian:500,  durasiHari:30, usedBy:null, usedAt:null, createdAt:new Date().toISOString() },
        { key:'PRO-DEMO-2026',     plan:'Pro',     quotaHarian:2000, durasiHari:30, usedBy:null, usedAt:null, createdAt:new Date().toISOString() }
    ]);
    if (!fs.existsSync('data/wa-pool.json')) writeJSON('data/wa-pool.json', []);
    const freshHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    const adminIdx  = users.findIndex(u => u.id==='admin-001' || u.username===ADMIN_USERNAME);
    if (adminIdx===-1) {
        users.unshift({ id:'admin-001', username:ADMIN_USERNAME, password:freshHash, role:'admin', licenseKey:'ADMIN-FREE-FOREVER', licenseActive:true, licenseExpiry:null, plan:'Admin', quotaHarian:999999, quotaTerpakai:0, lastReset:'', assignedWA:null, banned:false, createdAt:new Date().toISOString() });
    } else {
        users[adminIdx].password=freshHash; users[adminIdx].role='admin'; users[adminIdx].licenseActive=true; users[adminIdx].quotaHarian=999999;
        if (users[adminIdx].assignedWA===undefined) users[adminIdx].assignedWA=null;
        if (users[adminIdx].banned===undefined) users[adminIdx].banned=false;
    }
    writeJSON('data/users.json', users);
    console.log(`\ud83d\udccc Admin synced: ${ADMIN_USERNAME}`);
}
seedData();

const upload = multer({ dest:'uploads/', fileFilter:(req,file,cb)=>{ const ext=path.extname(file.originalname).toLowerCase(); ['.txt','.csv'].includes(ext)?cb(null,true):cb(new Error('Hanya .txt/.csv')); }, limits:{fileSize:2*1024*1024} });
const sessionMiddleware = session({ secret:SESSION_SECRET, resave:false, saveUninitialized:false, cookie:{maxAge:24*60*60*1000} });
app.use(express.json()); app.use(express.urlencoded({extended:true})); app.use(sessionMiddleware);
app.use('/dashboard', express.static(path.join(__dirname,'public')));
io.use((socket,next)=>sessionMiddleware(socket.request,{},next));

function requireLogin(req,res,next){ if(!req.session.userId) return res.status(401).json({success:false,error:'Login dulu!'}); next(); }
function requireAdmin(req,res,next){
    if(!req.session.userId) return res.status(401).json({success:false,error:'Login dulu!'});
    const user=readJSON('data/users.json').find(u=>u.id===req.session.userId);
    if(!user||user.role!=='admin') return res.status(403).json({success:false,error:'Akses ditolak!'});
    next();
}

const poolSessions={};
function getPoolSession(poolId){ if(!poolSessions[poolId]) poolSessions[poolId]={sock:null,status:'disconnected'}; return poolSessions[poolId]; }
const sessions={};
function getUserSession(userId){ if(!sessions[userId]) sessions[userId]={sock:null,status:'disconnected',isBlasting:false,blastLog:[],inbox:[],poolId:null,rotasiIdx:0}; return sessions[userId]; }

function cekResetQuota(user){ const h=new Date().toDateString(); if(user.lastReset!==h){user.quotaTerpakai=0;user.lastReset=h;} return user; }

function getRotasiSock(userId){
    const pool=readJSON('data/wa-pool.json'), aktif=pool.filter(p=>p.status==='connected');
    if(!aktif.length) return null;
    const ses=getUserSession(userId), idx=ses.rotasiIdx%aktif.length;
    ses.rotasiIdx++;
    const ps=getPoolSession(aktif[idx].id);
    return (ps.status==='connected'&&ps.sock)?ps.sock:null;
}

// Helper: ambil sock aktif milik user
function getUserSock(userId) {
    const users = readJSON('data/users.json');
    const user  = users.find(u => u.id === userId);
    if (!user) return null;
    if (user.assignedWA) {
        const ps = getPoolSession(user.assignedWA);
        return (ps.status === 'connected' && ps.sock) ? ps.sock : null;
    }
    if (user.role === 'admin') {
        const sock = getRotasiSock(userId);
        if (sock) return sock;
    }
    const ses = getUserSession(userId);
    return (ses.status === 'connected' && ses.sock) ? ses.sock : null;
}

function notifyPoolUsers(poolId,status,nomor){
    const users=readJSON('data/users.json'), ps=getPoolSession(poolId);
    users.filter(u=>u.assignedWA===poolId).forEach(u=>{
        const ses=getUserSession(u.id); ses.sock=ps.sock; ses.status=status; ses.poolId=poolId;
        io.to(`user:${u.id}`).emit('status',{status,msg:status==='connected'?`\u2705 Terhubung: ${nomor}`:'Menghubungkan...'});
    });
}

async function connectPoolQR(poolId){
    const ps=getPoolSession(poolId);
    if(ps.status==='connected'||ps.status==='connecting') return;
    ps.status='connecting';
    const sesiDir=`sesi_pool_${poolId}`;
    const {version}=await fetchLatestBaileysVersion();
    const {state,saveCreds}=await useMultiFileAuthState(sesiDir);
    const pool=readJSON('data/wa-pool.json'), poolRec=pool.find(p=>p.id===poolId);
    const agent=makeProxyAgent(poolRec?.proxy||null);
    if(agent) console.log(`\ud83d\udd17 Pool ${poolRec?.nomor||poolId} pakai proxy: ${poolRec.proxy}`);
    const sockOpts={version,auth:state,printQRInTerminal:false,logger:pino({level:'silent'}),browser:Browsers.ubuntu('Chrome'),syncFullHistory:false};
    if(agent) sockOpts.agent=agent;
    ps.sock=makeWASocket(sockOpts);
    ps.sock.ev.on('creds.update',saveCreds);
    ps.sock.ev.on('connection.update',async(update)=>{
        const {connection,qr,lastDisconnect}=update;
        if(qr){ ps.status='qr'; const qi=await qrcode.toDataURL(qr); io.to('admin').emit('pool-qr',{poolId,qr:qi}); const p2=readJSON('data/wa-pool.json'),i2=p2.findIndex(p=>p.id===poolId); if(i2!==-1){p2[i2].status='qr';writeJSON('data/wa-pool.json',p2);} io.to('admin').emit('pool-status',{poolId,status:'qr'}); }
        if(connection==='close'){
            ps.status='disconnected'; notifyPoolUsers(poolId,'disconnected','');
            const kode=lastDisconnect?.error?.output?.statusCode;
            if(kode!==DisconnectReason.loggedOut){ setTimeout(()=>connectPoolQR(poolId),5000); }
            else{ const p2=readJSON('data/wa-pool.json'),i2=p2.findIndex(p=>p.id===poolId); if(i2!==-1){p2[i2].status='expired';writeJSON('data/wa-pool.json',p2);} io.to('admin').emit('pool-status',{poolId,status:'expired'}); }
        }
        if(connection==='open'){
            ps.status='connected'; const nomorWA=ps.sock.user?.id?.split(':')[0]||'';
            const p2=readJSON('data/wa-pool.json'),i2=p2.findIndex(p=>p.id===poolId);
            if(i2!==-1){p2[i2].status='connected';p2[i2].nomor=nomorWA;writeJSON('data/wa-pool.json',p2);}
            io.to('admin').emit('pool-qr',{poolId,qr:null}); io.to('admin').emit('pool-status',{poolId,status:'connected',nomor:nomorWA});
            notifyPoolUsers(poolId,'connected',nomorWA);
        }
    });
    ps.sock.ev.on('messages.upsert',({messages,type})=>{
        if(type!=='notify') return;
        for(const msg of messages){
            if(msg.key.fromMe) continue;
            const from=msg.key.remoteJid?.replace('@s.whatsapp.net','')||'', text=msg.message?.conversation||msg.message?.extendedTextMessage?.text||msg.message?.imageMessage?.caption||'[Media]';
            const item={from,text,time:new Date().toLocaleTimeString('id-ID')};
            const users=readJSON('data/users.json'), seenIds=new Set();
            users.filter(u=>u.assignedWA===poolId).forEach(u=>{ seenIds.add(u.id); const ses=getUserSession(u.id); ses.inbox.unshift(item); if(ses.inbox.length>100)ses.inbox.pop(); io.to(`user:${u.id}`).emit('inbox',item); });
            users.filter(u=>u.role==='admin'&&!seenIds.has(u.id)).forEach(u=>{ const ses=getUserSession(u.id); ses.inbox.unshift(item); if(ses.inbox.length>100)ses.inbox.pop(); io.to(`user:${u.id}`).emit('inbox',item); });
        }
    });
}

function autoReconnectPool(){ const pool=readJSON('data/wa-pool.json'); pool.filter(p=>p.status==='connected').forEach(p=>{console.log(`\ud83d\udd04 Reconnect pool: ${p.nomor}`);connectPoolQR(p.id);}); }

async function connectPersonal(userId){
    const ses=getUserSession(userId);
    if(ses.status==='connected'||ses.status==='connecting') return;
    ses.status='connecting';
    const {version}=await fetchLatestBaileysVersion(), {state,saveCreds}=await useMultiFileAuthState(`sesi_${userId}`);
    ses.sock=makeWASocket({version,auth:state,printQRInTerminal:false,logger:pino({level:'silent'}),browser:Browsers.ubuntu('Chrome'),syncFullHistory:false});
    ses.sock.ev.on('creds.update',saveCreds);
    ses.sock.ev.on('connection.update',async(update)=>{
        const {connection,qr,lastDisconnect}=update;
        if(qr){ ses.status='qr'; const qi=await qrcode.toDataURL(qr); io.to(`user:${userId}`).emit('qr',qi); io.to(`user:${userId}`).emit('status',{status:'qr',msg:'Scan QR Code'}); }
        if(connection==='close'){ ses.status='disconnected'; const kode=lastDisconnect?.error?.output?.statusCode; if(kode!==DisconnectReason.loggedOut){io.to(`user:${userId}`).emit('status',{status:'disconnected',msg:'Terputus, mencoba ulang...'});setTimeout(()=>connectPersonal(userId),5000);}else{io.to(`user:${userId}`).emit('status',{status:'disconnected',msg:'Session expired!'});} }
        if(connection==='open'){ ses.status='connected'; const n=ses.sock.user?.id?.split(':')[0]||'-'; io.to(`user:${userId}`).emit('qr',null); io.to(`user:${userId}`).emit('status',{status:'connected',msg:`\u2705 Terhubung: ${n}`}); }
    });
    ses.sock.ev.on('messages.upsert',({messages,type})=>{
        if(type!=='notify') return;
        for(const msg of messages){ if(msg.key.fromMe) continue; const from=msg.key.remoteJid?.replace('@s.whatsapp.net','')||'', text=msg.message?.conversation||msg.message?.extendedTextMessage?.text||msg.message?.imageMessage?.caption||'[Media]', item={from,text,time:new Date().toLocaleTimeString('id-ID')}; ses.inbox.unshift(item); if(ses.inbox.length>100)ses.inbox.pop(); io.to(`user:${userId}`).emit('inbox',item); }
    });
}

// Routes
app.get('/',(req,res)=>{ if(req.session.userId) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname,'public','login.html')); });
app.get('/dashboard',(req,res)=>{ if(!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname,'public','index.html')); });

app.post('/api/register',async(req,res)=>{
    const {username,password}=req.body;
    if(!username||!password) return res.json({success:false,error:'Username & password wajib diisi!'});
    const users=readJSON('data/users.json');
    if(users.find(u=>u.username===username)) return res.json({success:false,error:'Username sudah dipakai!'});
    const hashed=await bcrypt.hash(password,10);
    users.push({id:uuidv4(),username,password:hashed,role:'user',licenseKey:null,licenseActive:false,licenseExpiry:null,plan:null,quotaHarian:0,quotaTerpakai:0,lastReset:'',assignedWA:null,banned:false,createdAt:new Date().toISOString()});
    writeJSON('data/users.json',users); res.json({success:true,msg:'Akun berhasil dibuat! Silakan login.'});
});

app.post('/api/login',async(req,res)=>{
    const {username,password}=req.body;
    const users=readJSON('data/users.json'), user=users.find(u=>u.username===username);
    if(!user) return res.json({success:false,error:'Username tidak ditemukan!'});
    if(user.banned) return res.json({success:false,error:'Akun dinonaktifkan. Hubungi admin.'});
    const match=await bcrypt.compare(password,user.password);
    if(!match) return res.json({success:false,error:'Password salah!'});
    req.session.userId=user.id; req.session.username=user.username; req.session.role=user.role;
    res.json({success:true,role:user.role});
});

app.post('/api/logout',(req,res)=>{ req.session.destroy(); res.json({success:true}); });

app.get('/api/me',requireLogin,(req,res)=>{
    const users=readJSON('data/users.json'), user=users.find(u=>u.id===req.session.userId);
    if(!user) return res.json({success:false});
    if(user.banned){ req.session.destroy(); return res.json({success:false,error:'Akun dinonaktifkan.'}); }
    cekResetQuota(user); writeJSON('data/users.json',users);
    const pool=readJSON('data/wa-pool.json'), waPool=user.assignedWA?pool.find(p=>p.id===user.assignedWA):null, poolAktif=pool.filter(p=>p.status==='connected').length;
    res.json({success:true,userId:user.id,username:user.username,role:user.role,licenseActive:user.licenseActive,licenseExpiry:user.licenseExpiry,plan:user.plan||'-',quotaHarian:user.quotaHarian,quotaTerpakai:user.quotaTerpakai,sisaQuota:Math.max(0,user.quotaHarian-user.quotaTerpakai),assignedWA:user.assignedWA,assignedNomor:waPool?.nomor||null,poolAktif});
});

app.post('/api/aktivasi',requireLogin,(req,res)=>{
    const {key}=req.body;
    if(!key) return res.json({success:false,error:'Key tidak boleh kosong!'});
    const licenses=readJSON('data/licenses.json'), lic=licenses.find(l=>l.key===key.trim().toUpperCase());
    if(!lic) return res.json({success:false,error:'Key tidak ditemukan!'});
    if(lic.usedBy) return res.json({success:false,error:'Key sudah dipakai!'});
    const users=readJSON('data/users.json'), idx=users.findIndex(u=>u.id===req.session.userId);
    const expiry=new Date(); expiry.setDate(expiry.getDate()+lic.durasiHari);
    users[idx]={...users[idx],licenseKey:key,licenseActive:true,licenseExpiry:expiry.toISOString(),quotaHarian:lic.quotaHarian,plan:lic.plan};
    writeJSON('data/users.json',users); lic.usedBy=req.session.userId; lic.usedAt=new Date().toISOString(); writeJSON('data/licenses.json',licenses);
    res.json({success:true,msg:`\u2705 Lisensi ${lic.plan} aktif! Berlaku ${lic.durasiHari} hari. Quota: ${lic.quotaHarian}/hari.`});
});

// WA Pool
app.get('/api/admin/wa-pool',requireAdmin,(req,res)=>res.json(readJSON('data/wa-pool.json')));
app.post('/api/admin/wa-pool/add',requireAdmin,async(req,res)=>{ const pool=readJSON('data/wa-pool.json'),poolId=uuidv4(); pool.push({id:poolId,nomor:'',status:'pending',assignedTo:null,proxy:null,createdAt:new Date().toISOString()}); writeJSON('data/wa-pool.json',pool); res.json({success:true,poolId,msg:'Slot nomor ditambahkan. Scan QR di bawah.'}); connectPoolQR(poolId); });
app.post('/api/admin/wa-pool/:id/proxy',requireAdmin,(req,res)=>{
    const {proxyUrl}=req.body;
    const pool=readJSON('data/wa-pool.json'), idx=pool.findIndex(p=>p.id===req.params.id);
    if(idx===-1) return res.json({success:false,error:'Pool tidak ditemukan!'});
    if(proxyUrl&&proxyUrl.trim()){ try{ const u=new URL(proxyUrl.trim()); if(!['socks5:','socks4:','socks:','http:','https:'].includes(u.protocol)) return res.json({success:false,error:'Format proxy tidak valid!'}); }catch(e){ return res.json({success:false,error:'URL proxy tidak valid!'}); } }
    pool[idx].proxy=proxyUrl&&proxyUrl.trim()?proxyUrl.trim():null; writeJSON('data/wa-pool.json',pool);
    const msg=pool[idx].proxy?`\u2705 Proxy diset. Nomor reconnect otomatis.`:'\u2705 Proxy dihapus.';
    if(pool[idx].status==='connected'||pool[idx].status==='qr'){ const ps=getPoolSession(req.params.id); if(ps.sock){try{ps.sock.end();}catch(e){} ps.sock=null;} ps.status='disconnected'; setTimeout(()=>connectPoolQR(req.params.id),1500); }
    res.json({success:true,msg,proxy:pool[idx].proxy});
});
app.delete('/api/admin/wa-pool/:id',requireAdmin,(req,res)=>{ const {id}=req.params; let pool=readJSON('data/wa-pool.json'); const ps=getPoolSession(id); if(ps.sock){try{ps.sock.end();}catch(e){}delete poolSessions[id];} pool=pool.filter(p=>p.id!==id); writeJSON('data/wa-pool.json',pool); const users=readJSON('data/users.json'); users.forEach(u=>{if(u.assignedWA===id){u.assignedWA=null;const ses=getUserSession(u.id);ses.status='disconnected';ses.sock=null;io.to(`user:${u.id}`).emit('status',{status:'disconnected',msg:'Nomor WA dicabut admin.'}); }}); writeJSON('data/users.json',users); res.json({success:true}); });
app.post('/api/admin/wa-pool/assign',requireAdmin,(req,res)=>{ const {poolId,userId}=req.body; if(!poolId||!userId) return res.json({success:false,error:'poolId dan userId wajib!'}); const pool=readJSON('data/wa-pool.json'),p=pool.find(p=>p.id===poolId); if(!p) return res.json({success:false,error:'Pool tidak ditemukan!'}); if(p.status!=='connected') return res.json({success:false,error:'Nomor belum connected!'}); const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===userId); if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'}); users.forEach(u=>{if(u.assignedWA===poolId&&u.id!==userId)u.assignedWA=null;}); users[idx].assignedWA=poolId; writeJSON('data/users.json',users); pool[pool.findIndex(p=>p.id===poolId)].assignedTo=userId; writeJSON('data/wa-pool.json',pool); const ps=getPoolSession(poolId),ses=getUserSession(userId); ses.sock=ps.sock;ses.status=ps.status;ses.poolId=poolId; io.to(`user:${userId}`).emit('status',{status:ps.status,msg:ps.status==='connected'?`\u2705 Terhubung: ${p.nomor}`:'Menghubungkan...'}); res.json({success:true,msg:`\u2705 Nomor ${p.nomor} di-assign ke ${users[idx].username}`}); });
app.post('/api/admin/wa-pool/unassign',requireAdmin,(req,res)=>{ const {userId}=req.body; const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===userId); if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'}); users[idx].assignedWA=null; writeJSON('data/users.json',users); const ses=getUserSession(userId); ses.sock=null;ses.status='disconnected';ses.poolId=null; io.to(`user:${userId}`).emit('status',{status:'disconnected',msg:'Nomor WA dicabut.'}); res.json({success:true}); });

// Admin Users
app.get('/api/admin/users',requireAdmin,(req,res)=>{ const pool=readJSON('data/wa-pool.json'); res.json(readJSON('data/users.json').map(u=>{ const wp=u.assignedWA?pool.find(p=>p.id===u.assignedWA):null; return {id:u.id,username:u.username,role:u.role,plan:u.plan||'-',licenseActive:u.licenseActive,licenseExpiry:u.licenseExpiry,quotaHarian:u.quotaHarian,quotaTerpakai:u.quotaTerpakai,assignedWA:u.assignedWA,assignedNomor:wp?.nomor||null,banned:u.banned||false,createdAt:u.createdAt}; })); });
app.get('/api/admin/users/:id',requireAdmin,(req,res)=>{ const users=readJSON('data/users.json'),pool=readJSON('data/wa-pool.json'),user=users.find(u=>u.id===req.params.id); if(!user) return res.json({success:false,error:'User tidak ditemukan!'}); const wp=user.assignedWA?pool.find(p=>p.id===user.assignedWA):null; res.json({success:true,user:{id:user.id,username:user.username,role:user.role,plan:user.plan||'-',licenseActive:user.licenseActive,licenseExpiry:user.licenseExpiry,quotaHarian:user.quotaHarian,quotaTerpakai:user.quotaTerpakai,assignedWA:user.assignedWA,assignedNomor:wp?.nomor||null,banned:user.banned||false,createdAt:user.createdAt}}); });
app.post('/api/admin/users/:id/reset-password',requireAdmin,async(req,res)=>{ const {newPassword}=req.body; if(!newPassword||newPassword.length<6) return res.json({success:false,error:'Password min. 6 karakter!'}); const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===req.params.id); if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'}); if(users[idx].role==='admin') return res.json({success:false,error:'Tidak bisa reset password admin!'}); users[idx].password=await bcrypt.hash(newPassword,10); writeJSON('data/users.json',users); res.json({success:true,msg:`\u2705 Password ${users[idx].username} berhasil direset.`}); });
app.post('/api/admin/users/:id/ban',requireAdmin,(req,res)=>{ const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===req.params.id); if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'}); if(users[idx].role==='admin') return res.json({success:false,error:'Tidak bisa ban admin!'}); users[idx].banned=!users[idx].banned; writeJSON('data/users.json',users); if(users[idx].banned) io.to(`user:${users[idx].id}`).emit('force-logout',{msg:'Akun kamu telah dinonaktifkan oleh admin.'}); res.json({success:true,banned:users[idx].banned,msg:users[idx].banned?`\ud83d\udeab ${users[idx].username} dibanned.`:`\u2705 ${users[idx].username} di-unban.`}); });
app.post('/api/admin/users/:id/extend',requireAdmin,(req,res)=>{ const {days}=req.body; if(!days||isNaN(days)||days<1) return res.json({success:false,error:'Jumlah hari tidak valid!'}); const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===req.params.id); if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'}); const current=users[idx].licenseExpiry?new Date(users[idx].licenseExpiry):new Date(); const base=current<new Date()?new Date():current; base.setDate(base.getDate()+parseInt(days)); users[idx].licenseExpiry=base.toISOString();users[idx].licenseActive=true; writeJSON('data/users.json',users); res.json({success:true,msg:`\u2705 Lisensi ${users[idx].username} diperpanjang ${days} hari. s/d ${base.toLocaleDateString('id-ID')}.`,newExpiry:base.toISOString()}); });
app.delete('/api/admin/users/:id',requireAdmin,(req,res)=>{ const users=readJSON('data/users.json'),user=users.find(u=>u.id===req.params.id); if(!user) return res.json({success:false,error:'User tidak ditemukan!'}); if(user.role==='admin') return res.json({success:false,error:'Tidak bisa hapus akun admin!'}); const ses=getUserSession(user.id); if(ses.sock){try{ses.sock.end();}catch(e){}} delete sessions[user.id]; io.to(`user:${user.id}`).emit('force-logout',{msg:'Akun kamu telah dihapus.'}); writeJSON('data/users.json',users.filter(u=>u.id!==req.params.id)); res.json({success:true,msg:`\u2705 User ${user.username} berhasil dihapus.`}); });

app.post('/api/admin/generate-key',requireAdmin,(req,res)=>{ const {plan,quotaHarian,durasiHari}=req.body; if(!plan||!quotaHarian||!durasiHari) return res.json({success:false,error:'Lengkapi semua field!'}); const key=`${plan.toUpperCase()}-${uuidv4().slice(0,8).toUpperCase()}`; const licenses=readJSON('data/licenses.json'); licenses.push({key,plan,quotaHarian:parseInt(quotaHarian),durasiHari:parseInt(durasiHari),usedBy:null,usedAt:null,createdAt:new Date().toISOString()}); writeJSON('data/licenses.json',licenses); res.json({success:true,key}); });
app.get('/api/admin/licenses',requireAdmin,(req,res)=>res.json(readJSON('data/licenses.json')));

app.get('/api/status',requireLogin,(req,res)=>{
    const users=readJSON('data/users.json'),user=users.find(u=>u.id===req.session.userId);
    const pool=readJSON('data/wa-pool.json'),poolAktif=pool.filter(p=>p.status==='connected');
    if(user?.assignedWA){ const ps=getPoolSession(user.assignedWA),p=pool.find(p=>p.id===user.assignedWA); return res.json({status:ps.status,nomor:p?.nomor||'-',mode:'pool',poolAktif:poolAktif.length}); }
    if(user?.role==='admin'&&poolAktif.length>0) return res.json({status:'connected',nomor:`${poolAktif.length} nomor pool`,mode:'rotasi',poolAktif:poolAktif.length});
    const ses=getUserSession(req.session.userId);
    res.json({status:ses.status,nomor:ses.sock?.user?.id?.split(':')[0]||'-',mode:'personal',poolAktif:poolAktif.length});
});

app.get('/api/inbox',requireLogin,(req,res)=>res.json(getUserSession(req.session.userId).inbox));
app.get('/api/blast-log',requireLogin,(req,res)=>res.json(getUserSession(req.session.userId).blastLog));

// ─── Reply inbox ──────────────────────────────────────────────────────────────
app.post('/api/reply',requireLogin,async(req,res)=>{
    const {to,pesan}=req.body;
    if(!to||!pesan) return res.json({success:false,error:'Nomor dan pesan wajib diisi!'});
    const sock=getUserSock(req.session.userId);
    if(!sock) return res.json({success:false,error:'WA belum terhubung!'});
    try{
        await sock.sendMessage(to.replace(/\D/g,'')+'@s.whatsapp.net',{text:pesan});
        res.json({success:true,msg:`\u2705 Pesan terkirim ke ${to}`});
    }catch(e){ res.json({success:false,error:e.message}); }
});

app.post('/api/blast',requireLogin,async(req,res)=>{
    const users=readJSON('data/users.json'),user=users.find(u=>u.id===req.session.userId);
    if(!user) return res.json({success:false,error:'User tidak ditemukan!'});
    if(!user.licenseActive) return res.json({success:false,error:'Aktifkan lisensi dulu!'});
    if(user.licenseExpiry&&new Date()>new Date(user.licenseExpiry)) return res.json({success:false,error:'Lisensi expired!'});
    let sockGetter;
    if(user.assignedWA){ const ps=getPoolSession(user.assignedWA); if(ps.status!=='connected') return res.json({success:false,error:'Nomor WA pool belum connected!'}); sockGetter=()=>ps.sock; }
    else if(user.role==='admin'){ sockGetter=()=>{ const s=getRotasiSock(req.session.userId); if(s) return s; const ses=getUserSession(req.session.userId); return ses.status==='connected'?ses.sock:null; }; const t=sockGetter(); if(!t) return res.json({success:false,error:'WA belum terhubung! Scan QR atau tambah nomor ke pool.'}); }
    else{ const ses=getUserSession(req.session.userId); if(ses.status!=='connected') return res.json({success:false,error:'WA belum terhubung!'}); sockGetter=()=>ses.sock; }
    const ses=getUserSession(req.session.userId);
    if(ses.isBlasting) return res.json({success:false,error:'Blast sedang berjalan!'});
    const {nomor,pesan}=req.body;
    if(!nomor||!pesan) return res.json({success:false,error:'Nomor dan pesan wajib diisi!'});
    const allNomor=nomor.split('\n').map(n=>n.trim()).filter(n=>/^62\d{8,13}$/.test(n));
    if(!allNomor.length) return res.json({success:false,error:'Tidak ada nomor valid!'});
    cekResetQuota(user); const sisa=user.quotaHarian-user.quotaTerpakai;
    if(sisa<=0) return res.json({success:false,error:'Quota harian habis!'});
    const blastNomor=allNomor.slice(0,sisa); ses.blastLog=[];ses.isBlasting=true;
    res.json({success:true,total:blastNomor.length,catatan:blastNomor.length<allNomor.length?`Hanya ${blastNomor.length} dari ${allNomor.length} dikirim (sisa quota)`:null});
    jalankanBlast(req.session.userId,sockGetter,pesan,blastNomor);
});

app.post('/api/blast/stop',requireLogin,(req,res)=>{ getUserSession(req.session.userId).isBlasting=false; io.to(`user:${req.session.userId}`).emit('blast-stopped',{}); res.json({success:true}); });
app.post('/api/reset-sesi',requireLogin,async(req,res)=>{ const userId=req.session.userId,users=readJSON('data/users.json'),user=users.find(u=>u.id===userId); if(user?.assignedWA) return res.json({success:false,error:'Kamu pakai nomor pool. Hubungi admin untuk reset.'}); const ses=getUserSession(userId); try{ if(ses.sock){try{ses.sock.end();}catch(e){}}ses.sock=null;ses.status='disconnected'; fs.rmSync(`sesi_${userId}`,{recursive:true,force:true}); res.json({success:true,msg:'Sesi dihapus. Menghubungkan ulang...'}); setTimeout(()=>connectPersonal(userId),1500); }catch(e){ res.json({success:false,error:e.message}); } });
app.post('/api/upload-nomor',requireLogin,upload.single('file'),(req,res)=>{ try{ const content=fs.readFileSync(req.file.path,'utf8'); fs.unlinkSync(req.file.path); const unique=[...new Set(content.split(/[\n,;]+/).map(n=>n.replace(/\D/g,'')).filter(n=>/^62\d{8,13}$/.test(n)))]; res.json({success:true,nomor:unique,total:unique.length}); }catch(e){ res.json({success:false,error:e.message}); } });

async function jalankanBlast(userId,sockGetter,pesan,numbers){
    const ses=getUserSession(userId);
    io.to(`user:${userId}`).emit('blast-start',{total:numbers.length});
    for(let i=0;i<numbers.length;i++){
        if(!ses.isBlasting) break;
        const pesanFinal=parseSpintax(pesan), sock=typeof sockGetter==='function'?sockGetter():sockGetter;
        if(!sock){ const log={no:numbers[i],status:'gagal',index:i+1,total:numbers.length,time:new Date().toLocaleTimeString('id-ID')}; ses.blastLog.push(log); io.to(`user:${userId}`).emit('blast-progress',log); continue; }
        let status='gagal';
        try{ await sock.sendMessage(`${numbers[i]}@s.whatsapp.net`,{text:pesanFinal}); status='sukses'; const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===userId); if(idx!==-1){users[idx].quotaTerpakai=(users[idx].quotaTerpakai||0)+1;writeJSON('data/users.json',users);} }catch(err){}
        const log={no:numbers[i],status,index:i+1,total:numbers.length,time:new Date().toLocaleTimeString('id-ID')};
        ses.blastLog.push(log); io.to(`user:${userId}`).emit('blast-progress',log);
        if(i<numbers.length-1&&ses.isBlasting) await new Promise(r=>setTimeout(r,Math.floor(Math.random()*4000)+4000));
    }
    ses.isBlasting=false;
    io.to(`user:${userId}`).emit('blast-done',{total:numbers.length,sukses:ses.blastLog.filter(l=>l.status==='sukses').length,gagal:ses.blastLog.filter(l=>l.status==='gagal').length});
}

io.on('connection',(socket)=>{
    const userId=socket.request.session?.userId;
    if(!userId) return;
    socket.join(`user:${userId}`);
    const users=readJSON('data/users.json'),user=users.find(u=>u.id===userId);
    if(user?.role==='admin') socket.join('admin');
    socket.on('join-me',()=>{ socket.join(`user:${userId}`); if(user?.role==='admin') socket.join('admin'); });
    if(user?.assignedWA){
        const ps=getPoolSession(user.assignedWA),pool=readJSON('data/wa-pool.json'),p=pool.find(p=>p.id===user.assignedWA);
        socket.emit('status',{status:ps.status,msg:ps.status==='connected'?`\u2705 Terhubung: ${p?.nomor||'-'}`:'Menghubungkan...'});
        const ses=getUserSession(userId); if(ps.status==='connected'){ses.sock=ps.sock;ses.status='connected';ses.poolId=user.assignedWA;}
        socket.emit('inbox-all',ses.inbox);
    } else {
        const pool=readJSON('data/wa-pool.json'),aktif=pool.filter(p=>p.status==='connected');
        if(user?.role==='admin'&&aktif.length>0){
            socket.emit('status',{status:'connected',msg:`\u2705 ${aktif.length} nomor pool aktif (rotasi)`});
            socket.emit('inbox-all',getUserSession(userId).inbox);
        } else {
            const ses=getUserSession(userId);
            socket.emit('status',{status:ses.status,msg:ses.status==='connected'?`\u2705 Terhubung: ${ses.sock?.user?.id?.split(':')[0]||'-'}`:ses.status==='qr'?'Scan QR':'Menghubungkan...'});
            socket.emit('inbox-all',ses.inbox);
            if(ses.status==='disconnected') connectPersonal(userId);
        }
    }
});

server.listen(PORT,()=>{
    console.log(`\n\ud83d\ude80 MESIN-WA jalan di port ${PORT}`);
    console.log(`\ud83d\udccc Login: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
    setTimeout(autoReconnectPool,3000);
});
