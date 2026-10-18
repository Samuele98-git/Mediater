/* MEDIATER — Downloads page (BitTorrent) */
(() => {
    'use strict';
    const D = window.__dl || {};
    const L = D.i18n || {};
    const tr = (k, vars) => {
        let s = L[k] != null ? String(L[k]) : k;
        if (vars) for (const [a, b] of Object.entries(vars)) s = s.split('{' + a + '}').join(b);
        return s;
    };
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const toast = (m, e) => (window.nfToast ? window.nfToast(m, e) : alert(m));
    const VIDEO_RE = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|mpg|mpeg|ts|m2ts|ogv|3gp|divx)$/i;
    const SUB_RE = /\.(srt|vtt|ass|ssa)$/i;

    const fmtBytes = (n) => {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        const u = ['KB', 'MB', 'GB', 'TB'];
        let i = -1;
        do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
        return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
    };
    const fmtSpeed = (n) => fmtBytes(n) + '/s';
    const fmtEta = (s) => {
        if (s == null) return '';
        if (s < 60) return tr('eta_s', { n: s });
        if (s < 3600) return tr('eta_m', { n: Math.round(s / 60) });
        return tr('eta_h', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) });
    };
    async function api(url, opts = {}) {
        const headers = { Accept: 'application/json' };
        if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
        const r = await fetch(url, { credentials: 'same-origin', ...opts, headers });
        if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || r.statusText);
        return j;
    }
    const peersText = (n) => tr(n === 1 ? 'peer_one' : 'peers', { n });
    const fileIcon = (name) => VIDEO_RE.test(name) ? 'fa-film' : SUB_RE.test(name) ? 'fa-closed-captioning' : /\.(jpe?g|png|webp)$/i.test(name) ? 'fa-image' : 'fa-file';

    // ------------------------------------------------------------ list
    let state = { torrents: [], summary: {}, disk: D.disk || {} };
    let filter = 'all';
    const els = new Map();
    const expanded = new Set();
    const list = $('#dlList');
    const GROUPS = {
        all: () => true,
        active: (t) => ['downloading', 'metadata', 'pending'].includes(t.status),
        paused: (t) => t.status === 'paused' || t.status === 'error',
        completed: (t) => t.status === 'completed'
    };

    // Finished movies and shows leave the list (they're in the library now): say so.
    let seenFinished = null;
    function announceFinished(list) {
        if (!Array.isArray(list)) return;
        if (seenFinished === null) { seenFinished = new Set(list.map(f => f.key)); return; }
        for (const f of list.slice().reverse()) {
            if (seenFinished.has(f.key)) continue;
            seenFinished.add(f.key);
            toast(tr(f.href ? 'finished_toast' : 'finished_toast_other', { title: f.title }));
        }
    }

    function connect() {
        if (!window.EventSource) { setInterval(() => api('/api/torrents').then(s => { state = s; render(); }).catch(() => {}), 2000); return; }
        const es = new EventSource('/api/torrents/events');
        es.onmessage = (e) => { try { state = JSON.parse(e.data); render(); } catch { /* ignore */ } };
        es.onerror = () => { es.close(); setTimeout(connect, 3000); };
    }

    function render() {
        const { torrents = [], summary = {}, disk = {} } = state;
        announceFinished(state.finished);
        $('#dlDown').textContent = fmtSpeed(summary.downloadSpeed || 0);
        $('#dlActive').textContent = summary.active ? tr('active_count', { n: summary.active }) : '';
        if (disk.total) {
            const used = 1 - disk.free / disk.total;
            const bar = $('#dlDisk .bar span');
            bar.style.width = (used * 100).toFixed(1) + '%';
            bar.classList.toggle('warn', disk.free < 10 * 1024 ** 3);
            $('#dlDiskText').textContent = tr('disk_free', { free: fmtBytes(disk.free), total: fmtBytes(disk.total) });
            $('#dlDiskPath').textContent = disk.path || '';
        }
        $$('#dlTabs button').forEach(b => {
            const n = torrents.filter(GROUPS[b.dataset.f]).length;
            b.querySelector('span').textContent = n ? ` ${n}` : '';
            b.classList.toggle('on', b.dataset.f === filter);
            // Paused / Completed only show up when there is something in them.
            b.hidden = !n && (b.dataset.f === 'paused' || b.dataset.f === 'completed') && filter !== b.dataset.f;
        });
        $('#dlEmpty').hidden = torrents.length > 0;
        const visible = torrents.filter(GROUPS[filter]);
        const seen = new Set();
        visible.forEach((t, i) => {
            let el = els.get(t.id);
            if (!el) { el = createItem(t); els.set(t.id, el); }
            updateItem(el, t);
            seen.add(t.id);
            if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
        });
        for (const [id, el] of els) {
            if (!seen.has(id)) {
                el.remove();
                if (!torrents.some(t => t.id === id)) { els.delete(id); expanded.delete(id); }
            }
        }
    }

    function createItem(t) {
        const el = document.createElement('article');
        el.className = 'dl-item';
        el.dataset.id = t.id;
        el.innerHTML = `
            <div class="dl-row">
                <div class="dl-art"></div>
                <div>
                    <div class="dl-title"><span class="name"></span><span class="dl-pill"></span></div>
                    <div class="dl-linked"></div>
                    <div class="dl-progress"><div class="dl-bar"><span></span></div><canvas class="dl-pieces" width="240" height="1"></canvas></div>
                    <div class="dl-stats"></div>
                </div>
                <div class="dl-btns"></div>
            </div>
            <div class="dl-files" hidden></div>`;
        return el;
    }

    const STATUS = (s) => tr('status_' + s);

    function playTarget(t) {
        const movie = t.media.find(m => m.type === 'movie');
        if (movie) return '/watch/' + movie.id;
        const series = t.media.find(m => m.type === 'series');
        const ep = t.media.filter(m => m.type === 'episode').find(m => m.fileIndex === t.mainFile) || t.media.find(m => m.type === 'episode');
        if (ep) return '/watch/' + ep.id;
        if (series) return '/title/' + series.id;
        if (t.mainFile != null && t.status !== 'metadata') return `/watch/t/${t.id}/${t.mainFile}`;
        return null;
    }

    function updateItem(el, t) {
        el.className = 'dl-item ' + t.status;
        const art = $('.dl-art', el);
        const poster = (t.match && t.match.poster) || t.art;
        if (art.dataset.src !== (poster || '')) {
            art.dataset.src = poster || '';
            art.innerHTML = poster ? `<img src="${esc(poster)}" alt="" loading="lazy">` : `<i class="fa-solid ${t.kind === 'series' ? 'fa-tv' : t.kind === 'other' ? 'fa-folder' : 'fa-film'}"></i>`;
        }
        $('.name', el).textContent = t.name;
        const pill = $('.dl-pill', el);
        pill.className = 'dl-pill ' + t.status;
        pill.textContent = STATUS(t.status);

        const linked = $('.dl-linked', el);
        const title = t.media.find(m => m.type === 'movie' || m.type === 'series');
        const kindLabel = t.kind === 'series' ? tr('kind_series') : t.kind === 'movie' ? tr('kind_movie') : t.kind === 'other' ? tr('kind_other') : '';
        const eps = t.media.filter(m => m.type === 'episode').length;
        const linkHtml = (title ? `<span><i class="fa-solid fa-link"></i> <a href="/title/${title.id}">${esc(t.match && t.match.title ? `${t.match.title}${t.match.year ? ` (${t.match.year})` : ''}` : title.title)}</a></span>` : '')
            + (kindLabel ? `<span>${esc(kindLabel)}${eps ? ` · ${esc(tr('episodes_count', { n: eps }))}` : ''}</span>` : '');
        if (linked.dataset.html !== linkHtml) { linked.innerHTML = linkHtml; linked.dataset.html = linkHtml; }

        $('.dl-bar span', el).style.width = (Math.min(1, t.progress || 0) * 100).toFixed(2) + '%';
        drawPieces($('.dl-pieces', el), t.pieces);

        const st = [];
        const pct = Math.floor((t.progress || 0) * 1000) / 10;
        switch (t.status) {
            case 'metadata': st.push(`<span>${esc(tr('fetching_info'))}</span>`, `<span>${esc(peersText(t.peers))}</span>`); break;
            case 'pending': st.push(`<span>${esc(tr('pending_hint'))}</span>`, t.size ? `<span>${fmtBytes(t.totalSize)}</span>` : '', `<span>${esc(peersText(t.peers))}</span>`); break;
            case 'downloading':
                st.push(`<span><b>${pct}%</b></span>`, `<span>${fmtBytes(t.downloaded)} / ${fmtBytes(t.size)}</span>`,
                    `<span><i class="fa-solid fa-arrow-down"></i> ${fmtSpeed(t.downloadSpeed)}</span>`,
                    `<span>${esc(peersText(t.peers))}</span>`, t.eta != null ? `<span>${esc(tr('left', { t: fmtEta(t.eta) }))}</span>` : '');
                break;
            case 'completed':
                st.push(`<span>${fmtBytes(t.size)}</span>`, t.completedAt ? `<span>${esc(tr('finished_on', { d: new Date(t.completedAt).toLocaleString() }))}</span>` : '');
                if (t.error) st.push(`<span class="err"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(t.error)}</span>`);
                break;
            case 'paused': st.push(`<span>${esc(tr('paused_at', { p: pct }))}</span>`, `<span>${fmtBytes(t.downloaded)} / ${fmtBytes(t.size || t.totalSize)}</span>`); break;
            case 'error': st.push(`<span class="err"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(t.error || tr('status_error'))}</span>`); break;
        }
        const stHtml = st.filter(Boolean).join('');
        const stats = $('.dl-stats', el);
        if (stats.dataset.html !== stHtml) { stats.innerHTML = stHtml; stats.dataset.html = stHtml; }

        const target = playTarget(t);
        const btns = [];
        if (t.status === 'pending') btns.push(`<button class="nf-btn nf-btn-red" data-act="choose">${esc(tr('choose_files'))}</button>`);
        if (target) btns.push(`<a class="nf-circle solid" href="${esc(target)}" data-tip="${esc(t.status === 'completed' ? tr('play') : tr('stream'))}"><i class="fa-solid fa-play"></i></a>`);
        if (['downloading', 'metadata'].includes(t.status)) btns.push(`<button class="nf-circle" data-act="pause" data-tip="${esc(tr('pause'))}"><i class="fa-solid fa-pause"></i></button>`);
        if (['paused', 'error'].includes(t.status)) btns.push(`<button class="nf-circle" data-act="resume" data-tip="${esc(tr('resume'))}"><i class="fa-solid fa-rotate-right"></i></button>`);
        if (t.status !== 'metadata') btns.push(`<button class="nf-circle" data-act="files" data-tip="${esc(tr('files'))}"><i class="fa-solid fa-chevron-${expanded.has(t.id) ? 'up' : 'down'}"></i></button>`);
        btns.push(`<button class="nf-circle" data-act="remove" data-tip="${esc(tr('remove'))}"><i class="fa-solid fa-trash"></i></button>`);
        const bHtml = btns.join('');
        const box = $('.dl-btns', el);
        if (box.dataset.html !== bHtml) { box.innerHTML = bHtml; box.dataset.html = bHtml; }

        const filesBox = $('.dl-files', el);
        filesBox.hidden = !expanded.has(t.id);
        if (expanded.has(t.id)) refreshFiles(t, filesBox);
    }

    function drawPieces(canvas, str) {
        if (canvas.dataset.s === (str || '')) return;
        canvas.dataset.s = str || '';
        canvas.style.visibility = str ? 'visible' : 'hidden';
        if (!str) return;
        canvas.width = str.length;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, 1);
        for (let i = 0; i < str.length; i++) {
            const v = Number(str[i]) / 9;
            ctx.fillStyle = v >= 1 ? 'rgba(70,211,105,.95)' : `rgba(70,211,105,${0.12 + v * 0.6})`;
            ctx.fillRect(i, 0, 1, 1);
        }
    }

    const fileFetch = new Map();
    async function refreshFiles(t, box) {
        const last = fileFetch.get(t.id) || 0;
        if (Date.now() - last < 2500 && box.childElementCount) return;
        fileFetch.set(t.id, Date.now());
        try {
            const d = await api('/api/torrents/' + t.id);
            const linkByFile = new Map(d.media.filter(m => m.fileIndex != null).map(m => [m.fileIndex, m]));
            box.innerHTML = (d.files || []).map(f => {
                const m = linkByFile.get(f.index);
                const href = m ? '/watch/' + m.id : (f.video && d.status !== 'metadata' ? `/watch/t/${d.id}/${f.index}` : null);
                return `<div class="dl-file${f.selected ? '' : ' unselected'}">
                    <span class="fname" title="${esc(f.path)}"><i class="fa-solid ${fileIcon(f.name)}"></i> ${esc(f.name)}</span>
                    <span class="size">${fmtBytes(f.length)}</span>
                    <span class="mini"><span style="width:${(f.progress * 100).toFixed(1)}%"></span></span>
                    ${href ? `<a href="${esc(href)}" class="nf-circle" style="width:32px;height:32px;font-size:.8rem;border-width:1px" title="${esc(tr('play'))}"><i class="fa-solid fa-play"></i></a>` : '<span></span>'}
                </div>`;
            }).join('');
        } catch { /* ignore */ }
    }

    list.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const item = b.closest('.dl-item');
        const id = Number(item.dataset.id);
        const t = state.torrents.find(x => x.id === id);
        try {
            switch (b.dataset.act) {
                case 'pause': await api(`/api/torrents/${id}/pause`, { method: 'POST' }); break;
                case 'resume': await api(`/api/torrents/${id}/resume`, { method: 'POST' }); break;
                case 'files':
                    if (expanded.has(id)) expanded.delete(id); else { expanded.add(id); fileFetch.delete(id); }
                    if (t) updateItem(item, t);
                    break;
                case 'remove': openRemove(t); break;
                case 'choose': openAdd({ resumeId: id }); break;
            }
        } catch (err) { toast(err.message, true); }
    });
    $('#dlTabs').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-f]');
        if (b) { filter = b.dataset.f; render(); }
    });

    // ------------------------------------------------------------ remove dialog
    const rm = $('#dlRemoveModal');
    let rmId = null;
    function openRemove(t) {
        if (!t) return;
        rmId = t.id;
        $('#dlRemoveName').textContent = t.name;
        $('#dlRemoveFiles').checked = t.status === 'pending' || t.status === 'metadata';
        rm.hidden = false;
    }
    $('#dlRemoveGo').addEventListener('click', async () => {
        const files = $('#dlRemoveFiles').checked;
        try {
            await api(`/api/torrents/${rmId}${files ? '?files=1' : ''}`, { method: 'DELETE' });
            toast(tr('removed'));
        } catch (err) { toast(err.message, true); }
        rm.hidden = true;
    });

    // ------------------------------------------------------------ add / preview dialog
    const modal = $('#dlAddModal');
    let ctx = null;
    const steps = { source: $('#dlStepSource'), wait: $('#dlStepWait'), preview: $('#dlStepPreview') };
    function showStep(name) {
        for (const [k, el] of Object.entries(steps)) el.hidden = k !== name;
        $('#dlNext').hidden = name === 'wait';
        $('#dlStream').hidden = name !== 'preview';
        $('#dlNext').textContent = name === 'preview' ? tr('download') : tr('continue');
        $('#dlNext').disabled = false;
        $('#dlAddTitle').textContent = name === 'preview' ? tr('review_title') : tr('add_title');
        $('#dlFooterInfo').textContent = '';
        if (ctx) ctx.step = name;
    }
    function openAdd({ magnet = '', file = null, resumeId = null, auto = false } = {}) {
        ctx = { step: 'source', id: null, file, stopped: false };
        $('#dlMagnet').value = magnet || $('#dlMagnet').value || '';
        $('#dlFileLabel').textContent = file ? file.name : tr('choose_file');
        $('#dlFilePick').classList.toggle('has', !!file);
        $('#dlSourceErr').hidden = true;
        $('#dlStartErr').hidden = true;
        modal.hidden = false;
        document.body.classList.add('nf-lock');
        if (resumeId) { ctx.id = resumeId; showStep('wait'); waitForMetadata(); return; }
        showStep('source');
        if (auto) submitSource();
        else setTimeout(() => $('#dlMagnet').focus(), 50);
    }
    async function closeAdd({ discard = false } = {}) {
        if (ctx) ctx.stopped = true;
        if (discard && ctx && ctx.id && (ctx.step === 'wait' || ctx.step === 'preview')) {
            const t = state.torrents.find(x => x.id === ctx.id);
            if (t && (t.status === 'pending' || t.status === 'metadata') && !ctx.keep) {
                await api(`/api/torrents/${ctx.id}?files=1`, { method: 'DELETE' }).catch(() => {});
            }
        }
        modal.hidden = true;
        document.body.classList.remove('nf-lock');
        $('#dlMagnet').value = '';
        $('#dlFile').value = '';
        ctx = null;
    }
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.closest('[data-close]')) closeAdd({ discard: true });
    });
    rm.addEventListener('click', (e) => { if (e.target === rm || e.target.closest('[data-close]')) rm.hidden = true; });
    $('#dlAddBtn').addEventListener('click', () => openAdd());
    $$('[data-open-add]').forEach(b => b.addEventListener('click', () => openAdd()));
    $('#dlFile').addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (ctx) ctx.file = f || null;
        $('#dlFileLabel').textContent = f ? f.name : tr('choose_file');
        $('#dlFilePick').classList.toggle('has', !!f);
        if (f) submitSource();
    });

    async function submitSource() {
        const text = $('#dlMagnet').value.trim();
        const lines = text.split(/\s*\n\s*/).filter(Boolean);
        if (!ctx.file && !lines.length) { $('#dlMagnet').focus(); return; }
        $('#dlNext').disabled = true;
        $('#dlSourceErr').hidden = true;
        try {
            if (!ctx.file && lines.length > 1) {
                // Several magnets at once: queue them all with default choices.
                for (const l of lines) {
                    const fd = new FormData(); fd.append('magnet', l); fd.append('start', '1');
                    await api('/api/torrents', { method: 'POST', body: fd }).catch(err => toast(err.message, true));
                }
                toast(tr('queued_many', { n: lines.length }));
                return closeAdd();
            }
            const fd = new FormData();
            if (ctx.file) fd.append('torrent', ctx.file);
            else fd.append('magnet', lines[0]);
            const r = await api('/api/torrents', { method: 'POST', body: fd });
            ctx.id = r.id;
            if (r.duplicate) {
                const t = state.torrents.find(x => x.id === r.id);
                if (!t || t.status !== 'pending') { toast(tr('duplicate')); ctx.keep = true; return closeAdd(); }
            }
            showStep('wait');
            waitForMetadata();
        } catch (err) {
            $('#dlSourceErr').textContent = err.message;
            $('#dlSourceErr').hidden = false;
            $('#dlNext').disabled = false;
        }
    }

    async function waitForMetadata() {
        const myCtx = ctx;
        const started = Date.now();
        while (myCtx && !myCtx.stopped) {
            try {
                const d = await api('/api/torrents/' + myCtx.id);
                if (d.status !== 'metadata') {
                    if (d.status === 'pending') return loadPreview(d);
                    toast(tr('already_started'));
                    myCtx.keep = true;
                    return closeAdd();
                }
                const secs = Math.round((Date.now() - started) / 1000);
                $('#dlWaitInfo').textContent = tr('waiting_peers', { n: d.peers, s: secs }) + (secs > 25 ? ' — ' + tr('slow_metadata') : '');
                $('#dlFooterInfo').innerHTML = secs > 8 ? `<button type="button" class="nf-btn nf-btn-sm" id="dlKeep">${esc(tr('keep_in_background'))}</button>` : '';
                const keep = $('#dlKeep');
                if (keep) keep.onclick = () => { myCtx.keep = true; toast(tr('kept_in_background')); closeAdd(); };
            } catch (err) {
                $('#dlWaitInfo').textContent = err.message;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    async function loadPreview(d) {
        if (!ctx) return;
        ctx.d = d;
        let s;
        try { s = await api(`/api/torrents/${d.id}/suggest`); } catch { s = { kind: d.kind, results: [], defaultFiles: [], parsed: {} }; }
        if (!ctx) return;
        ctx.kind = s.kind === 'auto' ? 'movie' : s.kind;
        ctx.results = s.results || [];
        ctx.match = ctx.results[0] || null;
        ctx.tmdbOn = s.tmdbOn;
        ctx.parsed = s.parsed || {};
        ctx.query = s.query || '';
        ctx.selected = new Set(s.defaultFiles && s.defaultFiles.length ? s.defaultFiles : d.files.map(f => f.index));
        showStep('preview');
        renderPreview();
    }

    function renderPreview() {
        const d = ctx.d;
        $('#dlName').textContent = d.name;
        const vids = d.files.filter(f => f.video && !f.sample).length;
        const subs = d.files.filter(f => f.subtitle).length;
        $('#dlMeta').innerHTML = `<span><b>${fmtBytes(d.totalSize)}</b></span><span>${esc(tr('files_count', { n: d.files.length }))}</span>`
            + (vids ? `<span>${esc(tr('videos_count', { n: vids }))}</span>` : '') + (subs ? `<span>${esc(tr('subs_count', { n: subs }))}</span>` : '')
            + `<span>${esc(peersText(d.peers))}</span>`;
        $$('#dlKinds button').forEach(b => b.classList.toggle('on', b.dataset.kind === ctx.kind));
        const files = [...d.files].sort((a, b) => (b.video - a.video) || (b.subtitle - a.subtitle) || a.path.localeCompare(b.path, undefined, { numeric: true }));
        $('#dlFiles').innerHTML = files.map(f => `
            <label class="dl-fileopt">
                <input type="checkbox" data-file="${f.index}" ${ctx.selected.has(f.index) ? 'checked' : ''}>
                <span class="fname" title="${esc(f.path)}"><i class="fa-solid ${fileIcon(f.name)}"></i>${esc(f.name)}${f.sample ? `<em>${esc(tr('sample'))}</em>` : ''}</span>
                <span class="size">${fmtBytes(f.length)}</span>
                ${f.video ? `<button type="button" data-preview="${f.index}" title="${esc(tr('preview'))}"><i class="fa-solid fa-play"></i></button>` : '<span></span>'}
            </label>`).join('');
        $('#dlAutoImport').checked = ctx.kind !== 'other';
        $('#dlAutoImport').disabled = ctx.kind === 'other';
        renderMatch();
        updateFooter();
    }

    function renderMatch() {
        const box = $('#dlMatch');
        if (ctx.kind === 'other') { box.innerHTML = `<div class="dl-match-card"><div class="ph"><i class="fa-regular fa-folder"></i></div><div><b>${esc(tr('kind_other'))}</b><p>${esc(tr('other_hint'))}</p></div></div>`; return; }
        const m = ctx.match;
        const card = m
            ? `<div class="dl-match-card">${m.poster ? `<img src="${esc(m.poster)}" alt="">` : '<div class="ph"><i class="fa-solid fa-film"></i></div>'}<div><small>${esc(tr('matched_as'))}</small><b>${esc(m.title)}${m.year ? ` (${m.year})` : ''}</b><small>${esc(m.type === 'series' ? tr('kind_series') : tr('kind_movie'))}${m.rating ? ` · ★ ${m.rating.toFixed(1)}` : ''}</small><p>${esc(m.overview)}</p></div></div>`
            : `<div class="dl-match-card"><div class="ph"><i class="fa-solid fa-film"></i></div><div><small>${esc(tr('will_appear_as'))}</small><b>${esc(ctx.parsed.title || ctx.d.name)}${ctx.parsed.year ? ` (${ctx.parsed.year})` : ''}</b><p>${esc(ctx.tmdbOn ? tr('no_match_hint') : tr('tmdb_off_hint'))}</p></div></div>`;
        const search = ctx.tmdbOn ? `
            <div class="dl-match-search">
                <input class="dl-input" id="dlMatchQ" placeholder="${esc(tr('search_tmdb'))}" value="${esc(ctx.query)}">
                <div class="dl-results" id="dlResults">${resultsHtml()}</div>
                ${m ? `<button type="button" class="dl-nomatch" id="dlNoMatch"><i class="fa-solid fa-ban"></i> ${esc(tr('dont_match'))}</button>` : ''}
            </div>` : '';
        box.innerHTML = card + search;
        const q = $('#dlMatchQ');
        if (q) {
            let deb;
            q.addEventListener('input', () => {
                clearTimeout(deb);
                deb = setTimeout(async () => {
                    ctx.query = q.value.trim();
                    if (!ctx.query) return;
                    try {
                        const s = await api(`/api/torrents/${ctx.d.id}/suggest?q=${encodeURIComponent(ctx.query)}&kind=${ctx.kind}`);
                        ctx.results = s.results || [];
                        $('#dlResults').innerHTML = resultsHtml();
                    } catch (err) { toast(err.message, true); }
                }, 350);
            });
        }
        const nm = $('#dlNoMatch');
        if (nm) nm.addEventListener('click', () => { ctx.match = null; renderMatch(); });
    }
    function resultsHtml() {
        return (ctx.results || []).map((r, i) => `
            <div class="dl-result${ctx.match && ctx.match.tmdbId === r.tmdbId && ctx.match.type === r.type ? ' on' : ''}" data-result="${i}">
                ${r.poster ? `<img src="${esc(r.poster)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
                <span><b>${esc(r.title)}</b><small>${r.year || ''} · ${esc(r.type === 'series' ? tr('kind_series') : tr('kind_movie'))}</small></span>
            </div>`).join('') || `<div class="dl-hint">${esc(tr('no_results'))}</div>`;
    }
    $('#dlMatch').addEventListener('click', (e) => {
        const r = e.target.closest('[data-result]');
        if (!r) return;
        ctx.match = ctx.results[Number(r.dataset.result)];
        if (ctx.match && ctx.match.type !== ctx.kind && ctx.kind !== 'other') {
            ctx.kind = ctx.match.type;
            $$('#dlKinds button').forEach(b => b.classList.toggle('on', b.dataset.kind === ctx.kind));
        }
        renderMatch();
    });
    $('#dlKinds').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-kind]');
        if (!b || !ctx || b.dataset.kind === ctx.kind) return;
        ctx.kind = b.dataset.kind;
        $$('#dlKinds button').forEach(x => x.classList.toggle('on', x === b));
        $('#dlAutoImport').checked = ctx.kind !== 'other';
        $('#dlAutoImport').disabled = ctx.kind === 'other';
        if (ctx.kind !== 'other' && ctx.tmdbOn) {
            try {
                const s = await api(`/api/torrents/${ctx.d.id}/suggest?kind=${ctx.kind}${ctx.query ? '&q=' + encodeURIComponent(ctx.query) : ''}`);
                ctx.results = s.results || [];
                ctx.match = ctx.results[0] || null;
            } catch { /* ignore */ }
        }
        renderMatch();
    });
    $('#dlFiles').addEventListener('change', (e) => {
        const cb = e.target.closest('[data-file]');
        if (!cb) return;
        const i = Number(cb.dataset.file);
        if (cb.checked) ctx.selected.add(i); else ctx.selected.delete(i);
        updateFooter();
    });
    $('#dlFiles').addEventListener('click', (e) => {
        const p = e.target.closest('[data-preview]');
        if (!p) return;
        e.preventDefault();
        ctx.keep = true; // keep the pending torrent while previewing
        location.href = `/watch/t/${ctx.d.id}/${p.dataset.preview}`;
    });
    function updateFooter() {
        const size = ctx.d.files.filter(f => ctx.selected.has(f.index)).reduce((a, f) => a + f.length, 0);
        $('#dlFooterInfo').textContent = tr('selected_size', { n: ctx.selected.size, size: fmtBytes(size) });
        $('#dlNext').disabled = ctx.selected.size === 0;
        $('#dlStream').disabled = !ctx.d.files.some(f => f.video && ctx.selected.has(f.index));
    }

    async function startDownload() {
        const body = {
            files: [...ctx.selected],
            kind: ctx.kind,
            autoImport: ctx.kind !== 'other' && $('#dlAutoImport').checked,
            match: ctx.match ? { tmdbId: ctx.match.tmdbId, type: ctx.match.type, title: ctx.match.title, year: ctx.match.year, poster: ctx.match.poster } : null
        };
        return api(`/api/torrents/${ctx.d.id}/start`, { method: 'POST', body: JSON.stringify(body) });
    }

    $('#dlNext').addEventListener('click', async () => {
        if (!ctx) return;
        if (ctx.step === 'source') return submitSource();
        if (ctx.step === 'preview') {
            $('#dlNext').disabled = true;
            try {
                await startDownload();
                ctx.keep = true;
                toast(tr('started'));
                closeAdd();
            } catch (err) {
                $('#dlStartErr').textContent = err.message;
                $('#dlStartErr').hidden = false;
                $('#dlNext').disabled = false;
            }
        }
    });
    $('#dlStream').addEventListener('click', async () => {
        if (!ctx || ctx.step !== 'preview') return;
        $('#dlStream').disabled = true;
        try {
            const vids = ctx.d.files.filter(f => f.video && ctx.selected.has(f.index));
            const main = vids.reduce((a, b) => (b.length > a.length ? b : a), vids[0]);
            const d = await startDownload();
            ctx.keep = true;
            const m = (d.media || []).find(x => x.fileIndex === main.index);
            location.href = m ? '/watch/' + m.id : `/watch/t/${d.id}/${main.index}`;
        } catch (err) {
            $('#dlStartErr').textContent = err.message;
            $('#dlStartErr').hidden = false;
            $('#dlStream').disabled = false;
        }
    });
    $('#dlMagnet').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitSource(); } });

    // ------------------------------------------------------------ drag & drop / paste / magnet links
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { dragDepth++; document.body.classList.add('dl-dragging'); } });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dl-dragging'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        document.body.classList.remove('dl-dragging');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f && /\.torrent$/i.test(f.name)) openAdd({ file: f, auto: true });
        else {
            const text = e.dataTransfer && e.dataTransfer.getData('text');
            if (text && /^magnet:/i.test(text.trim())) openAdd({ magnet: text.trim(), auto: true });
        }
    });
    document.addEventListener('paste', (e) => {
        if (!modal.hidden || (e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) return;
        const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
        if (/^magnet:\?/i.test(text.trim())) openAdd({ magnet: text.trim(), auto: true });
    });
    $('#dlProtocol').addEventListener('click', () => {
        try {
            navigator.registerProtocolHandler('magnet', `${location.origin}/downloads?magnet=%s`);
            toast(tr('protocol_registered'));
        } catch (err) {
            toast(tr('protocol_failed'), true);
        }
    });

    connect();
    // A magnet link opened from another page only fills in the dialog: adding it takes a click.
    if (D.initialMagnet) {
        history.replaceState(null, '', '/downloads');
        openAdd({ magnet: D.initialMagnet });
    }
})();
