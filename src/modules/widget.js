// src/modules/widget.js

const CACHE_KEY = 'widgets_library_v1';
const CACHE_TTL = 3600; // Cache 1 jam di KV

// --- 1. GET (Read from KV -> Miss -> Read D1 -> Save KV) ---
export async function getWidgets(env) {
    // A. Cek KV (Cache Layer)
    const cached = await env.WIDGET_CACHE.get(CACHE_KEY);
    if (cached) {
        return JSON.parse(cached);
    }

    // B. Jika Cache Kosong, Ambil dari Database (Source of Truth)
    const { results } = await env.DB.prepare(`
        SELECT id, label, category, content, script, attributes 
        FROM widgets 
        ORDER BY category ASC, label ASC
    `).all();

    // C. Format Data untuk Editor
    const widgets = results.map(row => ({
        id: row.id,
        label: row.label,
        category: row.category,
        content: row.content, // HTML String
        script: row.script,   // JS Logic String
        attributes: row.attributes ? JSON.parse(row.attributes) : {}
    }));

    // D. Simpan ke KV (agar request selanjutnya instan)
    if (widgets.length > 0) {
        await env.WIDGET_CACHE.put(CACHE_KEY, JSON.stringify(widgets), { expirationTtl: CACHE_TTL });
    }

    return widgets;
}

// --- 2. SAVE / UPSERT (Write D1 -> Purge KV) ---
export async function saveWidget(env, data) {
    const { id, label, category, content, script, attributes } = data;

    // A. Tulis ke Database
    await env.DB.prepare(`
        INSERT INTO widgets (id, label, category, content, script, attributes)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET 
            label=excluded.label, 
            category=excluded.category,
            content=excluded.content,
            script=excluded.script,
            attributes=excluded.attributes,
            created_at=strftime('%s', 'now')
    `).bind(
        id, 
        label, 
        category, 
        content, 
        script || null, 
        attributes ? JSON.stringify(attributes) : '{}'
    ).run();

    // B. Hapus Cache (Invalidation)
    // Agar frontend/editor langsung mendapat data terbaru saat reload
    await env.WIDGET_CACHE.delete(CACHE_KEY);

    return { success: true, id };
}

// --- 3. DELETE (Delete D1 -> Purge KV) ---
export async function deleteWidget(env, id) {
    // A. Hapus dari Database
    await env.DB.prepare('DELETE FROM widgets WHERE id = ?').bind(id).run();

    // B. Hapus Cache
    await env.WIDGET_CACHE.delete(CACHE_KEY);

    return { success: true, id };
}

// --- 4. INIT TABLE (Dijalankan sekali saat setup) ---
export async function initWidgetDB(db) {
    await db.prepare(`
        CREATE TABLE IF NOT EXISTS widgets (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            script TEXT,
            attributes TEXT,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
    `).run();
}
