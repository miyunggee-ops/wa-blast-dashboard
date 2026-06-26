// ─── PROTEKSI SOURCE CODE ─────────────────────────────────────────────────────
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
    if (e.key === 'F12') { e.preventDefault(); return false; }
    if (e.ctrlKey && e.shiftKey && ['I','J','C','U'].includes(e.key.toUpperCase())) { e.preventDefault(); return false; }
    if (e.ctrlKey && e.key.toUpperCase() === 'U') { e.preventDefault(); return false; }
    if (e.ctrlKey && e.key.toUpperCase() === 'S') { e.preventDefault(); return false; }
});
(function devtools(){
    const threshold = 160;
    setInterval(()=>{
        if(window.outerWidth - window.innerWidth > threshold || window.outerHeight - window.innerHeight > threshold){
            document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0f1117;color:#ff4757;font-family:sans-serif;font-size:18px;font-weight:700;">&#9888; Akses ditolak</div>';
        }
    }, 1000);
})();
// ─────────────────────────────────────────────────────────────────────────────
