import { decryptJSON, sha1 } from '../utils';

const FALLBACK_SECRET = 'BantarCaringin1BantarCaringin2BantarCaringin3';

export const uploadImage = async (c) => {
    try {
        // 1. Cek Koneksi DB
        if (!c.env.DB) {
            console.error("Database binding not found");
            return c.json({ error: "Database not configured" }, 500);
        }

        // 2. Ambil Config
        const credRow = await c.env.DB.prepare("SELECT * FROM credentials WHERE provider_slug = 'cloudinary'").first();
        if (!credRow) {
            return c.json({ error: "Cloudinary credentials missing in DB" }, 400);
        }

        const secretKey = c.env.APP_MASTER_KEY || FALLBACK_SECRET;
        const config = await decryptJSON(credRow.encrypted_data, credRow.iv, secretKey);

        if (!config || !config.cloud_name) {
            return c.json({ error: "Decryption failed or invalid config" }, 400);
        }

        const { cloud_name, api_key, api_secret } = config;

        // 3. Ambil File (Base64)
        const body = await c.req.parseBody();
        const fileData = body['file']; // Frontend mengirim key 'file' berisi string Base64

        if (!fileData) {
            return c.json({ error: "No file data received" }, 400);
        }

        // 4. Upload ke Cloudinary
        const timestamp = Math.round(new Date().getTime() / 1000).toString();
        const paramsToSign = `format=webp&timestamp=${timestamp}${api_secret}`;
        const signature = await sha1(paramsToSign);

        const formData = new FormData();
        formData.append('file', fileData);
        formData.append('api_key', api_key);
        formData.append('timestamp', timestamp);
        formData.append('format', 'webp');
        formData.append('signature', signature);

        const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${cloud_name}/image/upload`, {
            method: 'POST',
            body: formData
        });

        const json = await uploadRes.json();

        if (json.secure_url) {
            return c.json({
                data: [{
                    src: json.secure_url,
                    width: json.width,
                    height: json.height
                }]
            });
        } else {
            console.error("Cloudinary API Error:", json);
            return c.json({ error: json.error?.message || "Cloudinary Error" }, 500);
        }

    } catch (e) {
        console.error("Server Error:", e);
        return c.json({ error: e.message }, 500);
    }
};
