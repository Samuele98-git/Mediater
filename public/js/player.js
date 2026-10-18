/* MEDIATER — Netflix-style player: direct play with automatic ffmpeg fallback,
   custom subtitles, audio tracks, skip intro, next-episode countdown, scrub thumbnails. */
(() => {
    'use strict';
    const C = window.__nfp;
    const L = C.i18n || {};
    const tr = (k, vars) => {
        let s = L[k] != null ? String(L[k]) : k;
        if (vars) for (const [a, b] of Object.entries(vars)) s = s.split('{' + a + '}').join(b);
        return s;
    };
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const store = {
        get(k, d) { try { const v = localStorage.getItem('nf.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
        set(k, v) { try { localStorage.setItem('nf.' + k, JSON.stringify(v)); } catch { /* private mode */ } }
    };
    const root = $('nfp'), video = $('nfpVideo');
    const bar = $('nfpBar'), fill = $('nfpFill'), knob = $('nfpKnob'), bufferEl = $('nfpBuffer'), hoverFill = $('nfpHoverFill');
    const remaining = $('nfpRemaining'), spinner = $('nfpSpinner'), subsEl = $('nfpSubs');
    const skipBtn = $('nfpSkip'), postplay = $('nfpPostplay'), idleEl = $('nfpIdle');
    const isTouch = matchMedia('(pointer: coarse)').matches;
    const M = C.markers || {};

    let info = null, mode = 'direct', offset = 0, audioIndex = null, forced = null;
    let subCues = [], subTrack = null, lastSubHtml = '';
    let dragging = false, hideTimer = null, idleTimer = null, spinTimer = null;
    let nextDismissed = false, countdownTimer = null, countdownLeft = 0, lastSaved = 0;
    let fallbackStage = 0, audioCheckTimer = null, started = false;
    let seekSeq = 0, pendingSeek = null;

    // ------------------------------------------------------------ capabilities
    function caps() {
        const v = document.createElement('video');
        const ms = window.MediaSource;
        const can = (t) => {
            try { return !!((ms && ms.isTypeSupported && ms.isTypeSupported(t)) || v.canPlayType(t) === 'probably'); } catch { return false; }
        };
        const out = ['h264'];
        if (can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"')) out.push('hevc');
        if (can('video/webm; codecs="vp9"') || can('video/webm; codecs="vp09.00.10.08"')) out.push('vp9');
        if (can('video/webm; codecs="vp8"')) out.push('vp8');
        if (can('video/mp4; codecs="av01.0.08M.08"')) out.push('av1');
        if (can('audio/mp4; codecs="mp4a.40.2"') || v.canPlayType('audio/mp4')) out.push('aac');
        if (v.canPlayType('audio/mpeg')) out.push('mp3');
        if (can('audio/webm; codecs="opus"') || can('audio/ogg; codecs="opus"')) out.push('opus');
        if (can('audio/webm; codecs="vorbis"') || can('audio/ogg; codecs="vorbis"')) out.push('vorbis');
        if (can('audio/flac') || can('audio/mp4; codecs="flac"')) out.push('flac');
        if (can('audio/mp4; codecs="ac-3"')) out.push('ac3');
        if (can('audio/mp4; codecs="ec-3"')) out.push('eac3');
        if (v.canPlayType('video/webm')) out.push('webm');
        const ua = navigator.userAgent;
        // Desktop Chromium plays Matroska through its WebM demuxer.
        if (/(Chrome|Chromium|Edg)\//.test(ua) && !/Android|Mobile/.test(ua)) out.push('mkv');
        return out.join(',');
    }
    const CAPS = caps();

    // ------------------------------------------------------------ helpers
    const fmt = (s) => {
        s = Math.max(0, Math.floor(s || 0));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
    };
    const realTime = () => (pendingSeek != null ? pendingSeek : offset + (video.currentTime || 0));
    const duration = () => (info && info.duration) || (Number.isFinite(video.duration) ? video.duration : 0);
    function showSpinner(on, text) {
        clearTimeout(spinTimer);
        $('nfpSpinnerText').textContent = text || '';
        if (on) spinTimer = setTimeout(() => spinner.classList.add('on'), text ? 0 : 250);
        else spinner.classList.remove('on');
    }
    function flash(icon) {
        const f = $('nfpFlash');
        f.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    }
    function seekFlash(el) { el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); }
    function showError(msg, code) {
        showSpinner(false);
        $('nfpErrorText').textContent = msg || tr('error_generic');
        $('nfpErrorCode').textContent = code || '';
        $('nfpError').hidden = false;
        root.classList.remove('idle', 'hide-cursor');
    }

    // ------------------------------------------------------------ source handling
    async function loadInfo() {
        const q = new URLSearchParams({ caps: CAPS });
        if (audioIndex != null) q.set('audio', audioIndex);
        if (forced) q.set('force', forced);
        const r = await fetch(`/api/playback/${C.source}?${q}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || tr('error_generic'));
        return j;
    }

    async function begin(at, { text } = {}) {
        $('nfpError').hidden = true;
        showSpinner(true, text || (C.source.startsWith('t/') || isTorrentMedia ? tr('connecting_peers') : ''));
        try {
            info = await loadInfo();
        } catch (e) {
            return showError(e.message);
        }
        mode = info.mode;
        audioIndex = info.audioIndex;
        if (info.warning === 'ffmpeg-missing' && !started) console.warn('Server has no ffmpeg: this file may not play in the browser.');
        if (info.torrent) isTorrentMedia = true;
        buildAudioMenu();
        buildSubMenu();
        drawMarkers();
        if (!started) autoSelectSubs();
        setSource(at);
        started = true;
        updateUI();
    }

    function setSource(at) {
        at = Math.max(0, at || 0);
        clearTimeout(audioCheckTimer);
        if (mode === 'direct') {
            seekSeq++;
            pendingSeek = null;
            offset = 0;
            video.src = info.url;
            if (at > 0.5) {
                video.addEventListener('loadedmetadata', () => { try { video.currentTime = at; } catch { /* ignore */ } }, { once: true });
            }
            play();
        } else {
            startAt(at);
        }
    }

    // Converted streams restart ffmpeg at the new position. A stream copy (remux)
    // can only start on a keyframe, so ask the server where that is and count the
    // clock from there: subtitles, the seek bar and saved progress stay exact.
    async function startAt(t) {
        const my = ++seekSeq;
        let at = t, from = t;
        pendingSeek = t;
        if (mode === 'remux' && t > 1) {
            try {
                const r = await fetch(`/api/playback/${C.source}/keyframe?t=${t.toFixed(3)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
                const j = await r.json();
                if (r.ok && Number.isFinite(j.start) && Number.isFinite(j.from) && j.start >= 0 && j.start <= t + 0.05) { at = j.start; from = j.from; }
            } catch { /* fall back to t */ }
            if (my !== seekSeq) return; // a newer seek won
        }
        offset = at;
        pendingSeek = null;
        video.src = info.url + from.toFixed(3);
        play();
    }

    function play() {
        const p = video.play();
        if (p && p.catch) p.catch((err) => {
            if (err && err.name === 'NotAllowedError') showBigPlay();
        });
    }
    function showBigPlay() {
        if (document.querySelector('.nfp-bigplay')) return;
        showSpinner(false);
        const b = document.createElement('button');
        b.className = 'nfp-bigplay';
        b.type = 'button';
        b.innerHTML = '<span><i class="fa-solid fa-play"></i></span>';
        b.addEventListener('click', () => { b.remove(); phoneFullscreen(); play(); });
        root.appendChild(b);
    }

    function inBuffered(local) {
        const b = video.buffered;
        for (let i = 0; i < b.length; i++) if (local >= b.start(i) && local <= b.end(i) - 0.5) return true;
        return false;
    }

    function seek(t) {
        const d = duration();
        t = Math.max(0, d ? Math.min(t, d - 0.25) : t);
        if (mode === 'direct') {
            video.currentTime = t;
        } else {
            const local = t - offset;
            if (pendingSeek == null && local >= 0 && inBuffered(local)) video.currentTime = local;
            else {
                showSpinner(true);
                startAt(t);
            }
        }
        lastSubHtml = null;
        updateUI();
    }
    const skip = (s) => { seek(realTime() + s); seekFlash(s < 0 ? $('nfpSeekBack') : $('nfpSeekFwd')); };

    // Automatic fallback when the browser can't play the original file.
    async function fallback(reason) {
        const at = realTime();
        if (fallbackStage === 0 && mode === 'direct') { fallbackStage = 1; forced = 'remux'; return begin(at, { text: tr('optimizing') }); }
        if (fallbackStage <= 1 && mode !== 'transcode') { fallbackStage = 2; forced = 'transcode'; return begin(at, { text: tr('optimizing') }); }
        showError(tr('error_unsupported'), reason);
    }

    video.addEventListener('error', () => {
        const err = video.error;
        if (!err || !video.currentSrc) return;
        if (err.code === 1) return; // aborted by us
        fallback(`MEDIA_ERR ${err.code}${err.message ? ': ' + err.message : ''}`);
    });
    video.addEventListener('loadeddata', () => {
        if (mode === 'direct' && info && info.video && video.videoWidth === 0) fallback('no video frames');
    });
    video.addEventListener('playing', () => {
        showSpinner(false);
        // Chrome silently drops audio it can't decode (AC3/DTS in MKV): detect and fix.
        if (mode === 'direct' && info && info.audioTracks.length && 'webkitAudioDecodedByteCount' in video) {
            clearTimeout(audioCheckTimer);
            audioCheckTimer = setTimeout(() => {
                if (!video.paused && video.webkitAudioDecodedByteCount === 0 && !video.muted && video.volume > 0) fallback('no audio');
            }, 4000);
        }
    });
    video.addEventListener('waiting', () => showSpinner(true, isTorrentMedia ? tr('buffering_torrent') : ''));
    video.addEventListener('canplay', () => showSpinner(false));
    video.addEventListener('seeking', () => showSpinner(true));
    video.addEventListener('seeked', () => showSpinner(false));

    // ------------------------------------------------------------ UI updates
    function updateUI() {
        const d = duration(), t = realTime();
        const pct = d ? Math.min(100, (t / d) * 100) : 0;
        if (!dragging) { fill.style.width = pct + '%'; knob.style.left = pct + '%'; }
        remaining.textContent = d ? fmt(d - t) : fmt(t);
        let bEnd = 0;
        const b = video.buffered;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 1 && b.end(i) > bEnd) bEnd = b.end(i);
        if (d) {
            const start = mode === 'direct' ? 0 : offset;
            bufferEl.style.left = (start / d * 100) + '%';
            bufferEl.style.width = Math.max(0, Math.min(100, ((mode === 'direct' ? bEnd : offset + bEnd) - start) / d * 100)) + '%';
        }
        updateSkip(t);
        updateNext(t, d);
        renderSubs(t);
        saveProgress(t, d, false);
        if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && d) {
            try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(t, d), playbackRate: video.playbackRate || 1 }); } catch { /* ignore */ }
        }
    }
    let raf = 0;
    const loop = () => { updateUI(); raf = video.paused ? 0 : requestAnimationFrame(loop); };
    const setPlayIcons = (icon) => { $('nfpPlay').innerHTML = $('nfpCPlay').innerHTML = `<i class="fa-solid ${icon}"></i>`; };
    video.addEventListener('play', () => { setPlayIcons('fa-pause'); if (!raf) raf = requestAnimationFrame(loop); hideIdle(); activity(); });
    video.addEventListener('pause', () => {
        setPlayIcons('fa-play');
        if (!root.classList.contains('locked')) root.classList.remove('idle', 'hide-cursor');
        saveProgress(realTime(), duration(), true);
        armPauseScreen();
    });
    video.addEventListener('timeupdate', () => { if (!raf) updateUI(); });
    video.addEventListener('progress', () => { if (video.paused) updateUI(); });
    video.addEventListener('ended', onEnded);
    function hideIdle() { clearTimeout(idleTimer); idleEl.classList.remove('on'); }
    // Something covers the picture (error, end screen, "still watching?", screen lock).
    const blockingOverlay = () => !$('nfpError').hidden || !!root.querySelector('.nfp-ended, .nfp-bigplay') ||
        (stillEl && !stillEl.hidden) || root.classList.contains('locked');
    // Like Netflix: while paused, "You're watching…" fades in once the mouse rests.
    function armPauseScreen() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (video.paused && !video.ended && started && !anyPanelOpen() && !blockingOverlay()) {
                idleEl.classList.add('on');
                root.classList.add('idle');
            }
        }, 7000);
    }

    function drawMarkers() {
        const d = duration();
        const box = $('nfpMarkers');
        box.innerHTML = '';
        if (!d) return;
        for (const t of [M.introEnd, M.creditsStart]) if (t > 0 && t < d) {
            const s = document.createElement('span');
            s.style.left = (t / d * 100) + '%';
            box.appendChild(s);
        }
    }

    // ------------------------------------------------------------ skip intro / next episode
    function updateSkip(t) {
        const show = M.introEnd != null && M.introEnd > 0 && t >= (M.introStart || 0) && t < M.introEnd - 1;
        if (skipBtn.hidden === show) skipBtn.hidden = !show;
    }
    skipBtn.addEventListener('click', () => seek(M.introEnd));

    function updateNext(t, d) {
        if (!C.nextEpisode || !d || nextDismissed) return;
        const from = M.creditsStart != null && M.creditsStart > 0 ? M.creditsStart : d - 25;
        const show = t >= from;
        if (show && postplay.hidden) {
            postplay.hidden = false;
            countdownLeft = 10;
            const fb = postplay.querySelector('.fillbar');
            fb.style.transition = 'none'; fb.style.width = '0';
            clearInterval(countdownTimer);
            countdownTimer = setInterval(() => {
                if (video.paused) return;
                countdownLeft -= 0.1;
                fb.style.width = Math.min(100, (10 - countdownLeft) * 10) + '%';
                if (countdownLeft <= 0) goNext(true);
            }, 100);
        } else if (!show && !postplay.hidden) {
            postplay.hidden = true;
            clearInterval(countdownTimer);
        }
    }
    /** Next episode. `auto` = started by the countdown or the end of the episode, not by the viewer. */
    function goNext(auto) {
        clearInterval(countdownTimer);
        if (!C.nextEpisode) return;
        if (auto === true) {
            const n = autoCount() + 1;
            if (n >= AUTO_LIMIT) return askStillWatching();
            store.set('autoNext', { n, at: Date.now() });
        } else {
            store.set('autoNext', { n: 0, at: Date.now() });
        }
        saveProgress(duration(), duration(), true);
        location.href = '/watch/' + C.nextEpisode.id;
    }
    $('nfpNextBtn') && $('nfpNextBtn').addEventListener('click', () => goNext(false));
    $('nfpWatchCredits') && $('nfpWatchCredits').addEventListener('click', () => { nextDismissed = true; postplay.hidden = true; clearInterval(countdownTimer); });

    // ------------------------------------------------------------ are you still watching?
    // Like Netflix: after three episodes in a row that started on their own with
    // nobody touching the player, ask before playing more.
    const AUTO_LIMIT = 3;
    const stillEl = $('nfpStill');
    function autoCount() {
        const a = store.get('autoNext', null);
        return a && Date.now() - a.at < 4 * 3600 * 1000 ? (a.n || 0) : 0;
    }
    const viewerActed = () => { if (autoCount()) store.set('autoNext', { n: 0, at: Date.now() }); };
    root.addEventListener('pointerdown', viewerActed, true);
    document.addEventListener('keydown', viewerActed, true);
    function askStillWatching() {
        if (!stillEl) return;
        clearInterval(countdownTimer);
        postplay.hidden = true;
        hideIdle();
        video.pause();
        stillEl.hidden = false;
        root.classList.remove('idle', 'hide-cursor');
        setTimeout(() => $('nfpStillYes').focus(), 50);
    }
    if (stillEl) {
        $('nfpStillYes').addEventListener('click', () => {
            stillEl.hidden = true;
            goNext(false);
        });
    }

    function onEnded() {
        saveProgress(duration(), duration(), true);
        if (C.nextEpisode && !nextDismissed) return goNext(true);
        if (root.querySelector('.nfp-ended')) return;
        hideIdle();
        const recs = (C.similar || []).slice(0, 3);
        const box = document.createElement('div');
        box.className = 'nfp-ended';
        box.innerHTML = `
            <div class="nfp-ended-main">
                <h2>${esc(C.showTitle || C.title)}</h2>
                <div class="row">
                    <button class="nf-btn nf-btn-white" type="button" id="nfpAgain"><i class="fa-solid fa-rotate-left"></i> ${esc(tr('watch_again'))}</button>
                    <a class="nf-btn" href="${esc(C.backUrl)}">${esc(tr('back_to_browse'))}</a>
                </div>
            </div>
            ${recs.length ? `<div class="nfp-ended-more"><h3>${esc(tr('more_like_this'))}</h3><div class="nfp-recs">${recs.map(r => `
                <a class="nfp-rec" href="/watch/${Number(r.id)}">
                    <span class="art">${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy">` : ''}<span class="play"><i class="fa-solid fa-play"></i></span></span>
                    <b>${esc(r.title)}</b>
                    <small>${[r.year, r.maturity].filter(Boolean).map(esc).join(' · ')}</small>
                </a>`).join('')}</div></div>` : ''}`;
        root.appendChild(box);
        root.classList.remove('idle', 'hide-cursor');
        root.classList.add('ended');
        box.querySelector('#nfpAgain').addEventListener('click', () => { box.remove(); root.classList.remove('ended'); seek(0); play(); });
    }

    // ------------------------------------------------------------ progress saving
    function saveProgress(t, d, force) {
        if (!C.mediaId || C.preview || !d || t < 1) return;
        if (!force && (video.paused || Math.abs(t - lastSaved) < 10)) return;
        lastSaved = t;
        fetch('/api/progress', {
            method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mediaId: C.mediaId, position: t, duration: d })
        }).catch(() => {});
    }
    window.addEventListener('pagehide', () => {
        if (!C.mediaId || C.preview || !started || realTime() < 1) return;
        try {
            navigator.sendBeacon('/api/progress', new Blob([JSON.stringify({ mediaId: C.mediaId, position: realTime(), duration: duration() })], { type: 'application/json' }));
        } catch { /* ignore */ }
    });

    // ------------------------------------------------------------ seek bar
    const posToTime = (clientX) => {
        const r = bar.getBoundingClientRect();
        return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration();
    };
    function preview(clientX) {
        const d = duration();
        if (!d) return;
        const r = bar.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
        const t = p * d;
        const pv = $('nfpPreview');
        const thumb = $('nfpThumb');
        const half = (thumb.offsetWidth || 120) / 2 + 4;
        pv.style.left = Math.min(r.width - half, Math.max(half, p * r.width)) + 'px';
        $('nfpPreviewTime').textContent = fmt(t);
        hoverFill.style.width = (p * 100) + '%';
        const tp = info && info.trickplay;
        if (tp && tp.sprites && tp.sprites.length) {
            const idx = Math.min(Math.floor(t / tp.interval), Math.max(0, (tp.count || 1) - 1));
            const per = tp.cols * tp.rows;
            const sheet = Math.min(Math.floor(idx / per), tp.sprites.length - 1);
            const pos = idx % per;
            const w = thumb.clientWidth || tp.width, scale = w / tp.width, h = tp.height * scale;
            thumb.style.height = h + 'px';
            thumb.style.backgroundImage = `url("${tp.base}${tp.sprites[sheet]}")`;
            thumb.style.backgroundSize = `${tp.cols * tp.width * scale}px ${tp.rows * tp.height * scale}px`;
            thumb.style.backgroundPosition = `-${(pos % tp.cols) * tp.width * scale}px -${Math.floor(pos / tp.cols) * tp.height * scale}px`;
            thumb.classList.add('on');
        }
    }
    bar.addEventListener('pointerdown', (e) => {
        dragging = true;
        bar.setPointerCapture(e.pointerId);
        bar.classList.add('dragging');
        dragTo(e.clientX);
    });
    function dragTo(x) {
        const d = duration();
        if (!d) return;
        const p = posToTime(x) / d * 100;
        fill.style.width = p + '%';
        knob.style.left = p + '%';
        remaining.textContent = fmt(d - posToTime(x));
        preview(x);
    }
    bar.addEventListener('pointermove', (e) => { if (dragging) dragTo(e.clientX); else preview(e.clientX); });
    bar.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        bar.classList.remove('dragging');
        seek(posToTime(e.clientX));
    });
    bar.addEventListener('pointercancel', () => { dragging = false; bar.classList.remove('dragging'); });
    bar.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); skip(e.key === 'ArrowLeft' ? -10 : 10); }
    });

    // ------------------------------------------------------------ buttons
    const togglePlay = () => { if (video.paused) { play(); flash('fa-play'); } else { video.pause(); flash('fa-pause'); } };
    $('nfpPlay').addEventListener('click', togglePlay);
    // Phone layout: big centred controls. Starting playback with a tap goes full screen in
    // landscape like the Netflix app (where the browser allows it; iPhone Safari doesn't).
    function phoneFullscreen() {
        if (!isTouch || document.fullscreenElement || !root.requestFullscreen) return;
        root.requestFullscreen({ navigationUI: 'hide' })
            .then(() => { try { return screen.orientation.lock('landscape'); } catch { /* unsupported */ } })
            .catch(() => {});
    }
    $('nfpCPlay').addEventListener('click', (e) => { e.stopPropagation(); if (video.paused) phoneFullscreen(); togglePlay(); activity(); });
    $('nfpCBack').addEventListener('click', (e) => { e.stopPropagation(); skip(-10); activity(); });
    $('nfpCFwd').addEventListener('click', (e) => { e.stopPropagation(); skip(10); activity(); });
    $('nfpBack10').addEventListener('click', () => skip(-10));
    $('nfpFwd10').addEventListener('click', () => skip(10));

    // volume
    const volSlider = $('nfpVolSlider');
    function setVolume(v, mute) {
        video.volume = Math.max(0, Math.min(1, v));
        if (mute !== undefined) video.muted = mute;
        else if (video.volume > 0) video.muted = false;
        store.set('volume', video.volume);
        store.set('muted', video.muted);
        renderVolume();
    }
    function renderVolume() {
        const v = video.muted ? 0 : video.volume;
        volSlider.querySelector('.fill').style.height = (v * 100) + '%';
        volSlider.querySelector('.knob').style.bottom = (v * 100) + '%';
        $('nfpMute').innerHTML = `<i class="fa-solid ${v === 0 ? 'fa-volume-xmark' : v < 0.5 ? 'fa-volume-low' : 'fa-volume-high'}"></i>`;
    }
    const volFromY = (y) => { const r = volSlider.getBoundingClientRect(); return 1 - Math.min(1, Math.max(0, (y - r.top) / r.height)); };
    volSlider.addEventListener('pointerdown', (e) => {
        volSlider.setPointerCapture(e.pointerId);
        setVolume(volFromY(e.clientY));
        const move = (ev) => setVolume(volFromY(ev.clientY));
        volSlider.addEventListener('pointermove', move);
        volSlider.addEventListener('pointerup', () => volSlider.removeEventListener('pointermove', move), { once: true });
    });
    $('nfpMute').addEventListener('click', () => setVolume(video.volume || 1, !video.muted));
    video.volume = store.get('volume', 1);
    video.muted = !!store.get('muted', false);
    renderVolume();

    // fullscreen
    function toggleFs() {
        const d = document;
        if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
        else if (root.requestFullscreen) root.requestFullscreen().then(() => { try { screen.orientation.lock('landscape').catch(() => {}); } catch { /* ignore */ } }).catch(() => {});
        else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
        else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    }
    $('nfpFs').addEventListener('click', toggleFs);
    // phones: full screen sits in the top bar, the bottom row matches the Netflix app
    $('nfpFsTop').addEventListener('click', (e) => { e.stopPropagation(); toggleFs(); activity(); });
    document.addEventListener('fullscreenchange', () => {
        const icon = `<i class="fa-solid ${document.fullscreenElement ? 'fa-compress' : 'fa-expand'}"></i>`;
        $('nfpFs').innerHTML = icon + `<span class="lbl">${esc(tr('fullscreen'))}</span>`;
        $('nfpFsTop').innerHTML = icon;
    });

    // panels
    const panels = { audio: $('nfpPanelAudio'), speed: $('nfpPanelSpeed'), episodes: $('nfpPanelEpisodes') };
    const anyPanelOpen = () => Object.values(panels).some(p => p && p.classList.contains('open'));
    function togglePanel(name) {
        for (const [k, p] of Object.entries(panels)) if (p) p.classList.toggle('open', k === name && !p.classList.contains('open'));
        const nc = $('nfpNextCard'); if (nc) nc.classList.remove('open');
        activity();
    }
    $('nfpAudioBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePanel('audio'); });
    $('nfpSpeedBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePanel('speed'); });
    if ($('nfpEpisodesBtn')) $('nfpEpisodesBtn').addEventListener('click', (e) => { e.stopPropagation(); renderEpisodes(); togglePanel('episodes'); });
    for (const p of Object.values(panels)) if (p) p.addEventListener('click', (e) => e.stopPropagation());

    // next episode button + hover card
    const nextBtn = $('nfpNextEp'), nextCard = $('nfpNextCard');
    if (nextBtn) {
        nextBtn.addEventListener('click', goNext);
        if (nextCard && !isTouch) {
            nextBtn.addEventListener('mouseenter', () => { if (!anyPanelOpen()) nextCard.classList.add('open'); });
            nextBtn.addEventListener('mouseleave', () => nextCard.classList.remove('open'));
        }
    }

    // speed
    const speedTrack = $('nfpSpeedTrack');
    function renderSpeed() {
        speedTrack.querySelectorAll('button').forEach(b => b.classList.toggle('on', parseFloat(b.dataset.speed) === video.playbackRate));
        const lbl = $('nfpSpeedLbl');
        if (lbl) lbl.textContent = `${tr('speed_short')} (${video.playbackRate}x)`;
    }
    speedTrack.addEventListener('click', (e) => {
        const b = e.target.closest('[data-speed]');
        if (!b) return;
        video.playbackRate = parseFloat(b.dataset.speed);
        renderSpeed();
    });
    video.addEventListener('ratechange', renderSpeed);
    renderSpeed();

    // episodes
    function renderEpisodes() {
        const sel = $('nfpSeasonSel');
        if (!sel) return;
        const season = parseInt(sel.value, 10);
        $('nfpEpList').innerHTML = C.episodes.filter(e => e.season === season).map(e => `
            <div class="nfp-ep${e.id === C.current ? ' current' : ''}" data-id="${e.id}">
                <span class="n">${e.order}</span>
                <div style="flex:1;min-width:0"><div class="tt">${esc(e.title)}</div>
                    <div class="nfp-ep-detail">${e.description ? `<p>${esc(e.description)}</p>` : ''}</div></div>
                ${e.thumbnail ? `<span class="thumb"><img src="${esc(e.thumbnail)}" alt="" loading="lazy"></span>` : ''}
            </div>`).join('');
    }
    if ($('nfpSeasonSel')) {
        $('nfpSeasonSel').addEventListener('change', renderEpisodes);
        $('nfpEpList').addEventListener('click', (e) => {
            const ep = e.target.closest('[data-id]');
            if (ep && Number(ep.dataset.id) !== C.current) { saveProgress(realTime(), duration(), true); location.href = '/watch/' + ep.dataset.id; }
        });
    }

    // ------------------------------------------------------------ audio & subtitles
    function buildAudioMenu() {
        const ul = $('nfpAudioList');
        const tracks = info.audioTracks || [];
        if (!tracks.length) { ul.innerHTML = `<li><button type="button" class="on">${esc(tr('default_audio'))}</button></li>`; return; }
        ul.innerHTML = tracks.map(a => `<li><button type="button" data-audio="${a.index}" class="${a.index === info.audioIndex ? 'on' : ''}">${esc(a.label)}</button></li>`).join('');
    }
    $('nfpAudioList').addEventListener('click', (e) => {
        const b = e.target.closest('[data-audio]');
        if (!b || Number(b.dataset.audio) === info.audioIndex) return;
        audioIndex = Number(b.dataset.audio);
        store.set('audioLang', (info.audioTracks.find(a => a.index === audioIndex) || {}).lang || null);
        begin(realTime(), { text: tr('switching_audio') });
    });

    function buildSubMenu() {
        const ul = $('nfpSubList');
        const list = [{ id: '', label: tr('off') }].concat(info.subtitles || []);
        ul.innerHTML = list.map(s => `<li><button type="button" data-sub="${esc(s.id)}" class="${(subTrack ? subTrack.id : '') === s.id ? 'on' : ''}">${esc(s.label)}</button></li>`).join('');
        const size = String(store.get('subSize', 1));
        $('nfpSubSize').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.size === size));
        root.style.setProperty('--sub-scale', size);
    }
    $('nfpSubList').addEventListener('click', (e) => {
        const b = e.target.closest('[data-sub]');
        if (b) selectSub(b.dataset.sub, true);
    });
    $('nfpSubSize').addEventListener('click', (e) => {
        const b = e.target.closest('[data-size]');
        if (!b) return;
        store.set('subSize', parseFloat(b.dataset.size));
        buildSubMenu();
    });

    function parseVtt(text) {
        const ts = (s) => {
            const p = s.trim().replace(',', '.').split(':');
            let sec = parseFloat(p.pop()); const m = parseInt(p.pop() || '0', 10); const h = parseInt(p.pop() || '0', 10);
            return h * 3600 + m * 60 + sec;
        };
        const cues = [];
        for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
            const lines = block.split('\n');
            const i = lines.findIndex(l => l.includes('-->'));
            if (i < 0) continue;
            const [a, b] = lines[i].split('-->');
            const end = ts(b.trim().split(/\s+/)[0]);
            const raw = lines.slice(i + 1).join('\n').trim();
            if (!raw) continue;
            const html = esc(raw.replace(/<(?!\/?(i|b|u)>)[^>]*>/gi, ''))
                .replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>')
                .replace(/\n/g, '<br>');
            cues.push({ start: ts(a), end, html });
        }
        return cues.sort((x, y) => x.start - y.start);
    }

    async function selectSub(id, remember) {
        const track = (info.subtitles || []).find(s => s.id === id) || null;
        subTrack = track;
        subCues = [];
        lastSubHtml = null;
        subsEl.innerHTML = '';
        if (remember) store.set('subLang', track ? track.lang || track.label : 'off');
        buildSubMenu();
        if (!track) return;
        try {
            const r = await fetch(track.url, { credentials: 'same-origin' });
            const text = await r.text();
            if (subTrack !== track) return;
            subCues = parseVtt(text);
            renderSubs(realTime());
        } catch { /* ignore */ }
    }

    function autoSelectSubs() {
        const pref = store.get('subLang', null);
        const subs = info.subtitles || [];
        if (!subs.length) return;
        if (pref && pref !== 'off') {
            const pick = subs.find(s => (s.lang === pref || s.label === pref) && !s.forced) || subs.find(s => s.lang === pref || s.label === pref);
            if (pick) return selectSub(pick.id, false);
        }
        // forced narrative subtitles for the chosen audio language
        const audio = (info.audioTracks || []).find(a => a.index === info.audioIndex);
        const forcedTrack = subs.find(s => s.forced && (!audio || s.lang === audio.lang));
        if (forcedTrack && pref !== 'off') selectSub(forcedTrack.id, false);
    }

    function renderSubs(t) {
        let html = '';
        if (subCues.length) {
            let lo = 0, hi = subCues.length - 1, idx = -1;
            while (lo <= hi) { const mid = (lo + hi) >> 1; if (subCues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
            const active = [];
            for (let i = idx; i >= 0 && i > idx - 12; i--) if (subCues[i].end >= t) active.unshift(subCues[i]);
            html = active.map(c => `<span>${c.html}</span>`).join('<br>');
        }
        if (html !== lastSubHtml) { subsEl.innerHTML = html; lastSubHtml = html; }
    }

    // ------------------------------------------------------------ chrome visibility
    function activity() {
        if (root.classList.contains('locked')) return;
        root.classList.remove('idle', 'hide-cursor');
        hideIdle();
        if (video.paused) armPauseScreen();
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            if (!video.paused && !anyPanelOpen() && !dragging && !root.querySelector('.nfp-bottom:hover')) root.classList.add('idle', 'hide-cursor');
        }, isTouch ? 3500 : 2800);
    }
    root.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') activity(); });
    document.addEventListener('click', () => { for (const p of Object.values(panels)) if (p) p.classList.remove('open'); });

    // tap / click on the video surface
    let lastTap = 0, tapTimer = null;
    video.addEventListener('click', (e) => {
        if (isTouch) {
            const now = Date.now();
            const r = video.getBoundingClientRect();
            if (now - lastTap < 300) {
                clearTimeout(tapTimer);
                lastTap = 0;
                if (e.clientX < r.left + r.width / 2) skip(-10); else skip(10);
                return;
            }
            lastTap = now;
            tapTimer = setTimeout(() => {
                if (root.classList.contains('idle')) activity();
                else root.classList.add('idle');
            }, 280);
            return;
        }
        if (anyPanelOpen()) return;
        togglePlay();
        activity();
    });
    video.addEventListener('dblclick', () => { if (!isTouch) toggleFs(); });
    idleEl.addEventListener('click', () => { hideIdle(); activity(); });

    // ------------------------------------------------------------ screen lock (phones)
    // Like the Netflix app: "Lock" ignores every tap until you unlock it with two taps.
    const lockEl = $('nfpLocked');
    let unlockStep = 0, lockTimer = null;
    function renderUnlock() {
        $('nfpUnlockText').textContent = unlockStep ? tr('unlock_screen') : tr('screen_locked');
        $('nfpUnlockHint').hidden = !!unlockStep;
    }
    function flashUnlock() {
        lockEl.classList.add('show');
        clearTimeout(lockTimer);
        lockTimer = setTimeout(() => { lockEl.classList.remove('show'); unlockStep = 0; renderUnlock(); }, 3000);
    }
    if (lockEl && $('nfpLock')) {
        $('nfpLock').addEventListener('click', (e) => {
            e.stopPropagation();
            for (const p of Object.values(panels)) if (p) p.classList.remove('open');
            hideIdle();
            root.classList.add('locked', 'idle');
            lockEl.hidden = false;
            unlockStep = 0;
            renderUnlock();
            flashUnlock();
        });
        lockEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!lockEl.classList.contains('show') || !e.target.closest('#nfpUnlock')) { flashUnlock(); return; }
            if (!unlockStep) { unlockStep = 1; renderUnlock(); flashUnlock(); return; }
            clearTimeout(lockTimer);
            lockEl.hidden = true;
            lockEl.classList.remove('show');
            root.classList.remove('locked');
            activity();
        });
    }

    // ------------------------------------------------------------ keyboard
    document.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
        if (e.ctrlKey || e.metaKey || e.altKey || root.classList.contains('locked')) return;
        if (stillEl && !stillEl.hidden) return; // the "still watching?" buttons handle the keys
        let handled = true;
        switch (e.key) {
            case ' ': case 'k': case 'K': case 'Enter': togglePlay(); break;
            case 'ArrowLeft': case 'j': case 'J': skip(-10); break;
            case 'ArrowRight': case 'l': case 'L': skip(10); break;
            case 'ArrowUp': setVolume((video.muted ? 0 : video.volume) + 0.1); break;
            case 'ArrowDown': setVolume(video.volume - 0.1); break;
            case 'm': case 'M': setVolume(video.volume || 1, !video.muted); break;
            case 'f': case 'F': toggleFs(); break;
            case 's': case 'S': if (!skipBtn.hidden) skipBtn.click(); else handled = false; break;
            case 'n': case 'N': if (C.nextEpisode) goNext(); else handled = false; break;
            case 'c': case 'C': {
                const list = [null].concat(info ? info.subtitles : []);
                const i = list.findIndex(s => (s ? s.id : null) === (subTrack ? subTrack.id : null));
                const nx = list[(i + 1) % list.length];
                selectSub(nx ? nx.id : '', true);
                break;
            }
            case 'Escape': for (const p of Object.values(panels)) if (p) p.classList.remove('open'); break;
            default: handled = false;
        }
        if (handled) { e.preventDefault(); activity(); }
    });

    // ------------------------------------------------------------ torrent status chip
    let isTorrentMedia = C.source.startsWith('t/');
    const chip = $('nfpTorrentChip');
    async function pollTorrent() {
        if (!isTorrentMedia) return;
        try {
            const r = await fetch('/api/download-status/' + C.source, { credentials: 'same-origin' });
            const s = await r.json();
            if (!s.active) { chip.hidden = true; return; }
            const speed = s.downloadSpeed > 1e6 ? (s.downloadSpeed / 1e6).toFixed(1) + ' MB/s' : Math.round(s.downloadSpeed / 1e3) + ' KB/s';
            chip.querySelector('span').innerHTML = `${tr('downloading')} ${Math.floor((s.progress || 0) * 100)}% <span class="muted">· ${speed} · ${tr(s.peers === 1 ? 'peer_one' : 'peers', { n: s.peers })}</span>`;
            chip.hidden = false;
        } catch { /* ignore */ }
        setTimeout(pollTorrent, document.hidden ? 10000 : 3000);
    }

    // ------------------------------------------------------------ media session
    if ('mediaSession' in navigator) {
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: C.title, artist: C.showTitle || '',
                artwork: C.backdrop ? [{ src: new URL(C.backdrop, location.href).href, sizes: '1280x720' }] : []
            });
            const ms = navigator.mediaSession;
            ms.setActionHandler('play', () => play());
            ms.setActionHandler('pause', () => video.pause());
            ms.setActionHandler('seekbackward', () => skip(-10));
            ms.setActionHandler('seekforward', () => skip(10));
            ms.setActionHandler('seekto', (d) => seek(d.seekTime));
            if (C.nextEpisode) ms.setActionHandler('nexttrack', goNext);
        } catch { /* unsupported action */ }
    }

    $('nfpRetry').addEventListener('click', () => { fallbackStage = 0; forced = null; begin(realTime() || C.resume || 0); });

    // go
    begin(C.resume || 0).then(() => { if (isTorrentMedia) pollTorrent(); });
    activity();
})();
