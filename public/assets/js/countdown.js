window.initCountdowns = function() {
    const timers = document.querySelectorAll('.js-countdown');
    
    timers.forEach(el => {
        if(el.dataset.init === "true") return;
        
        const display = el.querySelector(".js-display");
        const expiredBox = el.querySelector(".js-expired-msg");
        const expiredText = el.querySelector(".js-expired-text"); // Tambahan untuk support teks dinamis
        const expireStr = el.getAttribute("data-expire");
        const msgStr = el.getAttribute("data-msg") || "WAKTU HABIS";

        if (!expireStr) return;

        el.dataset.init = "true";

        const update = () => {
            const now = new Date().getTime();
            const target = new Date(expireStr).getTime();
            const distance = target - now;

            if (distance < 0) {
                if(display) display.style.display = "none";
                if(expiredBox) {
                    expiredBox.style.display = "block";
                    expiredBox.classList.remove("hidden");
                    // Update teks expired jika elemennya ada
                    if(expiredText) expiredText.innerText = msgStr;
                    else expiredBox.innerHTML = msgStr; // Fallback
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

            // PERBAIKAN UTAMA DI SINI:
            // Support DUA jenis selector: .days (lama) DAN .js-d (baru dari database)
            setTxt(".days", d); setTxt(".js-d", d);
            setTxt(".hours", h); setTxt(".js-h", h);
            setTxt(".minutes", m); setTxt(".js-m", m);
            setTxt(".seconds", s); setTxt(".js-s", s);
        };

        const interval = setInterval(update, 1000);
        update();
    });
};
