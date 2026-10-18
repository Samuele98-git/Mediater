// Small HTML helpers shared by templates (fast, escaped card markup).
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** JSON safe to drop inside <script> tags. */
const BS = String.fromCharCode(92); // backslash
export const jsonScript = (v) => JSON.stringify(v ?? null)
    .replace(/</g, BS + 'u003c')
    .split(String.fromCharCode(0x2028)).join(BS + 'u2028')
    .split(String.fromCharCode(0x2029)).join(BS + 'u2029');

function artImg(c, { poster = false } = {}) {
    const land = c.img || c.backdrop || '';
    const port = c.poster || '';
    if (poster) {
        const src = port || land;
        return src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : '';
    }
    if (!land && !port) return '';
    if (port && land) {
        return `<picture><source media="(max-width: 740px)" srcset="${esc(port)}"><img src="${esc(land)}" alt="" loading="lazy" decoding="async"></picture>`;
    }
    return `<img src="${esc(land || port)}" alt="" loading="lazy" decoding="async">`;
}

function badges(c, t, kind) {
    // Continue Watching cards only show download progress (like Netflix, no ribbons).
    if (kind === 'continue') return c.downloading != null ? `<span class="nf-dl-chip"><i class="fa-solid fa-arrow-down"></i> ${c.downloading}%</span>` : '';
    let out = '';
    if (c.top10) out += `<span class="nf-badge-top10" title="Top 10"><b>TOP</b><b>10</b></span>`;
    if (c.downloading != null) out += `<span class="nf-dl-chip"><i class="fa-solid fa-arrow-down"></i> ${c.downloading}%</span>`;
    else if (c.newEpisodes) out += `<span class="nf-ribbon">${esc(t('card.new_episodes'))}</span>`;
    else if (c.isNew) out += `<span class="nf-ribbon">${esc(t('card.recently_added'))}</span>`;
    return out;
}

/**
 * kind: standard | continue | top10 | tall | grid
 * item: { playId, pct, episode } for Continue Watching
 */
export function cardHtml(c, { kind = 'standard', rank = 0, item = {}, t }) {
    if (!c) return '';
    const name = esc(c.title);
    const href = `/title/${c.id}`;
    let play = item.playId ? ` data-play="${item.playId}"` : '';
    if (kind === 'continue') {
        play += ` data-pct="${Math.round((item.pct || 0) * 1000) / 1000}"`;
        if (item.episode) play += ` data-ep="${esc(t('card.episode_short', { s: item.episode.season, e: item.episode.order }))}" data-ep-title="${esc(item.episode.title || '')}"`;
    }
    if (kind === 'top10') {
        return `<a class="nf-card nf-card--top10" href="${href}" data-id="${c.id}" aria-label="${name}">` +
            `<span class="nf-rank${rank === 10 ? ' ten' : ''}" aria-hidden="true">${rank}</span>` +
            `<span class="nf-card-poster">${artImg(c, { poster: true }) || `<span class="nf-card-fallback">${name}</span>`}</span></a>`;
    }
    if (kind === 'tall') {
        return `<a class="nf-card nf-card--tall" href="${href}" data-id="${c.id}" aria-label="${name}">` +
            `<span class="nf-card-poster">${artImg(c, { poster: true }) || `<span class="nf-card-fallback">${name}</span>`}${badges(c, t)}</span></a>`;
    }
    const art = artImg(c);
    const label = c.logo
        ? `<img class="nf-card-logo" src="${esc(c.logo)}" alt="${name}" loading="lazy">`
        : `<span class="nf-card-name">${name}</span>`;
    let extra = '';
    if (kind === 'continue') {
        const pct = Math.max(0, Math.min(100, Math.round((item.pct || 0) * 100)));
        const ep = item.episode ? `<span class="nf-card-ep">${esc(t('card.episode_short', { s: item.episode.season, e: item.episode.order }))}</span>` : '';
        extra = `${ep}<span class="nf-card-progress"><span style="width:${pct}%"></span></span>`;
    }
    return `<a class="nf-card${kind === 'grid' ? ' nf-card--grid' : ''}" href="${href}" data-id="${c.id}"${play} aria-label="${name}">` +
        `<span class="nf-card-art${art ? '' : ' empty'}">${art}${label}${badges(c, t, kind)}${extra}</span></a>`;
}
