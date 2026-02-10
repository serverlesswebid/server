export class ModuleManager {
  /**
   * @param {import('hono').Context} c
   */
  constructor(c) {
    // BINDING KV HARUS SESUAI DENGAN WRANGLER.TOML
    this.kv = c.env.MODULES_KV; 
    this.db = c.env.DB;

    if (!this.kv) {
      throw new Error("Binding 'MODULES_KV' tidak ditemukan. Cek wrangler.toml!");
    }
  }

  /**
   * Eksekusi Module dengan Cache Strategy
   * Flow: Cek KV -> Jika Kosong Ambil DB -> Simpan ke KV -> Eksekusi
   */
  async execute(moduleId, inputData, configValues) {
    // 1. Cek Cache KV (Fast Path)
    let moduleCode = await this.kv.get(`module:${moduleId}`, 'text');

    // 2. Jika Cache Miss (Data tidak ada di KV), ambil dari DB
    if (!moduleCode) {
      console.log(`[Cache Miss] Fetching module '${moduleId}' from DB...`);
      
      const record = await this.db.prepare(
        "SELECT code FROM server_modules WHERE id = ? AND is_active = 1"
      ).bind(moduleId).first();
      
      if (!record) {
        throw new Error(`Module '${moduleId}' tidak ditemukan atau status inactive.`);
      }
      
      moduleCode = record.code;
      
      // 3. Simpan ke KV secara PERMANEN (Self-Healing Cache)
      // Tidak ada expiration, data hanya hilang jika di-delete/update manual
      await this.kv.put(`module:${moduleId}`, moduleCode);
    }

    // 4. Eksekusi Code dalam Sandbox Environment
    try {
      // Library helper yang aman untuk digunakan dalam modul dinamis
      const sandboxHelpers = {
        fetch: fetch,                        // Untuk HTTP Request ke pihak ketiga
        uuid: crypto.randomUUID.bind(crypto),// Generate ID Transaksi
        json: JSON.stringify,
        parse: JSON.parse,
        log: console.log,
        timestamp: () => new Date().toISOString()
      };

      // Konstruksi Async Function dari String Database
      // Parameters: 'input' (data dari checkout), 'config' (setting user), 'lib' (helpers)
      const dynamicFunction = new Function('input', 'config', 'lib', `
        return (async () => { 
          ${moduleCode} 
        })();
      `);

      // Jalankan Fungsi
      return await dynamicFunction(inputData, configValues, sandboxHelpers);

    } catch (err) {
      console.error(`[Module Execution Error] ID: ${moduleId}`, err);
      throw new Error(`Gagal memproses modul: ${err.message}`);
    }
  }

  /**
   * Simpan Module Baru / Update Module (Admin)
   * Efek: Menulis ke DB dan langsung memperbarui Cache KV
   */
  async saveModule(id, data) {
    const timestamp = Math.floor(Date.now() / 1000);
    
    // 1. Upsert ke Database D1
    await this.db.prepare(`
      INSERT INTO server_modules (id, name, type, config_schema, code, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        type=excluded.type,
        config_schema=excluded.config_schema,
        code=excluded.code,
        updated_at=excluded.updated_at
    `).bind(
      id, 
      data.name, 
      data.type, 
      JSON.stringify(data.config_schema || []), 
      data.code, 
      timestamp
    ).run();

    // 2. Force Update Cache KV (Cache Warming)
    // Agar user langsung mendapatkan logic terbaru tanpa delay
    await this.kv.put(`module:${id}`, data.code);
    
    return { success: true, id };
  }

  /**
   * Hapus Module
   * Efek: Menghapus dari DB dan KV
   */
  async deleteModule(id) {
    // Hapus dari DB
    await this.db.prepare("DELETE FROM server_modules WHERE id = ?").bind(id).run();
    
    // Hapus dari KV
    await this.kv.delete(`module:${id}`);
    
    return { success: true };
  }
}
