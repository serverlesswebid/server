// Global Function agar bisa dipanggil ulang oleh Editor saat drag-drop
window.initCountdowns = function() {
    const timers = document.querySelectorAll('.js-countdown');
    
    timers.forEach(el => {
        // Cek apakah sudah berjalan agar tidak double interval
        if(el.dataset.init === "true") return;
        
        const display = el.querySelector(".js-display");
        const expiredBox = el.querySelector(".js-expired-msg");
        const expireStr = el.getAttribute("data-expire");
        const msgStr = el.getAttribute("data-msg") || "WAKTU HABIS";

        if (!expireStr) return;

        el.dataset.init = "true"; // Tandai sudah di-init

        const update = () => {
            const now = new Date().getTime();
            const target = new Date(expireStr).getTime();
            const distance = target - now;

            if (distance < 0) {
                if(display) display.style.display = "none";
                if(expiredBox) {
                    expiredBox.style.display = "block";
                    expiredBox.classList.remove("hidden");
                    expiredBox.innerHTML = msgStr;
                }
                clearInterval(interval);
                return;
            }

            const d = Math.floor(distance / (1000 * 60 * 60 * 24));
            const h = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const m = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((distance % (1000 * 60)) / 1000);

            const setTxt = (sel, val) => {
                const node = el.querySelector(sel);
                if (node) node.innerText = val < 10 ? "0" + val : val;
            };

            setTxt(".days", d);
            setTxt(".hours", h);
            setTxt(".minutes", m);
            setTxt(".seconds", s);
        };

        const interval = setInterval(update, 1000);
        update(); // Jalankan sekali di awal
    });
};

// Jalankan otomatis saat halaman Live dimuat
document.addEventListener("DOMContentLoaded", window.initCountdowns);
