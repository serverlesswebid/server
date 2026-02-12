import { decryptJSON, sha1 } from '../utils';

// Pastikan Secret ini sama dengan di functions/[[path]].js
const FALLBACK_SECRET = 'BantarCaringin1BantarCaringin2BantarCaringin3';

export const uploadImage = async (c) => {
    try {
        // 1. Ambil Config dari DB
        if (!c.env.DB) return c.json({ error: "Database binding not found" }, 500);

        const credRow = await c.env.DB.prepare("SELECT * FROM credentials WHERE provider_slug = 'cloudinary'").first();
        
        if (!credRow) {
            return c.json({ success: false, message: "Cloudinary belum dikonfigurasi di Database." }, 500);
        }

        const secretKey = c.env.APP_MASTER_KEY || FALLBACK_SECRET;
        const config = await decryptJSON(credRow.encrypted_data, credRow.iv, secretKey);
        
        if (!config || !config.cloud_name || !config.api_key || !config.api_secret) {
            return c.json({ success: false, message: "Kredensial Cloudinary rusak/tidak lengkap." }, 400);
        }

        const { cloud_name, api_key, api_secret } = config;

        // 2. Ambil File (Body Parsing)
        const body = await c.req.parseBody();
        const image = body['file']; // Frontend mengirim key 'file'
        const filename = body['filename']; // Bisa jadi null kalau base64

        if (!image) {
            return c.json({ error: "No file uploaded" }, 400);
        }

        // 3. Buat Signature (Dengan Fallback Public ID jika filename kosong)
        const cleanName = filename ? filename.split('.').slice(0, -1).join('.') : `upload_${Date.now()}`;
        const publicId = cleanName.replace(/[^a-zA-Z0-9]/g, "_"); // Sanitasi nama file
        const timestamp = Math.round(new Date().getTime() / 1000).toString();
        
        const paramsToSign = `format=webp&public_id=${publicId}&timestamp=${timestamp}${api_secret}`;
        const signature = await sha1(paramsToSign);

        // 4. Upload ke Cloudinary
        const formData = new FormData();
        formData.append('file', image);
        formData.append('api_key', api_key);
        formData.append('timestamp', timestamp);
        formData.append('public_id', publicId);
        formData.append('format', 'webp');
        formData.append('signature', signature);

        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud_name}/image/upload`, {
            method: 'POST', 
            body: formData
        });
        
        const json = await res.json();

        if (json.secure_url) {
            // Format Return Sesuai GrapesJS Asset Manager
            return c.json({ 
                data: [{ 
                    src: json.secure_url, 
                    type: 'image',
                    height: json.height,
                    width: json.width
                }] 
            });
        } else {
            console.error("Cloudinary Error:", json);
            throw new Error(json.error?.message || "Cloudinary Upload Failed");
        }

    } catch (e) {
        console.error("Upload Error:", e);
        return c.json({ success: false, message: e.message }, 500);
    }
};
