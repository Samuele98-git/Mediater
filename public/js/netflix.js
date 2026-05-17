// Netflix-style interactions: nav scroll, search, slider arrows, detail modal, my-list toggle

(function () {
    const nav = document.querySelector('.nf-nav');
    if (nav) {
        const onScroll = () => {
            if (window.scrollY > 20) nav.classList.add('scrolled');
            else nav.classList.remove('scrolled');
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
    }

    // Profile dropdown
    document.querySelectorAll('.nf-profile').forEach(p => {
        p.addEventListener('click', e => {
            e.stopPropagation();
            p.classList.toggle('open');
        });
    });
    document.addEventListener('click', () => {
        document.querySelectorAll('.nf-profile.open').forEach(p => p.classList.remove('open'));
    });

    // Search toggle
    const search = document.querySelector('.nf-search');
    if (search) {
        const input = search.querySelector('input');
        const toggle = search.querySelector('.nf-search-toggle');
        toggle.addEventListener('click', e => {
            e.preventDefault();
            search.classList.toggle('open');
            if (search.classList.contains('open')) setTimeout(() => input.focus(), 50);
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const q = input.value.trim();
                if (q) window.location.href = '/search?q=' + encodeURIComponent(q);
            }
            if (e.key === 'Escape') {
                search.classList.remove('open');
                input.value = '';
            }
        });
    }

    // Slider arrows
    document.querySelectorAll('.nf-slider-wrap').forEach(wrap => {
        const slider = wrap.querySelector('.nf-slider');
        const left = wrap.querySelector('.nf-arrow.left');
        const right = wrap.querySelector('.nf-arrow.right');
        const scrollBy = () => Math.max(slider.clientWidth * 0.85, 300);
        if (left) left.addEventListener('click', () => slider.scrollBy({ left: -scrollBy(), behavior: 'smooth' }));
        if (right) right.addEventListener('click', () => slider.scrollBy({ left: scrollBy(), behavior: 'smooth' }));
    });

    // Detail modal
    const modal = document.getElementById('nfModal');
    const modalBody = document.getElementById('nfModalBody');
    function closeModal() {
        if (!modal) return;
        modal.classList.remove('show');
        modalBody.innerHTML = '';
        document.body.style.overflow = '';
    }
    function openModal(id) {
        if (!modal) return;
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
        modalBody.innerHTML = '<div style="padding:80px;text-align:center;color:#888;">Loading…</div>';
        fetch('/api/details/' + id).then(r => r.json()).then(data => {
            renderModal(data);
        }).catch(() => { modalBody.innerHTML = '<div style="padding:40px;color:#888;">Failed to load.</div>'; });
    }
    function fmtDur(seconds) {
        if (!seconds || !Number.isFinite(+seconds)) return '';
        const s = parseInt(seconds);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }
    function renderModal({ media, episodes, inMyList, progress }) {
        if (!media) return;
        const backdrop = media.backdrop || media.thumbnail || '';
        const year = media.releaseYear || '';
        const dur = media.duration ? fmtDur(media.duration * 60) : '';
        const maturity = media.maturity || '';
        const playLabel = (progress && progress.position > 5) ? 'Resume' : 'Play';
        const watchTarget = (media.type === 'series' && episodes.length > 0) ? episodes[0].id : media.id;

        const episodeHtml = (media.type === 'series' && episodes.length > 0) ? `
            <h3>Episodes</h3>
            <div class="nf-modal-episodes">
                ${episodes.map(ep => `
                    <div class="nf-modal-ep" onclick="window.location.href='/watch/${ep.id}'">
                        <div class="num">${ep.order || ''}</div>
                        <div class="thumb" style="background-image:url('${ep.thumbnail || media.backdrop || media.thumbnail || ''}')">
                            <div class="play-ov"><i class="fas fa-play"></i></div>
                        </div>
                        <div class="info">
                            <div class="ep-title">${escapeHtml(ep.title || ('Episode ' + ep.order))}</div>
                            <div class="ep-desc">${escapeHtml(ep.description || '')}</div>
                            ${ep.duration ? `<div class="ep-dur">${fmtDur(ep.duration * 60)}</div>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        ` : '';

        modalBody.innerHTML = `
            <div class="nf-modal-hero" style="background-image:url('${backdrop}')">
                <button class="nf-modal-close" onclick="window.__nfCloseModal()"><i class="fas fa-times"></i></button>
            </div>
            <div class="nf-modal-content">
                <div class="actions">
                    <a class="nf-btn nf-btn-play" href="/watch/${watchTarget}"><i class="fas fa-play"></i> ${playLabel}</a>
                    <button class="nf-btn nf-btn-icon" title="${inMyList ? 'Remove from My List' : 'Add to My List'}" onclick="window.__nfToggleList(${media.id}, this)">
                        <i class="fas ${inMyList ? 'fa-check' : 'fa-plus'}"></i>
                    </button>
                </div>
                <div class="nf-modal-grid">
                    <div>
                        <div class="nf-modal-meta">
                            <div class="row1">
                                ${maturity ? `<span class="badge">${escapeHtml(maturity)}</span>` : ''}
                                ${year ? `<span>${year}</span>` : ''}
                                ${dur ? `<span>${dur}</span>` : ''}
                                <span class="match">98% Match</span>
                            </div>
                        </div>
                        <p class="nf-modal-desc">${escapeHtml(media.description || 'No description available.')}</p>
                    </div>
                    <div class="nf-modal-side">
                        ${media.category ? `<div><span class="k">Category:</span> ${escapeHtml(media.category)}</div>` : ''}
                        ${media.genres ? `<div style="margin-top:6px;"><span class="k">Genres:</span> ${escapeHtml(media.genres)}</div>` : ''}
                        <div style="margin-top:6px;"><span class="k">Type:</span> ${escapeHtml(media.type)}</div>
                    </div>
                </div>
                ${episodeHtml}
            </div>
        `;
    }
    if (modal) {
        modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    }
    window.__nfCloseModal = closeModal;
    window.__nfOpenModal = openModal;

    window.__nfToggleList = async function (id, btn) {
        try {
            const r = await fetch('/api/mylist/' + id, { method: 'POST' });
            const j = await r.json();
            if (btn) {
                const icon = btn.querySelector('i');
                icon.className = 'fas ' + (j.inList ? 'fa-check' : 'fa-plus');
                btn.title = j.inList ? 'Remove from My List' : 'Add to My List';
            }
        } catch (e) {}
    };

    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    // Click → open modal for cards with data-id
    document.addEventListener('click', e => {
        const card = e.target.closest('.nf-card[data-id]');
        if (card && !e.target.closest('.nf-card-play')) {
            const id = card.dataset.id;
            if (id) {
                e.preventDefault();
                openModal(id);
            }
        }
    });
})();
