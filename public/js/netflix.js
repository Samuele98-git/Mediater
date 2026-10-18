/* MEDIATER — browse UI: nav, sliders, billboard, hover previews, details modal, search */
(() => {
    'use strict';
    const NF = window.__nf || { titles: {}, i18n: {} };
    const T = NF.titles || (NF.titles = {});
    const L = NF.i18n || {};
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const tr = (k, vars) => {
        let s = L[k] != null ? String(L[k]) : k;
        if (vars) for (const [a, b] of Object.entries(vars)) s = s.split('{' + a + '}').join(b);
        return s;
    };
    const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isMobile = () => window.innerWidth <= 740;
    const body = document.body;

    // ------------------------------------------------------------------ helpers
    async function api(url, opts = {}) {
        const headers = { Accept: 'application/json' };
        if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
        const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...headers, ...(opts.headers || {}) } });
        if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || r.statusText);
        return j;
    }

    function toast(msg, isError) {
        const box = $('#nfToasts');
        if (!box) return;
        const el = document.createElement('div');
        el.className = 'nf-toast' + (isError ? ' error' : '');
        el.innerHTML = (isError ? '<i class="fa-solid fa-circle-exclamation"></i>' : '<i class="fa-solid fa-check"></i>') + esc(msg);
        box.appendChild(el);
        setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 2600);
    }
    window.nfToast = toast;

    const fmtMinutes = (min) => {
        min = Math.round(min || 0);
        if (!min) return '';
        return min >= 60 ? tr('dur_hm', { h: Math.floor(min / 60), m: min % 60 }) : tr('dur_m', { m: min });
    };
    function durationLabel(c) {
        if (c.type === 'series') {
            if (c.seasons > 1) return tr('seasons', { n: c.seasons });
            if (c.episodes) return tr(c.episodes === 1 ? 'episode_one' : 'episodes', { n: c.episodes });
            return tr('series');
        }
        return fmtMinutes(c.duration);
    }
    function metaLine(c, { year = false } = {}) {
        const out = [];
        out.push(c.isNew ? `<span class="nf-new">${esc(tr('new'))}</span>` : `<span class="nf-match">${esc(tr('match', { n: c.match }))}</span>`);
        if (year && c.year) out.push(`<span>${c.year}</span>`);
        if (c.maturity) out.push(`<span class="nf-maturity">${esc(c.maturity)}</span>`);
        const d = durationLabel(c);
        if (d) out.push(`<span>${esc(d)}</span>`);
        if (c.quality) out.push(`<span class="nf-hd">${esc(c.quality === '4K' ? '4K' : 'HD')}</span>`);
        return out.join('');
    }
    const tagsHtml = (list) => (list || []).map(g => `<span>${esc(g)}</span>`).join('');

    // ------------------------------------------------------------------ title fitting
    // Text titles (used when a title has no logo art) shrink until the longest word
    // fits and the whole title stays within N lines, so they are never cut off.
    const FIT_RULES = [
        ['.nf-card-name', 2, 9],
        ['.nf-card-fallback', 3, 9],
        ['.nf-mini-name', 2, 11],
        ['.nf-billboard-title', 2, 20],
        ['.nf-modal-title', 2, 18]
    ];
    const measureCtx = document.createElement('canvas').getContext('2d');
    function fitTitles(root = document) {
        const jobs = [];
        for (const [sel, lines, min] of FIT_RULES) {
            if (root !== document && root.matches && root.matches(sel)) jobs.push({ el: root, lines, min });
            root.querySelectorAll(sel).forEach(el => jobs.push({ el, lines, min }));
        }
        if (!jobs.length) return;
        for (const j of jobs) j.el.style.fontSize = '';           // back to the CSS size
        for (const j of jobs) {                                     // read everything in one layout pass
            const cs = getComputedStyle(j.el);
            j.width = j.el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
            j.max = parseFloat(cs.fontSize) || 16;
            j.font = `${cs.fontStyle} ${cs.fontWeight} 100px ${cs.fontFamily}`;
            j.upper = cs.textTransform === 'uppercase';
            j.ls = (parseFloat(cs.letterSpacing) || 0) / j.max;     // letter-spacing in em
        }
        for (const j of jobs) {
            if (j.width <= 0) continue;
            let text = (j.el.textContent || '').trim();
            if (!text) continue;
            if (j.upper) text = text.toUpperCase();
            measureCtx.font = j.font;
            const width = (s) => measureCtx.measureText(s).width + j.ls * 100 * s.length;
            const longest = Math.max(...text.split(/\s+/).map(width));
            const byWord = (j.width * 0.96) / longest * 100;
            const byLines = (j.width * j.lines * 0.86) / width(text) * 100;
            const size = Math.max(j.min, Math.min(j.max, byWord, byLines));
            if (size < j.max - 0.25) j.el.style.fontSize = size.toFixed(2) + 'px';
        }
    }
    window.nfFitTitles = fitTitles;
    let fitTimer = 0;
    window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => fitTitles(document), 150); });
    const listIcon = (on) => `<i class="fa-solid ${on ? 'fa-check' : 'fa-plus'}"></i>`;

    function rateHtml(id, value) {
        const icon = value === 2 ? '<i class="fa-solid fa-thumbs-up"></i>' : value === 1 ? '<i class="fa-solid fa-thumbs-up"></i>' : value === -1 ? '<i class="fa-solid fa-thumbs-down"></i>' : '<i class="fa-regular fa-thumbs-up"></i>';
        return `<span class="nf-rate" data-rate-root="${id}">
            <button type="button" class="nf-circle rated-${value || 0}" aria-label="${esc(tr('rate'))}">${icon}</button>
            <span class="nf-rate-pop">
                <button type="button" data-rate="-1" class="${value === -1 ? 'on' : ''}" title="${esc(tr('not_for_me'))}"><i class="fa-${value === -1 ? 'solid' : 'regular'} fa-thumbs-down"></i></button>
                <button type="button" data-rate="1" class="${value === 1 ? 'on' : ''}" title="${esc(tr('i_like_this'))}"><i class="fa-${value === 1 ? 'solid' : 'regular'} fa-thumbs-up"></i></button>
                <button type="button" data-rate="2" class="${value === 2 ? 'on' : ''}" title="${esc(tr('love_this'))}"><i class="fa-${value === 2 ? 'solid' : 'regular'} fa-thumbs-up"></i><i class="fa-${value === 2 ? 'solid' : 'regular'} fa-thumbs-up"></i></button>
            </span></span>`;
    }

    async function toggleList(id) {
        const j = await api('/api/mylist/' + id, { method: 'POST' });
        if (T[id]) T[id].inList = j.inList;
        $$(`[data-list="${id}"]`).forEach(b => {
            const i = b.querySelector('i');
            if (i) i.className = 'fa-solid ' + (j.inList ? 'fa-check' : 'fa-plus');
            if (b.dataset.tip) b.dataset.tip = j.inList ? tr('remove_from_list') : tr('add_to_list');
            if (b.title) b.title = j.inList ? tr('remove_from_list') : tr('add_to_list');
        });
        toast(j.inList ? tr('added_to_list') : tr('removed_from_list'));
        if (!j.inList && body.classList.contains('page-mylist')) {
            const card = $(`#nfGrid .nf-card[data-id="${id}"]`);
            if (card) card.remove();
        }
    }

    async function rate(id, value) {
        const cur = (T[id] && T[id].thumb) || 0;
        const v = cur === value ? 0 : value;
        const j = await api('/api/rate/' + id, { method: 'POST', body: JSON.stringify({ value: v }) });
        if (T[id]) T[id].thumb = j.value;
        $$(`[data-rate-root="${id}"]`).forEach(el => { el.outerHTML = rateHtml(id, j.value); });
        toast(j.value === 2 ? tr('rated_love') : j.value === 1 ? tr('rated_like') : j.value === -1 ? tr('rated_dislike') : tr('rating_removed'));
    }

    // ------------------------------------------------------------------ nav
    const nav = $('#nfNav');
    let lastY = window.scrollY;
    function onScroll() {
        const y = window.scrollY;
        if (nav) nav.classList.toggle('solid', y > 8);
        body.classList.toggle('scrolled', y > 8);
        if (Math.abs(y - lastY) > 6) {
            body.classList.toggle('scrolled-down', y > lastY && y > 90);
            lastY = y;
        }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // dropdowns (profile, bell, browse, genres)
    function setupDrop(el, onOpen) {
        if (!el) return;
        const btn = el.querySelector('button');
        let hoverT;
        const open = () => { if (!el.classList.contains('open')) { closeDrops(el); el.classList.add('open'); onOpen && onOpen(); } };
        const close = () => el.classList.remove('open');
        btn.addEventListener('click', (e) => { e.stopPropagation(); el.classList.contains('open') ? close() : open(); });
        if (finePointer && (el.classList.contains('nf-profile') || el.classList.contains('nf-bell'))) {
            el.addEventListener('mouseenter', () => { clearTimeout(hoverT); hoverT = setTimeout(open, 120); });
            el.addEventListener('mouseleave', () => { clearTimeout(hoverT); hoverT = setTimeout(close, 300); });
        }
    }
    function closeDrops(except) { $$('.nf-drop.open, .nf-nav-browse.open, .nf-genre-select.open').forEach(d => { if (d !== except) d.classList.remove('open'); }); }
    document.addEventListener('click', (e) => { if (!e.target.closest('.nf-drop, .nf-nav-browse, .nf-genre-select')) closeDrops(); });
    setupDrop($('#nfProfile'));
    setupDrop($('#nfBrowse'));
    setupDrop($('#nfGenreSelect'));

    // notifications
    const bell = $('#nfBell');
    const BELL_KEY = 'nf.bellSeen';
    let bellItems = null;
    const relTime = (d) => {
        const days = Math.floor((Date.now() - new Date(d)) / 86400000);
        if (days <= 0) return tr('today');
        if (days === 1) return tr('yesterday');
        return tr('days_ago', { n: days });
    };
    async function loadBell(render) {
        try {
            if (!bellItems) bellItems = (await api('/api/notifications')).items || [];
            let seen = 0;
            try { seen = parseInt(localStorage.getItem(BELL_KEY) || '0', 10); } catch { /* private mode */ }
            const fresh = bellItems.filter(i => new Date(i.at).getTime() > seen).length;
            const badge = bell.querySelector('.nf-icon-badge');
            badge.textContent = fresh > 9 ? '9+' : String(fresh);
            badge.hidden = !fresh;
            if (render) {
                const panel = bell.querySelector('.nf-drop-panel');
                panel.innerHTML = bellItems.length ? bellItems.map(i => `
                    <a class="nf-bell-item" href="/title/${i.id}" data-modal="${i.id}">
                        ${i.img ? `<img src="${esc(i.img)}" alt="" loading="lazy">` : '<span></span>'}
                        <span><small>${esc(i.kind === 'episodes' ? tr('new_episodes_count', { n: i.count }) : tr('new_arrival'))}</small><b>${esc(i.title)}</b><small>${esc(relTime(i.at))}</small></span>
                    </a>`).join('') : `<div class="nf-bell-empty">${esc(tr('no_notifications'))}</div>`;
                try { localStorage.setItem(BELL_KEY, String(Date.now())); } catch { /* ignore */ }
                badge.hidden = true;
            }
        } catch { /* ignore */ }
    }
    if (bell) { setupDrop(bell, () => loadBell(true)); setTimeout(() => loadBell(false), 1200); }

    // downloads badge (admins)
    const dlLink = $('#nfDlLink');
    if (dlLink && !body.classList.contains('page-downloads')) {
        const tabDl = $('#nfTabDl');
        const poll = async () => {
            try {
                const s = await api('/api/torrents/summary');
                for (const el of [dlLink, tabDl].filter(Boolean)) {
                    const b = el.querySelector('.nf-icon-badge');
                    b.textContent = String(s.active);
                    b.hidden = !s.active;
                }
                dlLink.classList.toggle('active', s.active > 0);
            } catch { /* ignore */ }
        };
        poll();
        setInterval(() => { if (!document.hidden) poll(); }, 15000);
    }

    // search
    const search = $('#nfSearch');
    if (search) {
        const input = search.querySelector('input');
        const onSearchPage = !!$('#nfSearchPage');
        let debounce;
        const openSearch = () => { search.classList.add('open'); setTimeout(() => input.focus(), 30); };
        search.querySelector('.nf-search-toggle').addEventListener('click', () => {
            if (search.classList.contains('open') && input.value.trim()) go(input.value.trim());
            else if (search.classList.contains('open')) search.classList.remove('open');
            else openSearch();
        });
        const go = (q) => {
            if (onSearchPage) liveSearch(q);
            else location.href = '/search?q=' + encodeURIComponent(q);
        };
        input.addEventListener('input', () => {
            const q = input.value.trim();
            search.classList.toggle('has-text', !!input.value);
            clearTimeout(debounce);
            debounce = setTimeout(() => { if (q || onSearchPage) go(q); }, onSearchPage ? 250 : 550);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { clearTimeout(debounce); go(input.value.trim()); }
            if (e.key === 'Escape') { input.value = ''; search.classList.remove('open', 'has-text'); input.blur(); }
        });
        input.addEventListener('blur', () => { if (!input.value.trim() && !onSearchPage) search.classList.remove('open'); });
        search.querySelector('.nf-search-clear').addEventListener('click', () => {
            input.value = '';
            search.classList.remove('has-text');
            if (onSearchPage) liveSearch(''); else search.classList.remove('open');
            input.focus();
        });
        if (onSearchPage) {
            search.classList.add('open');
            const q = input.value;
            setTimeout(() => { input.focus(); input.setSelectionRange(q.length, q.length); }, 50);
        }
    }

    let searchSeq = 0;
    async function liveSearch(q) {
        const page = $('#nfSearchPage');
        if (!page) return;
        const seq = ++searchSeq;
        history.replaceState(null, '', q ? '/search?q=' + encodeURIComponent(q) : '/search');
        if (!q) { location.reload(); return; }
        try {
            const j = await api('/api/search?q=' + encodeURIComponent(q));
            if (seq !== searchSeq) return;
            Object.assign(T, j.titles);
            const results = $('#nfSearchResults');
            const rel = $('#nfRelated');
            if (j.related && j.related.length) {
                rel.hidden = false;
                rel.innerHTML = `<span>${esc(tr('explore_related'))}</span>` + j.related.map(g => `<a href="/browse/genre/${encodeURIComponent(g)}">${esc(g)}</a>`).join('');
            } else rel.hidden = true;
            results.innerHTML = j.ids.length
                ? `<div class="nf-grid">${j.ids.map(id => cardMarkup(T[id])).join('')}</div>`
                : `<div class="nf-search-hint"><p>${esc(tr('no_results_for', { q }))}</p>${esc(tr('suggestions'))}<ul><li>${esc(tr('tip_keywords'))}</li><li>${esc(tr('tip_title'))}</li><li>${esc(tr('tip_genre'))}</li></ul></div>`;
            fitTitles(results);
        } catch (e) { /* keep old results */ }
    }

    function cardMarkup(c) {
        if (!c) return '';
        const art = c.img || c.backdrop || c.poster;
        const label = c.logo ? `<img class="nf-card-logo" src="${esc(c.logo)}" alt="${esc(c.title)}" loading="lazy">` : `<span class="nf-card-name">${esc(c.title)}</span>`;
        return `<a class="nf-card nf-card--grid" href="/title/${c.id}" data-id="${c.id}" aria-label="${esc(c.title)}"><span class="nf-card-art${art ? '' : ' empty'}">${art ? `<img src="${esc(art)}" alt="" loading="lazy">` : ''}${label}${c.downloading != null ? `<span class="nf-dl-chip"><i class="fa-solid fa-arrow-down"></i> ${c.downloading}%</span>` : ''}</span></a>`;
    }

    // categories overlay (mobile) and genre menu
    const cats = $('#nfCategories');
    if (cats) {
        $$('[data-open-genres]').forEach(b => b.addEventListener('click', () => { cats.hidden = false; body.classList.add('nf-lock'); }));
        const closeCats = () => { cats.hidden = true; body.classList.remove('nf-lock'); };
        cats.querySelector('.nf-cat-close').addEventListener('click', closeCats);
        cats.addEventListener('click', (e) => { if (e.target === cats) closeCats(); });
    }

    // ------------------------------------------------------------------ sliders
    function setupSlider(slider) {
        const track = slider.querySelector('.nf-slider-track');
        const prev = slider.querySelector('.nf-slider-handle.prev');
        const next = slider.querySelector('.nf-slider-handle.next');
        const dots = slider.querySelector('.nf-pagination');
        if (!track) return;
        const metrics = () => {
            const card = track.querySelector('.nf-card');
            const cs = getComputedStyle(track);
            const gap = parseFloat(cs.columnGap || cs.gap) || 0;
            const pad = parseFloat(cs.paddingLeft) || 0;
            const step = card ? card.getBoundingClientRect().width + gap : track.clientWidth;
            const per = Math.max(1, Math.round((track.clientWidth - 2 * pad + gap) / step));
            return { page: per * step, per, total: track.querySelectorAll('.nf-card').length };
        };
        let raf = 0;
        const update = () => {
            raf = 0;
            const m = metrics();
            const max = track.scrollWidth - track.clientWidth;
            prev && prev.classList.toggle('off', track.scrollLeft <= 4);
            next && next.classList.toggle('off', track.scrollLeft >= max - 4);
            if (dots) {
                const pages = Math.ceil(m.total / m.per);
                const cur = Math.min(pages - 1, Math.round(track.scrollLeft / m.page));
                if (dots.children.length !== pages) dots.innerHTML = pages > 1 ? '<li></li>'.repeat(pages) : '';
                Array.from(dots.children).forEach((li, i) => li.classList.toggle('active', i === cur));
            }
        };
        const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
        track.addEventListener('scroll', () => { schedule(); if (miniCard) closeMini(); }, { passive: true });
        window.addEventListener('resize', schedule);
        prev && prev.addEventListener('click', () => track.scrollBy({ left: -metrics().page, behavior: reducedMotion ? 'auto' : 'smooth' }));
        next && next.addEventListener('click', () => track.scrollBy({ left: metrics().page, behavior: reducedMotion ? 'auto' : 'smooth' }));
        update();
    }
    $$('.nf-slider').forEach(setupSlider);

    // ------------------------------------------------------------------ billboard
    const billboard = $('#nfBillboard');
    let bb = null;
    if (billboard) {
        const id = billboard.dataset.id;
        const c = T[id];
        const muteBtn = $('#nfBillboardMute');
        const media = billboard.querySelector('.nf-billboard-media');
        bb = { video: null, iframe: null, ended: false, muted: true, stopTimer: null };
        const setMuteIcon = () => {
            if (!muteBtn) return;
            muteBtn.innerHTML = bb.ended ? '<i class="fa-solid fa-rotate-right"></i>' : `<i class="fa-solid ${bb.muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
        };
        const endPreview = () => {
            bb.ended = true;
            billboard.classList.remove('playing');
            if (bb.video) bb.video.pause();
            if (bb.iframe) { bb.iframe.remove(); bb.iframe = null; }
            setMuteIcon();
        };
        const startVideo = () => {
            if (!c || !c.preview || isMobile() || reducedMotion || !finePointer) return;
            bb.ended = false;
            clearTimeout(bb.stopTimer);
            if (c.preview.kind === 'video') {
                if (!bb.video) {
                    const v = document.createElement('video');
                    v.muted = true; v.playsInline = true; v.preload = 'auto';
                    v.setAttribute('muted', '');
                    v.src = c.preview.src;
                    v.addEventListener('loadedmetadata', () => { try { v.currentTime = c.preview.start || 0; } catch { /* ignore */ } }, { once: true });
                    v.addEventListener('playing', () => { billboard.classList.add('playing'); if (muteBtn) muteBtn.hidden = false; setMuteIcon(); });
                    v.addEventListener('ended', endPreview);
                    v.addEventListener('error', () => { v.remove(); bb.video = null; billboard.classList.remove('playing'); });
                    media.insertBefore(v, media.querySelector('.nf-billboard-vignette'));
                    bb.video = v;
                } else {
                    try { bb.video.currentTime = c.preview.start || 0; } catch { /* ignore */ }
                }
                bb.video.muted = bb.muted;
                bb.video.play().catch(() => {});
                bb.stopTimer = setTimeout(endPreview, 75000);
            } else if (c.preview.kind === 'youtube') {
                const f = document.createElement('iframe');
                const yid = encodeURIComponent(c.preview.id);
                f.src = `https://www.youtube-nocookie.com/embed/${yid}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3&playsinline=1&disablekb=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
                f.allow = 'autoplay; encrypted-media';
                f.tabIndex = -1;
                media.insertBefore(f, media.querySelector('.nf-billboard-vignette'));
                bb.iframe = f;
                watchYouTube(f, {
                    playing: () => { billboard.classList.add('playing'); if (muteBtn) muteBtn.hidden = false; setMuteIcon(); },
                    ended: endPreview,
                    error: () => { f.remove(); bb.iframe = null; billboard.classList.remove('playing'); }
                });
                bb.stopTimer = setTimeout(endPreview, 90000);
            }
        };
        bb.pause = () => { if (bb.video && !bb.video.paused) bb.video.pause(); };
        bb.resume = () => {
            if (bb.ended || !bb.video || $('#nfModal.open') || document.hidden) return;
            const r = billboard.getBoundingClientRect();
            if (r.bottom > window.innerHeight * 0.35) bb.video.play().catch(() => {});
        };
        if (muteBtn) muteBtn.addEventListener('click', () => {
            if (bb.ended) { startVideo(); return; }
            bb.muted = !bb.muted;
            if (bb.video) bb.video.muted = bb.muted;
            if (bb.iframe) ytCommand(bb.iframe, bb.muted ? 'mute' : 'unMute');
            setMuteIcon();
        });
        setTimeout(startVideo, 2600);
        if ('IntersectionObserver' in window) {
            new IntersectionObserver(([en]) => { if (en.intersectionRatio < 0.35) bb.pause(); else bb.resume(); }, { threshold: [0, 0.35, 0.6] }).observe(billboard);
        }
        document.addEventListener('visibilitychange', () => (document.hidden ? bb.pause() : bb.resume()));
    }

    // Minimal YouTube iframe API (postMessage) for mute and state changes.
    function ytCommand(iframe, func, args = []) {
        try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), '*'); } catch { /* ignore */ }
    }
    function watchYouTube(iframe, handlers) {
        const onMsg = (e) => {
            if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname) || e.source !== iframe.contentWindow) return;
            let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
            if (!d) return;
            const state = d.event === 'onStateChange' ? d.info : (d.info && d.info.playerState);
            if (state === 1) handlers.playing && handlers.playing();
            if (state === 0) handlers.ended && handlers.ended();
            if (d.event === 'onError') { handlers.error && handlers.error(); window.removeEventListener('message', onMsg); }
        };
        window.addEventListener('message', onMsg);
        iframe.addEventListener('load', () => {
            try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*'); } catch { /* ignore */ }
        });
    }

    // ------------------------------------------------------------------ hover preview ("mini modal")
    const mini = $('#nfMini');
    let hoverTimer = null, miniCard = null, miniVideoTimer = null, miniCloseTimer = null, miniScale = 1;

    function closeMini(immediate) {
        clearTimeout(hoverTimer);
        clearTimeout(miniVideoTimer);
        if (!mini || !miniCard) return;
        const v = mini.querySelector('video');
        if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
        miniCard = null;
        mini.classList.remove('in');
        if (immediate) {
            mini.style.transition = 'none';
            mini.style.opacity = '0';
            mini.innerHTML = '';
            return;
        }
        mini.style.transition = 'transform .22s ease, opacity .22s ease';
        mini.style.transform = `scale(${miniScale})`;
        mini.style.opacity = '0';
        clearTimeout(miniCloseTimer);
        miniCloseTimer = setTimeout(() => { if (!miniCard) mini.innerHTML = ''; }, 240);
        if (bb) bb.resume();
    }

    function openMini(card) {
        const id = card.dataset.id;
        const c = T[id];
        if (!mini || !c || !document.body.contains(card)) return;
        clearTimeout(miniCloseTimer);
        const r = card.getBoundingClientRect();
        if (r.width < 40 || r.right < 0 || r.left > innerWidth) return;
        miniCard = card;
        if (bb) bb.pause();
        const vw = document.documentElement.clientWidth;
        const gutter = Math.max(12, vw * 0.04);
        const width = Math.round(Math.min(Math.max(r.width * 1.5, 290), vw - 2 * gutter));
        let left = r.left + r.width / 2 - width / 2;
        left = Math.min(Math.max(left, gutter), vw - gutter - width);
        const mediaH = width * 9 / 16;
        let top = r.top + r.height / 2 - mediaH / 2;
        const playId = card.dataset.play || id;
        const pct = parseFloat(card.dataset.pct || '0');
        const epLabel = card.dataset.ep ? `${esc(card.dataset.ep)}${card.dataset.epTitle ? ` “${esc(card.dataset.epTitle)}”` : ''}` : '';
        const isContinue = card.dataset.pct != null;
        mini.innerHTML = `
            <div class="nf-mini-media" data-modal="${id}">
                <img src="${esc(c.backdrop || c.img || c.poster)}" alt="">
                ${c.logo ? `<img class="nf-mini-logo" src="${esc(c.logo)}" alt="">` : `<span class="nf-mini-name">${esc(c.title)}</span>`}
                <button type="button" class="nf-circle nf-mini-mute" aria-label="${esc(tr('mute'))}"><i class="fa-solid fa-volume-xmark"></i></button>
            </div>
            <div class="nf-mini-body">
                <div class="nf-mini-actions">
                    <a class="nf-circle solid" href="/watch/${playId}" data-tip="${esc(isContinue ? tr('resume') : tr('play'))}" aria-label="${esc(tr('play'))}"><i class="fa-solid fa-play"></i></a>
                    <button type="button" class="nf-circle" data-list="${id}" data-tip="${esc(c.inList ? tr('remove_from_list') : tr('add_to_list'))}">${listIcon(c.inList)}</button>
                    ${rateHtml(id, c.thumb || 0)}
                    ${isContinue ? `<button type="button" class="nf-circle" data-remove-progress="${id}" data-tip="${esc(tr('remove_from_row'))}"><i class="fa-solid fa-xmark"></i></button>` : ''}
                    <span class="spacer"></span>
                    <button type="button" class="nf-circle" data-modal="${id}" data-tip="${esc(c.type === 'series' ? tr('episodes_info') : tr('more_info'))}"><i class="fa-solid fa-chevron-down"></i></button>
                </div>
                ${isContinue && pct > 0 ? `<div class="nf-mini-progress"><span class="bar"><span style="width:${Math.round(pct * 100)}%"></span></span>${epLabel ? `<span>${epLabel}</span>` : ''}</div>` : ''}
                <div class="nf-mini-meta">${metaLine(c)}</div>
                <div class="nf-tags">${tagsHtml(c.genres)}</div>
            </div>`;
        mini.style.transition = 'none';
        mini.style.width = width + 'px';
        mini.style.left = (left + window.scrollX) + 'px';
        mini.style.top = (top + window.scrollY) + 'px';
        mini.style.transform = 'none';
        fitTitles(mini);
        // keep the whole popup on screen
        const h = mini.offsetHeight;
        const navH = 72;
        if (top + h > innerHeight - 10) top = Math.max(navH, innerHeight - 10 - h);
        if (top < navH && r.top >= navH) top = navH;
        mini.style.top = (top + window.scrollY) + 'px';
        // grow out of the card (FLIP)
        const s = r.width / width;
        miniScale = s;
        const ox = (r.left - left) / (1 - s || 1);
        const oy = (r.top - top) / (1 - s || 1);
        mini.style.transformOrigin = `${ox}px ${oy}px`;
        mini.style.transform = `scale(${s})`;
        mini.style.opacity = '0.4';
        void mini.offsetWidth;
        mini.style.transition = 'transform .3s cubic-bezier(.2,.8,.2,1), opacity .18s ease';
        mini.style.transform = 'none';
        mini.style.opacity = '1';
        mini.classList.add('in');

        if (c.preview && c.preview.kind === 'video' && !reducedMotion) {
            miniVideoTimer = setTimeout(() => {
                if (miniCard !== card) return;
                const m = mini.querySelector('.nf-mini-media');
                const v = document.createElement('video');
                v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('muted', '');
                v.src = c.preview.src;
                v.addEventListener('loadedmetadata', () => { try { v.currentTime = c.preview.start || 0; } catch { /* ignore */ } }, { once: true });
                v.addEventListener('playing', () => m.classList.add('playing'));
                v.addEventListener('error', () => v.remove());
                m.insertBefore(v, m.firstChild.nextSibling);
                v.play().catch(() => {});
                const mute = m.querySelector('.nf-mini-mute');
                mute.addEventListener('click', (e) => {
                    e.stopPropagation();
                    v.muted = !v.muted;
                    mute.innerHTML = `<i class="fa-solid ${v.muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
                });
            }, 700);
        }
    }

    if (mini && finePointer) {
        document.addEventListener('mouseover', (e) => {
            const card = e.target.closest('.nf-slider .nf-card, .nf-grid .nf-card');
            if (!card || card === miniCard) return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => openMini(card), miniCard ? 120 : 480);
        });
        document.addEventListener('mouseout', (e) => {
            const card = e.target.closest('.nf-card');
            if (card && !card.contains(e.relatedTarget) && !(e.relatedTarget && mini.contains(e.relatedTarget))) clearTimeout(hoverTimer);
        });
        mini.addEventListener('mouseleave', (e) => {
            if (e.relatedTarget && miniCard && miniCard.contains(e.relatedTarget)) return;
            closeMini();
        });
        window.addEventListener('scroll', () => { if (miniCard) closeMini(); }, { passive: true });
        window.addEventListener('blur', () => closeMini());
    }

    // ------------------------------------------------------------------ details modal
    const overlay = $('#nfModal');
    const modalBody = $('#nfModalBody');
    let modalId = null, modalPushed = false, modalData = null;

    function closeModal(fromPop) {
        if (!overlay || !overlay.classList.contains('open')) return;
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
        body.classList.remove('nf-lock');
        const v = modalBody.querySelector('video');
        if (v) v.pause();
        setTimeout(() => { if (!overlay.classList.contains('open')) modalBody.innerHTML = ''; }, 300);
        modalId = null;
        if (!fromPop) {
            if (modalPushed) history.back();
            else {
                const u = new URL(location.href);
                if (u.searchParams.has('jbv') || u.pathname.startsWith('/title/')) {
                    u.searchParams.delete('jbv');
                    history.replaceState(null, '', u.pathname.startsWith('/title/') ? '/' : u.pathname + u.search);
                }
            }
        }
        modalPushed = false;
        if (bb) bb.resume();
    }

    async function openModal(id, { push = true } = {}) {
        if (!overlay) { location.href = '/title/' + id; return; }
        id = String(id);
        closeMini(true);
        if (bb) bb.pause();
        const already = overlay.classList.contains('open');
        modalId = id;
        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
        body.classList.add('nf-lock');
        overlay.scrollTop = 0;
        const c = T[id];
        modalBody.innerHTML = `<button class="nf-modal-close" type="button" aria-label="${esc(tr('close'))}"><i class="fa-solid fa-xmark"></i></button>` +
            (c ? `<div class="nf-modal-hero"><img src="${esc(c.backdrop || c.img)}" alt=""></div>` : '') +
            `<div class="nf-modal-loading"><div class="nf-spinner"></div></div>`;
        if (push) {
            const u = new URL(location.href);
            if (!u.pathname.startsWith('/title/')) {
                u.searchParams.set('jbv', id);
                if (already && modalPushed) history.replaceState({ nfModal: id }, '', u);
                else { history.pushState({ nfModal: id }, '', u); modalPushed = true; }
            }
        }
        try {
            const data = await api('/api/titles/' + id);
            if (modalId !== id) return;
            modalData = data;
            T[id] = Object.assign(T[id] || {}, data.title);
            data.similar.forEach(s => { if (!T[s.id]) T[s.id] = s; });
            renderModal(data);
        } catch (e) {
            modalBody.innerHTML = `<button class="nf-modal-close" type="button"><i class="fa-solid fa-xmark"></i></button><div class="nf-empty"><i class="fa-solid fa-triangle-exclamation"></i><h2>${esc(tr('failed_to_load'))}</h2><p>${esc(e.message)}</p></div>`;
        }
    }

    function episodeRows(season, data) {
        const curId = data.play ? data.play.id : null;
        return season.episodes.map(ep => `
            <div class="nf-episode${ep.id === curId ? ' current' : ''}${ep.playable ? '' : ' disabled'}" ${ep.playable ? `data-href="/watch/${ep.id}"` : ''} tabindex="0">
                <div class="nf-episode-index">${ep.order}</div>
                <div class="nf-episode-thumb">
                    ${ep.thumbnail ? `<img src="${esc(ep.thumbnail)}" alt="" loading="lazy">` : ''}
                    ${ep.playable ? '<span class="play"><i class="fa-solid fa-play"></i></span>' : ''}
                    ${ep.pct > 0.01 ? `<span class="bar"><span style="width:${Math.round(ep.pct * 100)}%"></span></span>` : ''}
                    ${ep.downloading != null ? `<span class="nf-dl-chip"><i class="fa-solid fa-arrow-down"></i> ${ep.downloading}%</span>` : ''}
                </div>
                <div class="nf-episode-info">
                    <div class="top"><span>${esc(ep.title || tr('episode_n', { n: ep.order }))}</span><span>${esc(fmtMinutes(ep.duration))}</span></div>
                    <p>${esc(ep.description)}</p>
                </div>
            </div>`).join('');
    }

    function renderModal(data) {
        const c = data.title;
        const id = c.id;
        const play = data.play;
        const playLabel = play ? (play.resume ? tr('resume') : tr('play')) : tr('unavailable');
        const resumeLine = play && play.resume ? `<div class="nf-modal-progress">${play.season ? `<span>${esc(tr('ep_short', { s: play.season, e: play.order }))}${play.title ? ` “${esc(play.title)}”` : ''}</span>` : ''}<span class="bar"><span style="width:${Math.round((play.pct || 0) * 100)}%"></span></span>${play.remaining ? `<span>${esc(tr('min_left', { n: play.remaining }))}</span>` : ''}</div>` : '';
        const seasons = data.seasons || [];
        const curSeason = play && play.season ? play.season : (seasons[0] ? seasons[0].season : 1);
        const seasonSel = seasons.length > 1
            ? `<select class="nf-season-select" id="nfSeasonSel">${seasons.map(s => `<option value="${s.season}"${s.season === curSeason ? ' selected' : ''}>${esc(tr('season_n', { n: s.season }))} (${s.episodes.length})</option>`).join('')}</select>`
            : (seasons.length === 1 ? `<span style="color:#bcbcbc">${esc(tr('season_n', { n: seasons[0].season }))}</span>` : '');
        const activeSeason = seasons.find(s => s.season === curSeason) || seasons[0];
        const top10 = c.top10 ? `<div class="nf-modal-rankline"><span class="nf-top10-tag"><b>TOP</b><b>10</b></span>${esc(tr('rank_in', { rank: c.top10, kind: c.type === 'movie' ? tr('in_movies') : tr('in_shows') }))}</div>` : '';
        const castShort = (c.cast || []).slice(0, 3);
        const similar = data.similar || [];

        modalBody.innerHTML = `
            <button class="nf-modal-close" type="button" aria-label="${esc(tr('close'))}"><i class="fa-solid fa-xmark"></i></button>
            <div class="nf-modal-hero" id="nfModalHero">
                <img src="${esc(c.backdrop || c.img || c.poster)}" alt="">
                <div class="nf-modal-hero-info">
                    ${c.logo ? `<img class="nf-modal-logo" src="${esc(c.logo)}" alt="${esc(c.title)}">` : `<h2 class="nf-modal-title">${esc(c.title)}</h2>`}
                    <div class="nf-modal-actions">
                        ${play ? `<a class="nf-btn nf-btn-play" href="/watch/${play.id}"><i class="fa-solid fa-play"></i> ${esc(playLabel)}</a>` : `<span class="nf-btn" style="opacity:.6">${esc(playLabel)}</span>`}
                        <button type="button" class="nf-circle" data-list="${id}" data-tip="${esc(c.inList ? tr('remove_from_list') : tr('add_to_list'))}">${listIcon(c.inList)}</button>
                        ${rateHtml(id, c.thumb || 0)}
                        <span class="spacer"></span>
                        ${c.preview || c.trailer ? `<button type="button" class="nf-circle" id="nfModalMute" hidden aria-label="${esc(tr('mute'))}"><i class="fa-solid fa-volume-xmark"></i></button>` : ''}
                    </div>
                </div>
            </div>
            <div class="nf-modal-body">
                <div class="nf-modal-mobile-actions">
                    ${play ? `<a class="nf-btn nf-btn-play" href="/watch/${play.id}"><i class="fa-solid fa-play"></i> ${esc(playLabel)}</a>` : ''}
                    <div class="icons">
                        <button type="button" data-list="${id}">${listIcon(c.inList)}<span>${esc(tr('my_list'))}</span></button>
                        <button type="button" data-rate-quick="${id}"><i class="fa-regular fa-thumbs-up"></i><span>${esc(tr('rate'))}</span></button>
                        ${data.canManage ? `<a href="/admin/title/${id}" style="display:flex;flex-direction:column;align-items:center;gap:.5em;font-size:.8em;color:#b3b3b3"><i class="fa-solid fa-pen" style="font-size:1.5em;color:#fff"></i><span>${esc(tr('edit'))}</span></a>` : ''}
                    </div>
                </div>
                <div class="nf-modal-grid">
                    <div>
                        <div class="nf-modal-meta">${metaLine(c, { year: true })}</div>
                        ${top10}
                        ${resumeLine}
                        ${c.tagline ? `<p class="nf-modal-tagline">${esc(c.tagline)}</p>` : ''}
                        <p class="nf-modal-desc">${esc(c.description || tr('no_description'))}</p>
                    </div>
                    <div class="nf-modal-side">
                        ${castShort.length ? `<div><span class="k">${esc(tr('cast'))}:</span> ${castShort.map(n => `<a href="/search?q=${encodeURIComponent(n)}">${esc(n)}</a>`).join(', ')}${c.cast.length > 3 ? `, <a href="#nfAbout"><i>${esc(tr('more'))}</i></a>` : ''}</div>` : ''}
                        ${(c.allGenres || []).length ? `<div><span class="k">${esc(tr('genres'))}:</span> ${c.allGenres.map(g => `<a href="/browse/genre/${encodeURIComponent(g)}">${esc(g)}</a>`).join(', ')}</div>` : ''}
                        ${c.director ? `<div><span class="k">${esc(c.type === 'series' ? tr('creators') : tr('director'))}:</span> ${esc(c.director)}</div>` : ''}
                        ${data.canManage ? `<div><a href="/admin/title/${id}"><i class="fa-solid fa-pen"></i> ${esc(tr('edit_title'))}</a></div>` : ''}
                    </div>
                </div>
                ${seasons.length ? `
                    <div class="nf-ep-head"><h3>${esc(tr('episodes_heading'))}</h3>${seasonSel}</div>
                    <div class="nf-episodes" id="nfEpisodes">${activeSeason ? episodeRows(activeSeason, data) : ''}</div>` : (c.type === 'series' ? `<p style="color:#888;margin-top:2em">${esc(tr('no_episodes'))}</p>` : '')}
                ${similar.length ? `
                    <h3>${esc(tr('more_like_this'))}</h3>
                    <div class="nf-similar-grid${similar.length > 6 ? ' collapsed' : ''}" id="nfSimilar">
                        ${similar.map(s => `
                            <div class="nf-similar" data-modal="${s.id}" tabindex="0">
                                <div class="nf-similar-img">
                                    <picture>${s.poster ? `<source media="(max-width: 740px)" srcset="${esc(s.poster)}">` : ''}<img src="${esc(s.img || s.backdrop || s.poster)}" alt="${esc(s.title)}" loading="lazy"></picture>
                                    <span class="dur">${esc(durationLabel(s))}</span>
                                    <span class="play"><i class="fa-regular fa-circle-play"></i></span>
                                </div>
                                <div class="nf-similar-body">
                                    <div class="row">
                                        <div class="meta"><b>${esc(s.title)}</b><span>${s.isNew ? `<span class="nf-new">${esc(tr('new'))}</span>` : `<span class="nf-match">${esc(tr('match', { n: s.match }))}</span>`} ${s.maturity ? `<span class="nf-maturity">${esc(s.maturity)}</span>` : ''} ${s.year || ''}</span></div>
                                        <button type="button" class="nf-circle" data-list="${s.id}" title="${esc(s.inList ? tr('remove_from_list') : tr('add_to_list'))}">${listIcon(s.inList)}</button>
                                    </div>
                                    <p>${esc(s.synopsis)}</p>
                                </div>
                            </div>`).join('')}
                    </div>
                    ${similar.length > 6 ? `<div class="nf-more-toggle"><button type="button" class="nf-circle" id="nfSimilarMore" aria-label="${esc(tr('more'))}"><i class="fa-solid fa-chevron-down"></i></button></div>` : ''}` : ''}
                <div class="nf-about" id="nfAbout">
                    <h3>${tr('about_title', { title: '%%T%%' }).split('%%T%%').map(esc).join(`<b>${esc(c.title)}</b>`)}</h3>
                    ${c.director ? `<div><span class="k">${esc(c.type === 'series' ? tr('creators') : tr('director'))}:</span> ${esc(c.director)}</div>` : ''}
                    ${(c.cast || []).length ? `<div><span class="k">${esc(tr('cast'))}:</span> ${c.cast.map(esc).join(', ')}</div>` : ''}
                    ${(c.allGenres || []).length ? `<div><span class="k">${esc(tr('genres'))}:</span> ${c.allGenres.map(esc).join(', ')}</div>` : ''}
                    ${c.score ? `<div><span class="k">${esc(tr('rating'))}:</span> ★ ${esc(c.score)} / 10</div>` : ''}
                    ${c.maturity ? `<div><span class="k">${esc(tr('maturity_rating'))}:</span> <span class="nf-maturity">${esc(c.maturity)}</span></div>` : ''}
                </div>
            </div>`;

        const sel = $('#nfSeasonSel');
        if (sel) sel.addEventListener('change', () => {
            const s = seasons.find(x => String(x.season) === sel.value);
            $('#nfEpisodes').innerHTML = s ? episodeRows(s, data) : '';
        });
        const more = $('#nfSimilarMore');
        if (more) more.addEventListener('click', () => {
            const g = $('#nfSimilar');
            g.classList.toggle('collapsed');
            more.innerHTML = `<i class="fa-solid fa-chevron-${g.classList.contains('collapsed') ? 'down' : 'up'}"></i>`;
        });
        fitTitles(modalBody);
        startModalPreview(c);
    }

    function startModalPreview(c) {
        const hero = $('#nfModalHero');
        const mute = $('#nfModalMute');
        if (!hero || reducedMotion || (!c.preview && !c.trailer)) return;
        const id = c.id;
        setTimeout(() => {
            if (modalId !== String(id) || !hero.isConnected) return;
            const pv = c.preview && c.preview.kind === 'video' ? c.preview : null;
            const yt = !pv ? (c.preview && c.preview.kind === 'youtube' ? c.preview.id : c.trailer) : null;
            if (pv) {
                const v = document.createElement('video');
                v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('muted', '');
                v.src = pv.src;
                v.addEventListener('loadedmetadata', () => { try { v.currentTime = pv.start || 0; } catch { /* ignore */ } }, { once: true });
                v.addEventListener('playing', () => { hero.classList.add('playing'); if (mute) mute.hidden = false; });
                v.addEventListener('ended', () => hero.classList.remove('playing'));
                v.addEventListener('error', () => v.remove());
                hero.insertBefore(v, hero.children[1]);
                v.play().catch(() => {});
                if (mute) mute.addEventListener('click', () => {
                    v.muted = !v.muted;
                    mute.innerHTML = `<i class="fa-solid ${v.muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
                });
            } else if (yt && finePointer) {
                const f = document.createElement('iframe');
                f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3&playsinline=1&disablekb=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
                f.allow = 'autoplay; encrypted-media';
                f.tabIndex = -1;
                hero.insertBefore(f, hero.children[1]);
                let muted = true;
                watchYouTube(f, {
                    playing: () => { hero.classList.add('playing'); if (mute) mute.hidden = false; },
                    ended: () => hero.classList.remove('playing'),
                    error: () => f.remove()
                });
                if (mute) mute.addEventListener('click', () => {
                    muted = !muted;
                    ytCommand(f, muted ? 'mute' : 'unMute');
                    mute.innerHTML = `<i class="fa-solid ${muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
                });
            }
        }, 900);
    }

    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('.nf-modal-close')) { e.preventDefault(); closeModal(); }
        });
        window.addEventListener('popstate', (e) => {
            const st = e.state;
            if (st && st.nfModal) openModal(st.nfModal, { push: false });
            else if (overlay.classList.contains('open')) { modalPushed = false; closeModal(true); }
        });
    }

    // ------------------------------------------------------------------ global clicks & keys
    document.addEventListener('click', (e) => {
        const t = e.target;
        const lb = t.closest('[data-list]');
        if (lb) { e.preventDefault(); e.stopPropagation(); toggleList(lb.dataset.list).catch(err => toast(err.message, true)); return; }
        const rb = t.closest('[data-rate]');
        if (rb) {
            e.preventDefault(); e.stopPropagation();
            const root = rb.closest('[data-rate-root]');
            rate(root.dataset.rateRoot, parseInt(rb.dataset.rate, 10)).catch(err => toast(err.message, true));
            return;
        }
        const rq = t.closest('[data-rate-quick]');
        if (rq) { e.preventDefault(); rate(rq.dataset.rateQuick, 1).catch(err => toast(err.message, true)); return; }
        const rp = t.closest('[data-remove-progress]');
        if (rp) {
            e.preventDefault(); e.stopPropagation();
            const id = rp.dataset.removeProgress;
            api('/api/progress/' + id, { method: 'DELETE' }).then(() => {
                closeMini(true);
                $$(`.nf-row--continue .nf-card[data-id="${id}"]`).forEach(c => c.remove());
                toast(tr('removed_from_row'));
            }).catch(err => toast(err.message, true));
            return;
        }
        const ep = t.closest('.nf-episode[data-href]');
        if (ep) { location.href = ep.dataset.href; return; }
        const mb = t.closest('[data-modal]');
        if (mb && !t.closest('a.nf-circle, a.nf-btn')) { e.preventDefault(); openModal(mb.dataset.modal); return; }
        const card = t.closest('.nf-card[data-id]');
        if (card && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
            e.preventDefault();
            if (card.dataset.play) location.href = '/watch/' + card.dataset.play;
            else openModal(card.dataset.id);
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (overlay && overlay.classList.contains('open')) closeModal();
            closeMini(true);
            closeDrops();
        }
        if (e.key === 'Enter' && document.activeElement && document.activeElement.matches('.nf-episode[data-href]')) {
            location.href = document.activeElement.dataset.href;
        }
    });

    fitTitles(document);
    if (NF.openTitle) openModal(NF.openTitle, { push: false });
})();
