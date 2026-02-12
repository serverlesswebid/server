import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { encryptJSON, decryptJSON } from '../src/utils'
import { uploadImage } from '../src/modules/cloudinary'
import * as widgetModule from '../src/modules/widget'

const app = new Hono()
const JWT_SECRET = 'BantarCaringin1BantarCaringin2BantarCaringin3'
const RELAY_URL = "https://pasdigi-relay.hf.space/proxy";
const RELAY_SECRET = "BantarCaringin1";

// --- HELPERS ---
const trackVisit = (c, page, referrer) => {
    try {
        if (c.env.ANALYTICS_ENGINE && typeof c.env.ANALYTICS_ENGINE.writeData === 'function') {
            c.env.ANALYTICS_ENGINE.writeData({
                blobs: [page.slug, page.title, referrer || 'direct', 'view'],
                indexes: [String(page.id)] 
            });
        }
    } catch (e) { console.error("AE Error:", e.message); }
};

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- INIT DB ---
async function initDB(db) {
    await db.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, name TEXT, role TEXT)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, title TEXT, html_content TEXT, css_content TEXT, product_config_json TEXT, product_type TEXT, provider TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS credentials (provider_slug TEXT PRIMARY KEY, encrypted_data TEXT, iv TEXT)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS payment_templates (slug TEXT PRIMARY KEY, name TEXT, api_endpoint TEXT, method TEXT, headers_json TEXT, body_json TEXT, response_mapping TEXT, webhook_config TEXT)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS shipping_templates (slug TEXT PRIMARY KEY, name TEXT, api_endpoint TEXT, method TEXT, headers_json TEXT, body_json TEXT, response_mapping TEXT)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT UNIQUE, page_id INTEGER, amount INTEGER, status TEXT, customer_info TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS analytics (id INTEGER PRIMARY KEY AUTOINCREMENT, page_id INTEGER, event_type TEXT, referrer TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();
    await widgetModule.initWidgetDB(db);
    await db.prepare(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, page_id INTEGER, subject TEXT, name TEXT, email TEXT, phone TEXT, message TEXT, status TEXT DEFAULT 'unread', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS analytics_rekap (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, views INTEGER, period_start DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();
}

// --- ENGINE PEMBAYARAN ---
async function executeGenericAPI(c, type, slug, payload) {
    const table = type === 'shipping' ? 'shipping_templates' : 'payment_templates';
    const template = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE slug = ?`).bind(slug).first();
    if (!template) throw new Error(`Template '${slug}' tidak ditemukan.`);

    const providerSlug = slug.split('-')[0]; 
    const credRow = await c.env.DB.prepare(`SELECT encrypted_data, iv FROM credentials WHERE provider_slug = ?`).bind(providerSlug).first();
    if (!credRow) throw new Error(`Credentials untuk '${providerSlug}' belum disetting.`);

    let creds;
    try {
        const secret = c.env.APP_MASTER_KEY || JWT_SECRET;
        const decrypted = await decryptJSON(credRow.encrypted_data, credRow.iv, secret);
        creds = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;
    } catch (e) { throw new Error("Gagal dekripsi kredensial."); }

    let extraHeaders = {};
    if (slug.includes('flashpay')) {
        const authRes = await fetch(RELAY_URL, {
            method: 'POST',
            headers: { "Content-Type": "application/json", "x-relay-auth": RELAY_SECRET },
            body: JSON.stringify({
                target_url: "https://sandbox-secure.flashmobile.id/auth/v2/access-token",
                target_method: "POST",
                target_headers: { "Accept": "application/json", "Content-Type": "application/json" },
                target_payload: { client_key: creds.client_key, server_key: creds.server_key }
            })
        });
        const authData = await authRes.json();
        if (!authRes.ok || !authData?.data?.token) throw new Error("Auth Relay Gagal");
        extraHeaders['Authorization'] = `Bearer ${authData.data.token}`;
        extraHeaders['X-Client-Key'] = creds.client_key;
    }

    const replaceVars = (str) => str.replace(/{{(.*?)}}/g, (m, k) => {
        const keys = k.trim().split('.');
        let val = payload;
        for (let key of keys) val = val?.[key];
        return val !== undefined ? val : m;
    });

    let bodyRaw = template.body_json || '{}';
    if (slug.includes('flashpay')) {
        if (payload.customer?.phone) payload.customer.phone_clean = payload.customer.phone.replace(/[^0-9]/g, '');
        bodyRaw = JSON.stringify({
            external_id: "INV-" + Date.now(),
            payment_type: [slug.toUpperCase().replace(/-/g, '_')],
            currency: "IDR",
            transaction_amount: Number(payload.amount),
            customer_id: String(payload.customer.phone).replace(/[^0-9]/g, ''),
            va_type: "CLOSE_AMOUNT",
            va_reusability: "SINGLE_USE",
            customer_details: { name: payload.customer.name, email: "customer@mail.com", phone: payload.customer.phone },
            item_details: [{ item_id: "ITEM-01", information: payload.item_name || "Produk", amount: Number(payload.amount), beneficiary_bank: "MNC", beneficiary_account: "5279910282", beneficiary_name: "PASDIGI" }]
        });
    }
    
    const bodyFinal = replaceVars(bodyRaw);
    let headersFinal = { ...JSON.parse(template.headers_json || '{}'), ...extraHeaders }; 

    let res;
    if (slug.includes('flashpay')) {
        res = await fetch(RELAY_URL, {
            method: 'POST',
            headers: { "Content-Type": "application/json", "X-Relay-Secret": RELAY_SECRET },
            body: JSON.stringify({ target_url: template.api_endpoint, target_method: template.method || 'POST', target_headers: headersFinal, target_payload: JSON.parse(bodyFinal) })
        });
    } else {
        res = await fetch(template.api_endpoint, { method: template.method || 'POST', headers: headersFinal, body: bodyFinal });
    }

    const resData = await res.json();
    const mapping = JSON.parse(template.response_mapping || '{}');
    const result = {};
    const getVal = (path, src) => path.split('.').reduce((o, i) => o?.[i], src);
    for (const [key, path] of Object.entries(mapping)) result[key] = getVal(path, resData) || null;
    result._raw = resData; 
    return result;
}

// --- HANDLER & MIDDLEWARE ---
app.onError((err, c) => { console.error(err); return c.json({ success: false, message: err.message }, 500); });

async function serveAsset(c, path) {
    try {
        const url = new URL(path, c.req.url);
        const response = await c.env.ASSETS.fetch(url);
        if (path.endsWith('.html')) {
            const newRes = new Response(response.body, response);
            newRes.headers.set('Cache-Control', 'no-store, max-age=0');
            return newRes;
        }
        return response;
    } catch (e) { return c.text('Not Found', 404); }
}

const requireAuth = async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    const isAdminUI = path.startsWith('/admin');
    const isAdminAPI = path.startsWith('/api/admin');

    if (!isAdminUI && !isAdminAPI) { await next(); return; }
    if (path === '/admin/login' || path === '/admin/login.html') { await next(); return; }

    let token = getCookie(c, 'auth_token');
    const authHeader = c.req.header('Authorization');
    if (!token && authHeader && authHeader.startsWith('Bearer ')) token = authHeader.split(' ')[1];

    if (!token) {
        if (isAdminAPI) return c.json({ success: false, message: 'Unauthorized' }, 401);
        return c.redirect('/login'); 
    }

    try {
        const secret = c.env.APP_MASTER_KEY || JWT_SECRET;
        const payload = await verify(token, secret, 'HS256');
        c.set('user', payload);
        await next(); 
    } catch (e) {
        deleteCookie(c, 'auth_token');
        if (isAdminAPI) return c.json({ success: false, message: 'Session Expired' }, 401);
        return c.redirect('/login');
    }
};
app.use('*', requireAuth); 

// --- ROUTES ---
app.post('/api/login', async (c) => {
    try {
        const { email, password } = await c.req.json();
        await initDB(c.env.DB);
        const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
        if (!user) return c.json({ success: false, message: 'Email tidak ditemukan' }, 401);
        const inputHash = await sha256(password);
        if (user.password !== inputHash && user.password !== password) return c.json({ success: false, message: 'Password salah' }, 401);
        
        const secret = c.env.APP_MASTER_KEY || JWT_SECRET;
        const token = await sign({ id: user.id, email: user.email, role: user.role, exp: Math.floor(Date.now() / 1000) + 86400 }, secret, 'HS256');
        setCookie(c, 'auth_token', token, { path: '/', secure: true, httpOnly: true, maxAge: 86400, sameSite: 'Lax' });
        return c.json({ success: true, token });
    } catch (e) { return c.json({ success: false, error: e.message }, 500); }
});

app.post('/api/setup-first-user', async (c) => {
    try {
        const { email, password, name } = await c.req.json();
        const hashedPassword = await sha256(password);
        await c.env.DB.prepare("INSERT INTO users (email, password, name, role) VALUES (?, ?, ?, 'admin')").bind(email, hashedPassword, name || 'Admin').run();
        return c.json({ success: true });
    } catch (e) { return c.json({ success: false, error: e.message }); }
});

app.get('/api/internal/rekap-analytics', async (c) => {
    if (c.req.header('x-cron-secret') !== "BantarCaringin1") return c.json({ success: false, message: "Kunci Salah!" }, 401);
    try {
        await runAnalyticsRekap(c.env);
        return c.json({ success: true, message: "Rekap Berhasil!" });
    } catch (e) { return c.json({ success: false, error: e.message }, 500); }
});

app.get('/api/logout', (c) => { deleteCookie(c, 'auth_token'); return c.redirect('/login'); });
app.get('/login', (c) => serveAsset(c, '/login.html'));
app.get('/admin', (c) => c.redirect('/admin/dashboard'));
app.get('/admin/*', (c) => serveAsset(c, '/_views' + c.req.path.replace('/admin','').replace(/^\/$/,'/dashboard') + '.html'));
app.post('/api/admin/upload-image', uploadImage);

// --- SETTINGS, PAGES, WIDGETS, ETC ---
app.get('/api/admin/homepage-slug', async (c) => {
    try { const s = await c.env.DB.prepare("SELECT value FROM settings WHERE key='homepage_slug'").first(); return c.json({ slug: s?.value || null }); } catch (e) { return c.json({ error: e.message }, 500); }
});
app.post('/api/admin/set-homepage', async (c) => {
    try {
        const { slug } = await c.req.json();
        await c.env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('homepage_slug', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(slug).run();
        return c.json({ success: true });
    } catch (e) { return c.json({ error: e.message }, 500); }
});
app.get('/api/admin/pages', async (c) => { const r = await c.env.DB.prepare("SELECT id, slug, title, product_type, created_at FROM pages ORDER BY created_at DESC").all(); return c.json(r.results); });
app.post('/api/admin/pages', async (c) => {
    const { slug, title, html, css, product_config, product_type } = await c.req.json();
    await c.env.DB.prepare(`INSERT INTO pages (slug, title, html_content, css_content, product_config_json, product_type) VALUES (?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET title=excluded.title, html_content=excluded.html_content, css_content=excluded.css_content, product_config_json=excluded.product_config_json, product_type=excluded.product_type`).bind(slug, title, html, css, JSON.stringify(product_config), product_type || 'physical').run();
    return c.json({ success: true });
});
app.get('/api/admin/pages/:slug', async (c) => {
    const page = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(c.req.param('slug')).first();
    if(page) page.product_config_json = JSON.parse(page.product_config_json || '{}');
    return c.json(page || {});
});
app.delete('/api/admin/pages/:id', async (c) => {
    try { await c.env.DB.prepare("DELETE FROM pages WHERE id = ?").bind(c.req.param('id')).run(); return c.json({ success: true }); } catch (e) { return c.json({ error: e.message }, 500); }
});

const WIDGET_CACHE_KEY = 'widgets_data_full';
app.get('/api/widgets', async (c) => {
    try {
        if (c.env.WIDGET_CACHE) { const d = await c.env.WIDGET_CACHE.get(WIDGET_CACHE_KEY); if (d) return c.json(JSON.parse(d)); }
        const w = await widgetModule.getWidgets(c.env);
        if (c.env.WIDGET_CACHE && w.length) await c.env.WIDGET_CACHE.put(WIDGET_CACHE_KEY, JSON.stringify(w), { expirationTtl: 3600 });
        return c.json(w);
    } catch (e) { return c.json({ success: false, error: e.message }, 500); }
});
app.post('/api/admin/widgets', async (c) => {
    try {
        await widgetModule.saveWidget(c.env, await c.req.json());
        if (c.env.WIDGET_CACHE) await c.env.WIDGET_CACHE.delete(WIDGET_CACHE_KEY);
        return c.json({ success: true });
    } catch (e) { return c.json({ success: false, error: e.message }, 500); }
});
app.delete('/api/admin/widgets/:id', async (c) => {
    try {
        await widgetModule.deleteWidget(c.env, c.req.param('id'));
        if (c.env.WIDGET_CACHE) await c.env.WIDGET_CACHE.delete(WIDGET_CACHE_KEY);
        return c.json({ success: true });
    } catch (e) { return c.json({ success: false, error: e.message }, 500); }
});
app.delete('/api/admin/cache/widgets', async (c) => {
    try {
        if (!c.env.WIDGET_CACHE) return c.json({ success: false }, 500);
        const l = await c.env.WIDGET_CACHE.list();
        for (const k of l.keys) await c.env.WIDGET_CACHE.delete(k.name);
        return c.json({ success: true });
    } catch (e) { return c.json({ success: false }, 500); }
});

app.get('/api/admin/messages', async (c) => { try { const r = await c.env.DB.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 100").all(); return c.json(r.results); } catch (e) { return c.json({ error: e.message }, 500); } });
app.patch('/api/admin/messages/:id', async (c) => { try { await c.env.DB.prepare("UPDATE messages SET status = ? WHERE id = ?").bind((await c.req.json()).status, c.req.param('id')).run(); return c.json({ success: true }); } catch (e) { return c.json({ error: e.message }, 500); } });
app.delete('/api/admin/messages/:id', async (c) => { try { await c.env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(c.req.param('id')).run(); return c.json({ success: true }); } catch (e) { return c.json({ error: e.message }, 500); } });

app.get('/api/admin/analytics/data', async (c) => {
    try {
        const stats = await c.env.DB.prepare(`SELECT SUM(views) as total_views, SUM(CASE WHEN date(created_at) = date('now') THEN views ELSE 0 END) as today_views FROM analytics_rekap`).first();
        const top = await c.env.DB.prepare(`SELECT p.title, r.slug, SUM(r.views) as views FROM analytics_rekap r JOIN pages p ON LOWER(r.slug) = LOWER(p.slug) GROUP BY r.slug ORDER BY views DESC LIMIT 10`).all();
        return c.json({ success: true, stats: { total_views: stats?.total_views || 0, today_views: stats?.today_views || 0 }, top_pages: top.results || [] });
    } catch(e) { return c.json({ success: false, error: e.message }, 500); }
});
app.get('/api/admin/reports', async (c) => {
    try {
        const w = await c.env.DB.prepare(`SELECT DATE(created_at) as date, SUM(views) as views FROM analytics_rekap WHERE created_at >= date('now', '-7 days') GROUP BY DATE(created_at) ORDER BY date ASC`).all();
        const l = await c.env.DB.prepare(`SELECT count(*) as total FROM messages`).first();
        const v = await c.env.DB.prepare(`SELECT sum(views) as total FROM analytics_rekap`).first();
        return c.json({ success: true, chart_data: w.results || [], summary: { total_leads: l?.total || 0, total_views: v?.total || 0 } });
    } catch (e) { return c.json({ error: e.message }, 500); }
});

app.post('/api/admin/credentials', async (c) => {
    const { provider, data } = await c.req.json();
    const { encrypted, iv } = await encryptJSON(data, c.env.APP_MASTER_KEY || JWT_SECRET);
    await c.env.DB.prepare(`INSERT INTO credentials (provider_slug, encrypted_data, iv) VALUES (?, ?, ?) ON CONFLICT(provider_slug) DO UPDATE SET encrypted_data=excluded.encrypted_data, iv=excluded.iv`).bind(provider, encrypted, iv).run();
    return c.json({ success: true });
});
app.get('/api/admin/templates', async (c) => { const t = c.req.query('type') === 'shipping' ? 'shipping_templates' : 'payment_templates'; const r = await c.env.DB.prepare(`SELECT * FROM ${t}`).all(); return c.json(r.results); });
app.post('/api/admin/templates', async (c) => {
    const { type, data } = await c.req.json();
    const t = type === 'shipping' ? 'shipping_templates' : 'payment_templates';
    await c.env.DB.prepare(`INSERT INTO ${t} (slug, name, api_endpoint, method, headers_json, body_json, response_mapping, webhook_config) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name, api_endpoint=excluded.api_endpoint, method=excluded.method, headers_json=excluded.headers_json, body_json=excluded.body_json, response_mapping=excluded.response_mapping, webhook_config=excluded.webhook_config`).bind(data.slug, data.name, data.api_endpoint, data.method, data.headers_json, data.body_json, data.response_mapping, data.webhook_config || '{}').run();
    return c.json({ success: true });
});
app.delete('/api/admin/templates', async (c) => { const t = c.req.query('type') === 'shipping' ? 'shipping_templates' : 'payment_templates'; await c.env.DB.prepare(`DELETE FROM ${t} WHERE slug = ?`).bind(c.req.query('slug')).run(); return c.json({ success: true }); });

// --- PUBLIC API ---
app.post('/api/public/contact', async (c) => {
    try {
        await initDB(c.env.DB);
        let b;
        const ct = c.req.header('Content-Type');
        if (ct && ct.includes('application/json')) b = await c.req.json(); else b = await c.req.parseBody();
        if (!b.name || !b.message) return c.json({ error: "Isi nama & pesan!" }, 400);
        await c.env.DB.prepare(`INSERT INTO messages (page_id, subject, name, email, phone, message) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(b.page_id || 0, b.subject || 'General', b.name, b.email || '', b.phone || '', b.message).run();
        if (!ct || !ct.includes('application/json')) return c.redirect(c.req.header('Referer') + '?status=sent');
        return c.json({ success: true });
    } catch (e) { return c.json({ error: e.message }, 500); }
});

app.post('/api/public/checkout', async (c) => {
    try {
        const b = await c.req.json();
        if (!b.slug_payment || !b.customer?.phone) return c.json({ error: "Data kurang!" }, 400);
        const p = await c.env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(b.page_id).first();
        const cfg = JSON.parse(p.product_config_json || '{}');
        let price = Number(cfg.price || 0);
        let name = p.title;
        if (cfg.variants && cfg.variants[b.variant_index]) { price = Number(cfg.variants[b.variant_index].price); name += ` (${cfg.variants[b.variant_index].name})`; }
        let amt = price * parseInt(b.quantity || 1);
        if (b.take_bump && cfg.order_bump?.active) { amt += Number(cfg.order_bump.price); if (cfg.order_bump.title) name += ` + ${cfg.order_bump.title}`; }
        if (b.coupon_code && cfg.coupons) {
            const cp = cfg.coupons.find(x => x.code.toUpperCase() === b.coupon_code.toUpperCase());
            if (cp) amt = Math.max(0, amt - (cp.type === 'percent' ? (amt * cp.value / 100) : cp.value));
        }
        const res = await executeGenericAPI(c, 'payment', b.slug_payment, { ...b, amount: amt, item_name: name + (b.quantity > 1 ? ` (x${b.quantity})` : '') });
        return c.json({ payment_url: res.payment_url || res._raw?.data?.payment_url });
    } catch (e) { return c.json({ error: "Gagal: " + e.message }, 500); }
});

// ===============================================
// 7. PUBLIC PAGE RENDERING (FINAL FIX)
// ===============================================
async function renderPage(c, page) {
    const config = JSON.parse(page.product_config_json || '{}');
    const bridgeCSS = `body { min-height: 100vh; background-color: #ffffff; overflow-x: hidden; font-family: 'Inter', sans-serif; } .swal2-container { z-index: 99999 !important; } .countdown-number { font-weight: 900; } [x-cloak] { display: none !important; }`;
    const tailwindConfig = `tailwind.config = { darkMode: 'class', theme: { extend: { fontFamily: { sans: ['Inter', 'sans-serif'] }, colors: { theme: { 50:'#eef2ff', 600:'#4f46e5' } } } } }`;

    const systemScripts = `
    <script>
        window.BS_DATA = ${JSON.stringify({ page_id: page.id, title: page.title, config: config, active_payments: config.active_payments || [] })};
        
        // --- LIVE COUNTDOWN ENGINE ---
        document.addEventListener('DOMContentLoaded', () => {
            const timers = document.querySelectorAll('.js-countdown, [data-expire]');
            timers.forEach(el => {
                if(el.__run) return; el.__run = true;
                const exp = el.getAttribute('data-expire');
                const msg = el.getAttribute('data-msg') || "WAKTU HABIS";
                if(!exp) return;
                
                const update = () => {
                    const diff = new Date(exp).getTime() - new Date().getTime();
                    const set = (sel, v) => el.querySelectorAll(sel).forEach(n => n.innerText = v < 10 ? "0"+v : v);
                    
                    if(diff < 0) {
                        const disp = el.querySelector(".js-display") || el.querySelector(".js-countdown-display");
                        const box = el.querySelector(".js-expired-msg");
                        const txt = el.querySelector(".js-expired-text");
                        if(disp) disp.style.display = 'none';
                        if(box) { box.classList.remove('hidden'); box.style.display = 'block'; if(txt) txt.innerText = msg; else box.innerText = msg; }
                        clearInterval(el.__int); return;
                    }
                    const d = Math.floor(diff / 86400000);
                    const h = Math.floor((diff % 86400000) / 3600000);
                    const m = Math.floor((diff % 3600000) / 60000);
                    const s = Math.floor((diff % 60000) / 1000);
                    set('.days, .js-d', d); set('.hours, .js-h', h); set('.minutes, .js-m', m); set('.seconds, .js-s', s);
                };
                update(); el.__int = setInterval(update, 1000);
            });

            // CHECKOUT SYSTEM
            const box = document.body;
            if (box.innerHTML.includes('[ CHECKOUT ]')) {
                const pays = window.BS_DATA.active_payments.map(s => \`<label class="flex items-center p-3 border rounded-lg cursor-pointer hover:bg-blue-50 transition border-gray-200 mb-2"><input type="radio" name="pay_method" value="\${s}" class="mr-3 w-4 h-4 text-blue-600"><span class="text-sm font-bold text-gray-700 uppercase">\${s.replace(/-/g, ' ')}</span></label>\`).join('') || '<p class="text-xs text-red-500">No payment method.</p>';
                const form = \`<div class="max-w-md mx-auto my-8 p-6 bg-white rounded-2xl shadow-xl border border-gray-100 font-sans"><h2 class="text-xl font-black text-gray-800 mb-6 text-center">Formulir Pemesanan</h2><div class="flex justify-between items-center p-4 bg-blue-50 rounded-xl border border-blue-100 mb-6"><span class="font-bold text-blue-900">\${window.BS_DATA.title}</span><span class="font-black text-blue-700">Rp \${new Intl.NumberFormat('id-ID').format(window.BS_DATA.config.price||0)}</span></div><div class="space-y-4 mb-6"><input type="text" id="c_name" placeholder="Nama Lengkap" class="w-full p-3 border rounded-lg"><input type="tel" id="c_phone" placeholder="No. WhatsApp" class="w-full p-3 border rounded-lg"></div><div class="mb-6"><label class="text-xs font-bold text-gray-400 uppercase block mb-2">Pembayaran</label><div class="grid gap-2">\${pays}</div></div><button id="btn-submit-order" class="w-full py-4 bg-blue-600 text-white font-black rounded-xl shadow-lg hover:bg-blue-700 transition">BAYAR SEKARANG</button></div>\`;
                box.innerHTML = box.innerHTML.replace('[ CHECKOUT ]', form);
                
                document.getElementById('btn-submit-order')?.addEventListener('click', async () => {
                    const pm = document.querySelector('input[name="pay_method"]:checked')?.value;
                    const nm = document.getElementById('c_name').value;
                    const ph = document.getElementById('c_phone').value;
                    if(!nm || !ph || !pm) return Swal.fire('Lengkapi Data', 'Nama, WA, dan Metode Pembayaran wajib diisi', 'warning');
                    const btn = document.getElementById('btn-submit-order'); btn.disabled = true; btn.innerText = 'Memproses...';
                    try {
                        const r = await fetch('/api/public/checkout', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ page_id: window.BS_DATA.page_id, slug_payment: pm, quantity: 1, customer: { name: nm, phone: ph } }) });
                        const d = await r.json();
                        if(d.payment_url) window.location.href = d.payment_url; else Swal.fire('Gagal', d.error, 'error');
                    } catch(e) { Swal.fire('Error', 'Koneksi gagal', 'error'); }
                    btn.disabled = false; btn.innerText = 'BAYAR SEKARANG';
                });
            }
        });
    </script>
    `;

    // --- REKONSTRUKSI HTML YANG BENAR ---
    // 1. Ambil konten DB.
    let content = page.html_content || '';
    
    // 2. Cek apakah ada <body> di dalam content DB
    // Jika ada, kita INJECT script sebelum </body> penutup milik DB.
    // Jika tidak ada (hanya div/section), kita bungkus manual.
    if (content.includes('<body')) {
        // Inject script sebelum closing body
        content = content.replace('</body>', `${systemScripts}</body>`);
    } else {
        // Bungkus manual jika user hanya simpan div
        content = `<body>${content}${systemScripts}</body>`;
    }

    // 3. Render HTML Utuh
    return c.html(`
    <!DOCTYPE html>
    <html lang='id'>
    <head>
        <meta charset='UTF-8'>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>${page.title}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script>${tailwindConfig}</script>
        <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
        <script src="https://code.iconify.design/iconify-icon/2.1.0/iconify-icon.min.js"></script>
        <script src="https://unpkg.com/@phosphor-icons/web"></script>
        <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
        <link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.10/dist/full.min.css" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
        <style>
            ${bridgeCSS}
            ${page.css_content || ''}
        </style>
    </head>
    ${content}
    </html>
    `);
}

// --- ANALYTICS JOB ---
async function runAnalyticsRekap(env) {
    try {
        const q = `SELECT blob1 as slug, count() as total_views FROM paslanding_events WHERE timestamp >= now() - INTERVAL '15' MINUTE GROUP BY slug`;
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, { method: 'POST', headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/octet-stream' }, body: q });
        const d = await r.json();
        if (d.data?.length) {
            const stmt = env.DB.prepare(`INSERT INTO analytics_rekap (slug, views, period_start) VALUES (?, ?, datetime('now', '-15 minutes'))`);
            await env.DB.batch(d.data.map(x => stmt.bind(x.slug, x.total_views)));
        }
    } catch (e) { throw new Error(e.message); }
}

app.use('/assets/*', async (c) => c.env.ASSETS.fetch(c.req.raw));
app.get('/', async (c) => {
    try { const s = await c.env.DB.prepare("SELECT value FROM settings WHERE key='homepage_slug'").first(); if(!s?.value) return c.html("<h1>Welcome</h1>"); 
    const p = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(s.value).first(); if(!p) return c.text("404"); trackVisit(c, p, 'home'); return renderPage(c, p); } catch(e){ return c.text(e.message, 500); }
});
app.get('/:slug', async (c) => {
    try { const s = c.req.param('slug'); if(s.includes('.')) return c.env.ASSETS.fetch(c.req.raw); 
    const p = await c.env.DB.prepare("SELECT * FROM pages WHERE slug=?").bind(s).first(); if(!p) return c.text("404", 404); trackVisit(c, p, c.req.header('Referer')); return renderPage(c, p); } catch(e){ return c.env.ASSETS.fetch(c.req.raw); }
});

export const onRequest = handle(app);
