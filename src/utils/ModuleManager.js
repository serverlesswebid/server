export class ModuleManager {
  /**
   * @param {import('hono').Context} c
   */
  constructor(c) {
    // Pastikan binding di wrangler.toml sudah sesuai
    // contoh: kv_namespaces = [{ binding = "MY_KV", id = "..." }]
    this.kv = c.env.MY_KV; 
    this.db = c.env.DB;
  }

  /**
   * Eksekusi Module dengan Cache Strategy
   */
  async execute(moduleId, inputData, configValues) {
    // 1. Cek KV (Cache Layer - Cepat)
    let moduleCode = await this.kv.get(`module:${moduleId}`, 'text');

    // 2. Jika KV kosong, ambil dari DB (Source of Truth)
    if (!moduleCode) {
      console.log(`Cache miss: ${moduleId}. Fetching from DB...`);
      
      const record = await this.db.prepare(
        "SELECT code FROM server_modules WHERE id = ? AND is_active = 1"
      ).bind(moduleId).first();
      
      if (!record) {
        throw new Error(`Module ${moduleId} tidak ditemukan atau tidak aktif.`);
      }
      
      moduleCode = record.code;
      
      // 3. Simpan ke KV (Cache Warming)
      // Simpan permanen sampai ada update manual
      await this.kv.put(`module:${moduleId}`, moduleCode);
    }

    // 4. Eksekusi Code dalam Sandbox
    try {
      // Helper functions yang boleh dipakai di dalam dynamic script
      const sandboxHelpers = {
        fetch: fetch,                 // Boleh fetch API luar
        uuid: crypto.randomUUID.bind(crypto), // Generate UUID
        json: JSON.stringify,
        parse: JSON.parse,
        log: console.log,
        date: () => new Date().toISOString()
      };

      // Bungkus kode string jadi Async Function
      // Parameter: 'input' (data transaksi), 'config' (settingan user), 'lib' (helpers)
      const dynamicFunction = new Function('input', 'config', 'lib', `
        return (async () => { 
          ${moduleCode} 
        })();
      `);

      // Jalankan fungsi
      return await dynamicFunction(inputData, configValues, sandboxHelpers);

    } catch (err) {
      console.error(`Error executing module ${moduleId}:`, err);
      throw new Error(`Module Runtime Error: ${err.message}`);
    }
  }

  /**
   * Simpan/Update Module (Admin)
   */
  async saveModule(id, data) {
    const timestamp = Math.floor(Date.now() / 1000);
    
    // 1. Simpan ke DB (Upsert)
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

    // 2. Langsung Update KV agar perubahan instan (Cache Invalidation)
    await this.kv.put(`module:${id}`, data.code);
    
    return { success: true, id };
  }

  /**
   * Hapus Module
   */
  async deleteModule(id) {
    // Hapus dari DB
    await this.db.prepare("DELETE FROM server_modules WHERE id = ?").bind(id).run();
    // Hapus dari KV
    await this.kv.delete(`module:${id}`);
    return { success: true };
  }
}
