// MESIN-WA v3 - Credit System + BG_username ID
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

// Generate user ID dari username: BG_username
function makeUserCode(username) { return 'BG_' + username; }

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
    } catch (e) { return null; }
}

function seedData() {
    let users = readJSON('data/users.json');
    if (!fs.existsSync('data/licenses.json')) writeJSON('data/licenses.json', [
        { key:'STARTER-DEMO-2026', plan:'Starter', credit:500,  durasiHari:30, usedBy:null, usedAt:null, createdAt:new Date().toISOString() },
        { key:'PRO-DEMO-2026',     plan:'Pro',     credit:2000, durasiHari:30, usedBy:null, usedAt:null, createdAt:new Date().toISOString() }
    ]);
    if (!fs.existsSync('data/wa-pool.json')) writeJSON('data/wa-pool.json', []);
    if (!fs.existsSync('data/orders.json'))  writeJSON('data/orders.json',  []);
    if (!fs.existsSync('data/topups.json'))  writeJSON('data/topups.json',  []);
    const freshHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    const adminIdx  = users.findIndex(u => u.id==='admin-001' || u.username===ADMIN_USERNAME);
    if (adminIdx===-1) {
        users.unshift({ id:'admin-001', userCode:makeUserCode(ADMIN_USERNAME), username:ADMIN_USERNAME, password:freshHash, role:'admin', licenseKey:'ADMIN-FREE-FOREVER', licenseActive:true, licenseExpiry:null, plan:'Admin', credit:999999, totalKirim:0, assignedWA:null, banned:false, createdAt:new Date().toISOString() });
    } else {
        users[adminIdx].password=freshHash; users[adminIdx].role='admin'; users[adminIdx].licenseActive=true;
        users[adminIdx].userCode = makeUserCode(users[adminIdx].username);
        if (users[adminIdx].credit===undefined) users[adminIdx].credit=999999;
        if (users[adminIdx].totalKirim===undefined) users[adminIdx].totalKirim=0;
        if (users[adminIdx].assignedWA===undefined) users[adminIdx].assignedWA=null;
        if (users[adminIdx].banned===undefined) users[adminIdx].banned=false;
    }
    // Migrasi: pastikan setiap user punya userCode, credit, totalKirim
    users.forEach(u => {
        if (!u.userCode) u.userCode = makeUserCode(u.username);
        if (u.credit === undefined) u.credit = u.quotaHarian || 0;
        if (u.totalKirim === undefined) u.totalKirim = u.quotaTerpakai || 0;
    });
    writeJSON('data/users.json', users);
    console.log(`\ud83d\udccc Admin synced: ${ADMIN_USERNAME} (${makeUserCode(ADMIN_USERNAME)})`);
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

function getRotasiSock(userId){
    const pool=readJSON('data/wa-pool.json'), aktif=pool.filter(p=>p.status==='connected');
    if(!aktif.length) return null;
    const ses=getUserSession(userId), idx=ses.rotasiIdx%aktif.length;
    ses.rotasiIdx++;
    const ps=getPoolSession(aktif[idx].id);
    return (ps.status==='connected'&&ps.sock)?ps.sock:null;
}

function getUserSock(userId) {
    const users=readJSON('data/users.json'), user=users.find(u=>u.id===userId);
    if(!user) return null;
    if(user.assignedWA){ const ps=getPoolSession(user.assignedWA); return (ps.status==='connected'&&ps.sock)?ps.sock:null; }
    if(user.role==='admin'){ const s=getRotasiSock(userId); if(s) return s; }
    const ses=getUserSession(userId);
    return (ses.status==='connected'&&ses.sock)?ses.sock:null;
}

function notifyPoolUsers(poolId,status,nomor){
    const users=readJSON('data/users.json'), ps=getPoolSession(poolId);
    users.filter(u=>u.assignedWA===poolId).forEach(u=>{
        const ses=getUserSession(u.id); ses.sock=ps.sock; ses.status=status; ses.poolId=poolId;
        io.to(`user:${u.id}`).emit('status',{status,msg:status==='connected'?`\u2705 Terhubung: ${nomor}`:'Menghubungkan...'});
    });
}

// Helper: kirim notif Telegram (kalau env diset)
function notifTelegram(text) {
    const tgToken=process.env.TELEGRAM_BOT_TOKEN, tgChat=process.env.TELEGRAM_CHAT_ID;
    if(!tgToken||!tgChat) return;
    fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:tgChat,text})}).catch(()=>{});
}

async function connectPoolQR(poolId){
    const ps=getPoolSession(poolId);
    if(ps.status==='connected'||ps.status==='connecting') return;
    ps.status='connecting';
    const {version}=await fetchLatestBaileysVersion();
    const {state,saveCreds}=await useMultiFileAuthState(`sesi_pool_${poolId}`);
    const poolRec=readJSON('data/wa-pool.json').find(p=>p.id===poolId);
    const agent=makeProxyAgent(poolRec?.proxy||null);
    if(agent) console.log(`\ud83d\udd17 Pool pakai proxy: ${poolRec.proxy}`);
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

function autoReconnectPool(){ readJSON('data/wa-pool.json').filter(p=>p.status==='connected').forEach(p=>{ console.log(`\ud83d\udd04 Reconnect: ${p.nomor}`); connectPoolQR(p.id); }); }

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
        if(connection==='close'){ ses.status='disconnected'; const kode=lastDisconnect?.error?.output?.statusCode; if(kode!==DisconnectReason.loggedOut){io.to(`user:${userId}`).emit('status',{status:'disconnected',msg:'Terputus...'});setTimeout(()=>connectPersonal(userId),5000);}else{io.to(`user:${userId}`).emit('status',{status:'disconnected',msg:'Session expired!'});} }
        if(connection==='open'){ ses.status='connected'; const n=ses.sock.user?.id?.split(':')[0]||'-'; io.to(`user:${userId}`).emit('qr',null); io.to(`user:${userId}`).emit('status',{status:'connected',msg:`\u2705 Terhubung: ${n}`}); }
    });
    ses.sock.ev.on('messages.upsert',({messages,type})=>{
        if(type!=='notify') return;
        for(const msg of messages){ if(msg.key.fromMe) continue; const from=msg.key.remoteJid?.replace('@s.whatsapp.net','')||'', text=msg.message?.conversation||msg.message?.extendedTextMessage?.text||msg.message?.imageMessage?.caption||'[Media]', item={from,text,time:new Date().toLocaleTimeString('id-ID')}; ses.inbox.unshift(item); if(ses.inbox.length>100)ses.inbox.pop(); io.to(`user:${userId}`).emit('inbox',item); }
    });
}

// ─── Pages ────────────────────────────────────────────────────────
app.get('/',(req,res)=>{ if(req.session.userId) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname,'public','login.html')); });
app.get('/dashboard',(req,res)=>{ if(!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname,'public','index.html')); });
app.get('/member',(req,res)=>res.sendFile(path.join(__dirname,'public','member.html')));

// ─── Auth ─────────────────────────────────────────────────────────────
app.post('/api/register',async(req,res)=>{
    const {username,password}=req.body;
    if(!username||!password) return res.json({success:false,error:'Username & password wajib!'});
    if(!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.json({success:false,error:'Username 3-20 karakter, hanya huruf/angka/_'});
    const users=readJSON('data/users.json');
    if(users.find(u=>u.username===username)) return res.json({success:false,error:'Username sudah dipakai!'});
    const hashed=await bcrypt.hash(password,10);
    users.push({id:uuidv4(),userCode:makeUserCode(username),username,password:hashed,role:'user',licenseKey:null,licenseActive:false,licenseExpiry:null,plan:null,credit:0,totalKirim:0,assignedWA:null,banned:false,createdAt:new Date().toISOString()});
    writeJSON('data/users.json',users); res.json({success:true,msg:'Akun berhasil dibuat!',userCode:makeUserCode(username)});
});

app.post('/api/login',async(req,res)=>{
    const {username,password}=req.body;
    const users=readJSON('data/users.json'), user=users.find(u=>u.username===username);
    if(!user) return res.json({success:false,error:'Username tidak ditemukan!'});
    if(user.banned) return res.json({success:false,error:'Akun dinonaktifkan.'});
    const match=await bcrypt.compare(password,user.password);
    if(!match) return res.json({success:false,error:'Password salah!'});
    req.session.userId=user.id; req.session.username=user.username; req.session.role=user.role;
    res.json({success:true,role:user.role,userCode:user.userCode});
});

app.post('/api/logout',(req,res)=>{ req.session.destroy(); res.json({success:true}); });

app.get('/api/me',requireLogin,(req,res)=>{
    const users=readJSON('data/users.json'), user=users.find(u=>u.id===req.session.userId);
    if(!user) return res.json({success:false});
    if(user.banned){ req.session.destroy(); return res.json({success:false,error:'Akun dinonaktifkan.'}); }
    const pool=readJSON('data/wa-pool.json'), waPool=user.assignedWA?pool.find(p=>p.id===user.assignedWA):null;
    res.json({success:true,userId:user.id,userCode:user.userCode||makeUserCode(user.username),username:user.username,role:user.role,licenseActive:user.licenseActive,licenseExpiry:user.licenseExpiry,plan:user.plan||'-',credit:user.credit||0,totalKirim:user.totalKirim||0,assignedWA:user.assignedWA,assignedNomor:waPool?.nomor||null});
});

app.post('/api/aktivasi',requireLogin,(req,res)=>{
    const {key}=req.body; if(!key) return res.json({success:false,error:'Key kosong!'});
    const licenses=readJSON('data/licenses.json'), lic=licenses.find(l=>l.key===key.trim().toUpperCase());
    if(!lic) return res.json({success:false,error:'Key tidak ditemukan!'});
    if(lic.usedBy) return res.json({success:false,error:'Key sudah dipakai!'});
    const users=readJSON('data/users.json'), idx=users.findIndex(u=>u.id===req.session.userId);
    const expiry=new Date(); expiry.setDate(expiry.getDate()+lic.durasiHari);
    const addCredit = lic.credit || lic.quotaHarian || 0;
    users[idx]={...users[idx],licenseKey:key,licenseActive:true,licenseExpiry:expiry.toISOString(),plan:lic.plan,credit:(users[idx].credit||0)+addCredit};
    writeJSON('data/users.json',users); lic.usedBy=req.session.userId; lic.usedAt=new Date().toISOString(); writeJSON('data/licenses.json',licenses);
    res.json({success:true,msg:`\u2705 ${lic.plan} aktif! +${addCredit} credit. Berlaku ${lic.durasiHari} hari.`});
});

// ─── Topup Request (user) ──────────────────────────────────────────────────
app.post('/api/topup/request',requireLogin,(req,res)=>{
    const {amount, note}=req.body;
    if(!amount||isNaN(amount)||amount<1) return res.json({success:false,error:'Jumlah credit tidak valid!'});
    const users=readJSON('data/users.json'), user=users.find(u=>u.id===req.session.userId);
    if(!user) return res.json({success:false,error:'User tidak ditemukan!'});
    const topups=readJSON('data/topups.json');
    const topupId=uuidv4();
    topups.push({id:topupId,userId:user.id,userCode:user.userCode,username:user.username,amount:parseInt(amount),note:note||'',status:'pending',createdAt:new Date().toISOString()});
    writeJSON('data/topups.json',topups);
    notifTelegram(`\ud83d\udcb0 Request Topup!\n\ud83c\udd94 ${user.userCode}\n\ud83d\udc64 ${user.username}\n\ud83d\udcb3 ${amount} credit${note?'\n\ud83d\udcdd '+note:''}`);
    res.json({success:true,msg:'Request topup terkirim ke admin!'});
});

app.get('/api/topup/my',requireLogin,(req,res)=>{
    const topups=readJSON('data/topups.json');
    res.json(topups.filter(t=>t.userId===req.session.userId).reverse());
});

// ─── Member Order ────────────────────────────────────────────────────────
app.post('/api/member/order',async(req,res)=>{
    const {username,password,wa,metode,plan,harga,quota,hari}=req.body;
    if(!username||!password||!wa||!metode||!plan) return res.json({success:false,error:'Lengkapi semua field!'});
    if(!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.json({success:false,error:'Username 3-20 karakter, hanya huruf/angka/_'});
    if(password.length<6) return res.json({success:false,error:'Password min. 6 karakter!'});
    if(!/^62\d{8,13}$/.test(wa)) return res.json({success:false,error:'Format WA salah! Awali 62.'});
    const users=readJSON('data/users.json');
    if(users.find(u=>u.username===username)) return res.json({success:false,error:'Username sudah dipakai!'});
    const orders=readJSON('data/orders.json'), orderId=uuidv4();
    orders.push({id:orderId,userCode:makeUserCode(username),username,wa,metode,plan,harga:parseInt(harga),credit:parseInt(quota),hari:parseInt(hari),passwordHash:await bcrypt.hash(password,10),status:'pending',createdAt:new Date().toISOString()});
    writeJSON('data/orders.json',orders);
    notifTelegram(`\ud83d\udce6 Order Baru!\n\ud83c\udd94 ${makeUserCode(username)}\n\ud83d\udcb0 ${plan}\n\ud83d\udcf1 ${wa}\n\ud83d\udcb3 ${metode}\n\ud83d\udd11 ${orderId.slice(-8)}`);
    res.json({success:true,orderId,userCode:makeUserCode(username),msg:'Order diterima!'});
});

app.get('/api/admin/orders',requireAdmin,(req,res)=>res.json(readJSON('data/orders.json').reverse()));

app.post('/api/admin/orders/:id/confirm',requireAdmin,async(req,res)=>{
    const orders=readJSON('data/orders.json'), idx=orders.findIndex(o=>o.id===req.params.id);
    if(idx===-1) return res.json({success:false,error:'Order tidak ditemukan!'});
    if(orders[idx].status==='done') return res.json({success:false,error:'Sudah dikonfirmasi!'});
    const order=orders[idx];
    const users=readJSON('data/users.json');
    if(users.find(u=>u.username===order.username)) return res.json({success:false,error:'Username sudah ada!'});
    const expiry=new Date(); expiry.setDate(expiry.getDate()+order.hari);
    users.push({id:uuidv4(),userCode:order.userCode||makeUserCode(order.username),username:order.username,password:order.passwordHash,role:'user',licenseKey:`ORDER-${order.id.slice(-8)}`,licenseActive:true,licenseExpiry:expiry.toISOString(),plan:order.plan,credit:order.credit||order.quota||0,totalKirim:0,assignedWA:null,banned:false,createdAt:new Date().toISOString()});
    writeJSON('data/users.json',users);
    orders[idx].status='done'; orders[idx].confirmedAt=new Date().toISOString();
    writeJSON('data/orders.json',orders);
    notifTelegram(`\u2705 Order Dikonfirmasi!\n\ud83c\udd94 ${order.userCode}\n\ud83d\udce6 ${order.plan}`);
    res.json({success:true,msg:`\u2705 Akun ${order.username} (${order.userCode}) diaktifkan!`});
});

// ─── Admin Topups ────────────────────────────────────────────────────────
app.get('/api/admin/topups',requireAdmin,(req,res)=>res.json(readJSON('data/topups.json').reverse()));

// Approve topup (kasih credit)
app.post('/api/admin/topups/:id/approve',requireAdmin,(req,res)=>{
    const topups=readJSON('data/topups.json'), idx=topups.findIndex(t=>t.id===req.params.id);
    if(idx===-1) return res.json({success:false,error:'Topup tidak ditemukan!'});
    if(topups[idx].status==='done') return res.json({success:false,error:'Sudah di-approve!'});
    const t=topups[idx];
    const users=readJSON('data/users.json'), uIdx=users.findIndex(u=>u.id===t.userId);
    if(uIdx===-1) return res.json({success:false,error:'User tidak ditemukan!'});
    users[uIdx].credit = (users[uIdx].credit||0) + t.amount;
    writeJSON('data/users.json', users);
    topups[idx].status='done'; topups[idx].approvedAt=new Date().toISOString();
    writeJSON('data/topups.json', topups);
    io.to(`user:${t.userId}`).emit('credit-updated',{credit:users[uIdx].credit,added:t.amount});
    notifTelegram(`\u2705 Topup Approved!\n\ud83c\udd94 ${t.userCode}\n\u2795 ${t.amount} credit\n\ud83d\udcb0 Total: ${users[uIdx].credit}`);
    res.json({success:true,msg:`\u2705 +${t.amount} credit ke ${t.username}. Total: ${users[uIdx].credit}`});
});

// Tambah credit manual (tanpa request)
app.post('/api/admin/users/:id/credit',requireAdmin,(req,res)=>{
    const {amount, note}=req.body;
    if(!amount||isNaN(amount)) return res.json({success:false,error:'Jumlah tidak valid!'});
    const users=readJSON('data/users.json'), idx=users.findIndex(u=>u.id===req.params.id);
    if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'});
    const before = users[idx].credit||0;
    users[idx].credit = before + parseInt(amount);
    if(users[idx].credit<0) users[idx].credit=0;
    writeJSON('data/users.json', users);
    io.to(`user:${users[idx].id}`).emit('credit-updated',{credit:users[idx].credit,added:parseInt(amount)});
    // Log topup manual
    const topups=readJSON('data/topups.json');
    topups.push({id:uuidv4(),userId:users[idx].id,userCode:users[idx].userCode,username:users[idx].username,amount:parseInt(amount),note:note||'manual by admin',status:'done',createdAt:new Date().toISOString(),approvedAt:new Date().toISOString()});
    writeJSON('data/topups.json',topups);
    res.json({success:true,msg:`\u2705 Credit ${users[idx].username} diubah: ${before} \u2192 ${users[idx].credit}`,credit:users[idx].credit});
});

// ─── WA Pool ───────────────────────────────────────────────────────────
app.get('/api/admin/wa-pool',requireAdmin,(req,res)=>res.json(readJSON('data/wa-pool.json')));
app.post('/api/admin/wa-pool/add',requireAdmin,async(req,res)=>{ const pool=readJSON('data/wa-pool.json'),poolId=uuidv4(); pool.push({id:poolId,nomor:'',status:'pending',assignedTo:null,proxy:null,createdAt:new Date().toISOString()}); writeJSON('data/wa-pool.json',pool); res.json({success:true,poolId,msg:'Slot ditambahkan. Scan QR.'}); connectPoolQR(poolId); });
app.post('/api/admin/wa-pool/:id/proxy',requireAdmin,(req,res)=>{
    const {proxyUrl}=req.body, pool=readJSON('data/wa-pool.json'), idx=pool.findIndex(p=>p.id===req.params.id);
    if(idx===-1) return res.json({success:false,error:'Pool tidak ditemukan!'});
    if(proxyUrl&&proxyUrl.trim()){ try{ const u=new URL(proxyUrl.trim()); if(!['socks5:','socks4:','socks:','http:','https:'].includes(u.protocol)) return res.json({success:false,error:'Format proxy tidak valid!'}); }catch(e){ return res.json({success:false,error:'URL proxy tidak valid!'}); } }
    pool[idx].proxy=proxyUrl&&proxyUrl.trim()?proxyUrl.trim():null; writeJSON('data/wa-pool.json',pool);
    if(pool[idx].status==='connected'||pool[idx].status==='qr'){ const ps=getPoolSession(req.params.id); if(ps.sock){try{ps.sock.end();}catch(e){} ps.sock=null;} ps.status='disconnected'; setTimeout(()=>connectPoolQR(req.params.id),1500); }
    res.json({success:true,msg:pool[idx].proxy?'\u2705 Proxy diset.':'\u2705 Proxy dihapus.',proxy:pool[idx].proxy});
});
app.delete('/api/admin/wa-pool/:id',requireAdmin,(req,res)=>{ const {id}=req.params; let pool=readJSON('data/wa-pool.json'); const ps=getPoolSession(id); if(ps.sock){try{ps.sock.end();}catch(e){}delete poolSessions[id];} pool=pool.filter(p=>p.id!==id); writeJSON('data/wa-pool.json',pool); const users=readJSON('data/users.json'); users.forEach(u=>{if(u.assignedWA===id){u.assignedWA=null;const ses=getUserSession(u.id);ses.status='disconnected';ses.sock=null;io.to(`user:${u.id}`).emit('status',{status:'disconnected',msg:'Nomor WA dicabut.'});}}); writeJSON('data/users.json',users); res.json({success:true}); });
app.post('/api/admin/wa-pool/assign',requireAdmin,(req,res)=>{ const {poolId,userId}=req.body; if(!poolId||!userId) return res.json({success:false,error:'poolId dan userId wajib!'}); const pool=readJSON('data/wa-pool.json'),p=pool.find(p=>p.id===poolId); if(!p) return res.json({success:false,error:'Pool tidak ditemukan!'}); if(p.status!=='connected') return res.json({success:false,error:'Nomor belum connected!'}); const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===userId); if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'}); users.forEach(u=>{if(u.assignedWA===poolId&&u.id!==userId)u.assignedWA=null;}); users[idx].assignedWA=poolId; writeJSON('data/users.json',users); pool[pool.findIndex(p=>p.id===poolId)].assignedTo=userId; writeJSON('data/wa-pool.json',pool); const ps=getPoolSession(poolId),ses=getUserSession(userId); ses.sock=ps.sock;ses.status=ps.status;ses.poolId=poolId; io.to(`user:${userId}`).emit('status',{status:ps.status,msg:ps.status==='connected'?`\u2705 Terhubung: ${p.nomor}`:'Menghubungkan...'}); res.json({success:true,msg:`\u2705 ${p.nomor} di-assign ke ${users[idx].username}`}); });
app.post('/api/admin/wa-pool/unassign',requireAdmin,(req,res)=>{ const {userId}=req.body; const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===userId); if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'}); users[idx].assignedWA=null; writeJSON('data/users.json',users); const ses=getUserSession(userId); ses.sock=null;ses.status='disconnected';ses.poolId=null; io.to(`user:${userId}`).emit('status',{status:'disconnected',msg:'Nomor WA dicabut.'}); res.json({success:true}); });

// ─── Admin Users ─────────────────────────────────────────────────────────
app.get('/api/admin/users',requireAdmin,(req,res)=>{ const pool=readJSON('data/wa-pool.json'); res.json(readJSON('data/users.json').map(u=>{ const wp=u.assignedWA?pool.find(p=>p.id===u.assignedWA):null; return {id:u.id,userCode:u.userCode||makeUserCode(u.username),username:u.username,role:u.role,plan:u.plan||'-',licenseActive:u.licenseActive,licenseExpiry:u.licenseExpiry,credit:u.credit||0,totalKirim:u.totalKirim||0,assignedWA:u.assignedWA,assignedNomor:wp?.nomor||null,banned:u.banned||false,createdAt:u.createdAt}; })); });
app.get('/api/admin/users/:id',requireAdmin,(req,res)=>{ const users=readJSON('data/users.json'),pool=readJSON('data/wa-pool.json'),user=users.find(u=>u.id===req.params.id); if(!user) return res.json({success:false,error:'User tidak ditemukan!'}); const wp=user.assignedWA?pool.find(p=>p.id===user.assignedWA):null; res.json({success:true,user:{id:user.id,userCode:user.userCode||makeUserCode(user.username),username:user.username,role:user.role,plan:user.plan||'-',licenseActive:user.licenseActive,licenseExpiry:user.licenseExpiry,credit:user.credit||0,totalKirim:user.totalKirim||0,assignedWA:user.assignedWA,assignedNomor:wp?.nomor||null,banned:user.banned||false,createdAt:user.createdAt}}); });
app.post('/api/admin/users/:id/reset-password',requireAdmin,async(req,res)=>{ const {newPassword}=req.body; if(!newPassword||newPassword.length<6) return res.json({success:false,error:'Min 6 karakter!'}); const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===req.params.id); if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'}); if(users[idx].role==='admin') return res.json({success:false,error:'Tidak bisa reset admin!'}); users[idx].password=await bcrypt.hash(newPassword,10); writeJSON('data/users.json',users); res.json({success:true,msg:`\u2705 Password ${users[idx].username} direset.`}); });
app.post('/api/admin/users/:id/ban',requireAdmin,(req,res)=>{ const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===req.params.id); if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'}); if(users[idx].role==='admin') return res.json({success:false,error:'Tidak bisa ban admin!'}); users[idx].banned=!users[idx].banned; writeJSON('data/users.json',users); if(users[idx].banned) io.to(`user:${users[idx].id}`).emit('force-logout',{msg:'Akun dinonaktifkan.'}); res.json({success:true,banned:users[idx].banned,msg:users[idx].banned?`\ud83d\udeab ${users[idx].username} banned.`:`\u2705 ${users[idx].username} unbanned.`}); });
app.post('/api/admin/users/:id/extend',requireAdmin,(req,res)=>{ const {days}=req.body; if(!days||isNaN(days)||days<1) return res.json({success:false,error:'Hari tidak valid!'}); const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===req.params.id); if(idx===-1) return res.json({success:false,error:'User tidak ditemukan!'}); const current=users[idx].licenseExpiry?new Date(users[idx].licenseExpiry):new Date(); const base=current<new Date()?new Date():current; base.setDate(base.getDate()+parseInt(days)); users[idx].licenseExpiry=base.toISOString();users[idx].licenseActive=true; writeJSON('data/users.json',users); res.json({success:true,msg:`\u2705 Diperpanjang ${days} hari. s/d ${base.toLocaleDateString('id-ID')}.`}); });
app.delete('/api/admin/users/:id',requireAdmin,(req,res)=>{ const users=readJSON('data/users.json'),user=users.find(u=>u.id===req.params.id); if(!user) return res.json({success:false,error:'User tidak ditemukan!'}); if(user.role==='admin') return res.json({success:false,error:'Tidak bisa hapus admin!'}); const ses=getUserSession(user.id); if(ses.sock){try{ses.sock.end();}catch(e){}} delete sessions[user.id]; io.to(`user:${user.id}`).emit('force-logout',{msg:'Akun dihapus.'}); writeJSON('data/users.json',users.filter(u=>u.id!==req.params.id)); res.json({success:true,msg:`\u2705 ${user.username} dihapus.`}); });
app.post('/api/admin/generate-key',requireAdmin,(req,res)=>{ const {plan,credit,durasiHari}=req.body; if(!plan||!credit||!durasiHari) return res.json({success:false,error:'Lengkapi field!'}); const key=`${plan.toUpperCase()}-${uuidv4().slice(0,8).toUpperCase()}`; const licenses=readJSON('data/licenses.json'); licenses.push({key,plan,credit:parseInt(credit),durasiHari:parseInt(durasiHari),usedBy:null,usedAt:null,createdAt:new Date().toISOString()}); writeJSON('data/licenses.json',licenses); res.json({success:true,key}); });
app.get('/api/admin/licenses',requireAdmin,(req,res)=>res.json(readJSON('data/licenses.json')));

// ─── WA User Routes ──────────────────────────────────────────────────────────
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

app.post('/api/reply',requireLogin,async(req,res)=>{
    const {to,pesan}=req.body; if(!to||!pesan) return res.json({success:false,error:'Nomor dan pesan wajib!'});
    const sock=getUserSock(req.session.userId); if(!sock) return res.json({success:false,error:'WA belum terhubung!'});
    try{ await sock.sendMessage(to.replace(/\D/g,'')+'@s.whatsapp.net',{text:pesan}); res.json({success:true,msg:`\u2705 Terkirim ke ${to}`}); }catch(e){ res.json({success:false,error:e.message}); }
});

app.post('/api/blast',requireLogin,async(req,res)=>{
    const users=readJSON('data/users.json'),user=users.find(u=>u.id===req.session.userId);
    if(!user) return res.json({success:false,error:'User tidak ditemukan!'});
    if(!user.licenseActive) return res.json({success:false,error:'Aktifkan lisensi dulu!'});
    if(user.licenseExpiry&&new Date()>new Date(user.licenseExpiry)) return res.json({success:false,error:'Lisensi expired!'});
    let sockGetter;
    if(user.assignedWA){ const ps=getPoolSession(user.assignedWA); if(ps.status!=='connected') return res.json({success:false,error:'Nomor pool belum connected!'}); sockGetter=()=>ps.sock; }
    else if(user.role==='admin'){ sockGetter=()=>{ const s=getRotasiSock(req.session.userId); if(s) return s; const ses=getUserSession(req.session.userId); return ses.status==='connected'?ses.sock:null; }; if(!sockGetter()) return res.json({success:false,error:'WA belum terhubung!'}); }
    else{ const ses=getUserSession(req.session.userId); if(ses.status!=='connected') return res.json({success:false,error:'WA belum terhubung!'}); sockGetter=()=>ses.sock; }
    const ses=getUserSession(req.session.userId); if(ses.isBlasting) return res.json({success:false,error:'Blast sedang berjalan!'});
    const {nomor,pesan}=req.body; if(!nomor||!pesan) return res.json({success:false,error:'Nomor dan pesan wajib!'});
    const allNomor=nomor.split('\n').map(n=>n.trim()).filter(n=>/^62\d{8,13}$/.test(n));
    if(!allNomor.length) return res.json({success:false,error:'Tidak ada nomor valid!'});
    const credit=user.credit||0;
    if(credit<=0) return res.json({success:false,error:'Credit habis! Topup dulu.'});
    const blastNomor=allNomor.slice(0,credit); ses.blastLog=[];ses.isBlasting=true;
    res.json({success:true,total:blastNomor.length,catatan:blastNomor.length<allNomor.length?`Hanya ${blastNomor.length} dikirim (credit terbatas)`:null});
    jalankanBlast(req.session.userId,sockGetter,pesan,blastNomor);
});

app.post('/api/blast/stop',requireLogin,(req,res)=>{ getUserSession(req.session.userId).isBlasting=false; io.to(`user:${req.session.userId}`).emit('blast-stopped',{}); res.json({success:true}); });
app.post('/api/reset-sesi',requireLogin,async(req,res)=>{ const userId=req.session.userId,users=readJSON('data/users.json'),user=users.find(u=>u.id===userId); if(user?.assignedWA) return res.json({success:false,error:'Pakai nomor pool. Hubungi admin.'}); const ses=getUserSession(userId); try{ if(ses.sock){try{ses.sock.end();}catch(e){}}ses.sock=null;ses.status='disconnected'; fs.rmSync(`sesi_${userId}`,{recursive:true,force:true}); res.json({success:true,msg:'Sesi dihapus.'}); setTimeout(()=>connectPersonal(userId),1500); }catch(e){ res.json({success:false,error:e.message}); } });
app.post('/api/upload-nomor',requireLogin,upload.single('file'),(req,res)=>{ try{ const content=fs.readFileSync(req.file.path,'utf8'); fs.unlinkSync(req.file.path); const unique=[...new Set(content.split(/[\n,;]+/).map(n=>n.replace(/\D/g,'')).filter(n=>/^62\d{8,13}$/.test(n)))]; res.json({success:true,nomor:unique,total:unique.length}); }catch(e){ res.json({success:false,error:e.message}); } });

async function jalankanBlast(userId,sockGetter,pesan,numbers){
    const ses=getUserSession(userId);
    io.to(`user:${userId}`).emit('blast-start',{total:numbers.length});
    for(let i=0;i<numbers.length;i++){
        if(!ses.isBlasting) break;
        // Cek credit setiap iterasi
        const usersCheck=readJSON('data/users.json'), userCheck=usersCheck.find(u=>u.id===userId);
        if(!userCheck || (userCheck.credit||0) <= 0){ break; }
        const pesanFinal=parseSpintax(pesan), sock=typeof sockGetter==='function'?sockGetter():sockGetter;
        if(!sock){ const log={no:numbers[i],status:'gagal',index:i+1,total:numbers.length,time:new Date().toLocaleTimeString('id-ID')}; ses.blastLog.push(log); io.to(`user:${userId}`).emit('blast-progress',log); continue; }
        let status='gagal';
        try{
            await sock.sendMessage(`${numbers[i]}@s.whatsapp.net`,{text:pesanFinal});
            status='sukses';
            // Kurangi credit, tambah totalKirim
            const users=readJSON('data/users.json'),idx=users.findIndex(u=>u.id===userId);
            if(idx!==-1){
                users[idx].credit = Math.max(0, (users[idx].credit||0) - 1);
                users[idx].totalKirim = (users[idx].totalKirim||0) + 1;
                writeJSON('data/users.json',users);
                io.to(`user:${userId}`).emit('credit-updated',{credit:users[idx].credit});
            }
        }catch(err){}
        const log={no:numbers[i],status,index:i+1,total:numbers.length,time:new Date().toLocaleTimeString('id-ID')};
        ses.blastLog.push(log); io.to(`user:${userId}`).emit('blast-progress',log);
        if(i<numbers.length-1&&ses.isBlasting) await new Promise(r=>setTimeout(r,Math.floor(Math.random()*4000)+4000));
    }
    ses.isBlasting=false;
    io.to(`user:${userId}`).emit('blast-done',{total:numbers.length,sukses:ses.blastLog.filter(l=>l.status==='sukses').length,gagal:ses.blastLog.filter(l=>l.status==='gagal').length});
}

io.on('connection',(socket)=>{
    const userId=socket.request.session?.userId; if(!userId) return;
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
            socket.emit('status',{status:'connected',msg:`\u2705 ${aktif.length} nomor pool (rotasi)`});
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
    console.log(`\ud83d\udccc Login: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD} (ID: BG_${ADMIN_USERNAME})`);
    setTimeout(autoReconnectPool,3000);
});
