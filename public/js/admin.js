/* MEDIATER — admin pages */
(() => {
    'use strict';
    const A = window.__adm || {};
    const L = A.i18n || {};
    const tr = (k, vars) => {
        let s = L[k] != null ? String(L[k]) : k;
        if (vars) for (const [a, b] of Object.entries(vars)) s = s.split('{' + a + '}').join(b);
        return s;
    };
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ------------------------------------------------------------ tabs
    const main = $('.adm-main[data-tab]');
    function showTab(name) {
        if (!$('#tab-' + name)) name = 'library';
        $$('.adm-panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
        $$('[data-tab]').forEach(b => { if (b !== main) b.classList.toggle('on', b.dataset.tab === name); });
        const u = new URL(location.href);
        u.searchParams.set('tab', name);
        u.searchParams.delete('flash');
        history.replaceState(null, '', u);
    }
    if (main) {
        showTab(main.dataset.tab || 'library');
        $$('button[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    }

    // ------------------------------------------------------------ library filter
    const grid = $('#libGrid');
    if (grid) {
        let type = '';
        const apply = () => {
            const q = ($('#libFilter').value || '').toLowerCase().trim();
            $$('.adm-title', grid).forEach(el => {
                el.hidden = (type && el.dataset.type !== type) || (q && !el.dataset.q.includes(q));
            });
        };
        $('#libFilter').addEventListener('input', apply);
        $('#libType').addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            type = b.dataset.type;
            $$('#libType button').forEach(x => x.classList.toggle('on', x === b));
            apply();
        });
    }

    // ------------------------------------------------------------ TMDB search (quick add / identify)
    const qa = $('#qaQuery');
    if (qa) {
        const box = $('#qaResults');
        let deb, seq = 0;
        const search = async () => {
            const q = qa.value.trim();
            if (q.length < 2) { box.innerHTML = ''; return; }
            const my = ++seq;
            box.innerHTML = `<div style="color:#8c8c8c">${esc(tr('searching'))}</div>`;
            try {
                const type = $('#qaType') ? $('#qaType').value : '';
                const r = await fetch(`/admin/api/tmdb/search?q=${encodeURIComponent(q)}${type ? '&type=' + type : ''}`, { credentials: 'same-origin' });
                const j = await r.json();
                if (my !== seq) return;
                if (!r.ok) throw new Error(j.error || 'TMDB error');
                box.innerHTML = (j.results || []).map(x => `
                    <button type="button" class="r" data-tmdb="${x.tmdbId}" data-type="${x.type}">
                        ${x.poster ? `<img src="${esc(x.poster)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
                        <span><b>${esc(x.title)}</b><br><small>${x.year || ''} · ${esc(x.type === 'series' ? tr('series') : tr('movie'))}</small></span>
                    </button>`).join('') || `<div style="color:#8c8c8c">${esc(tr('no_results'))}</div>`;
            } catch (e) {
                box.innerHTML = `<div class="nf-alert err">${esc(e.message)}</div>`;
            }
        };
        qa.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(search, 350); });
        qa.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(deb); search(); } });
        if ($('#qaGo')) $('#qaGo').addEventListener('click', search);
        if ($('#qaType')) $('#qaType').addEventListener('change', search);
        box.addEventListener('click', (e) => {
            const b = e.target.closest('[data-tmdb]');
            if (!b) return;
            if (box.dataset.mode === 'apply') {
                if (!confirm(tr('apply_confirm'))) return;
                const f = $('#qaApply');
                f.tmdbId.value = b.dataset.tmdb;
                f.tmdbType.value = b.dataset.type;
                f.submit();
            } else {
                location.href = `/admin/title/new?type=${b.dataset.type}&tmdb=${b.dataset.tmdb}`;
            }
        });
        if (box.dataset.mode === 'apply' && qa.value.trim()) search();
    }

    // ------------------------------------------------------------ users
    const form = $('#userForm');
    if (form) {
        const reset = () => {
            form.action = '/admin/user/add';
            form.reset();
            $('#editUserId').value = '';
            $('#userFormTitle').textContent = tr('create_new_user');
            $('#editPassword').required = true;
            $('#editPassword').placeholder = tr('password_enter');
            $('#passHint').textContent = '';
            $('#userSubmitBtn').innerHTML = `<i class="fa-solid fa-plus"></i> ${esc(tr('create_user'))}`;
            $('#userCancelBtn').hidden = true;
        };
        $$('[data-edit-user]').forEach(b => b.addEventListener('click', () => {
            const u = JSON.parse(b.dataset.editUser);
            form.action = '/admin/user/edit';
            $('#editUserId').value = u.id;
            $('#editUsername').value = u.username;
            $('#editRole').value = u.role;
            $('#editPassword').value = '';
            $('#editPassword').required = false;
            $('#editPassword').placeholder = tr('password_keep');
            $('#passHint').textContent = tr('password_optional');
            $('#userFormTitle').textContent = `${tr('edit_user')}: ${u.username}`;
            $('#userSubmitBtn').innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${esc(tr('update_user'))}`;
            $('#userCancelBtn').hidden = false;
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }));
        $('#userCancelBtn').addEventListener('click', reset);
    }

    // ------------------------------------------------------------ uploads: previews and file names
    $$('input[type=file][data-preview]').forEach(inp => inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        const pv = inp.closest('.pv');
        if (!f || !pv) return;
        const r = new FileReader();
        r.onload = (e) => { pv.style.backgroundImage = `url("${e.target.result}")`; pv.classList.add('has'); };
        r.readAsDataURL(f);
    }));
    $$('input[data-url-preview]').forEach(inp => inp.addEventListener('change', () => {
        const pv = inp.parentElement.querySelector('.pv');
        if (!pv) return;
        const v = inp.value.trim();
        pv.style.backgroundImage = v ? `url("${v.replace(/"/g, '%22')}")` : '';
        pv.classList.toggle('has', !!v);
    }));
    $$('.adm-dropfile input[type=file]').forEach(inp => inp.addEventListener('change', () => {
        const b = inp.parentElement.querySelector('[data-name]');
        if (b) b.textContent = inp.files && inp.files[0] ? inp.files[0].name : '';
    }));

    // big video uploads: show progress instead of a frozen page
    const tf = $('#titleForm');
    if (tf) tf.addEventListener('submit', (e) => {
        const vid = tf.querySelector('input[name=video]');
        const trailer = tf.querySelector('input[name=trailerFile]');
        const big = [vid, trailer].some(i => i && i.files && i.files[0] && i.files[0].size > 20 * 1024 * 1024);
        if (!big || !window.XMLHttpRequest) return;
        e.preventDefault();
        const btn = tf.querySelector('button[type=submit]');
        const xhr = new XMLHttpRequest();
        xhr.open('POST', tf.action);
        xhr.upload.onprogress = (ev) => {
            if (ev.lengthComputable) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${esc(tr('uploading'))} ${Math.round(ev.loaded / ev.total * 100)}%`;
        };
        xhr.onload = () => { location.href = xhr.responseURL || location.href; };
        xhr.onerror = () => { btn.disabled = false; alert(tr('upload_failed')); };
        btn.disabled = true;
        xhr.send(new FormData(tf));
    });
})();
