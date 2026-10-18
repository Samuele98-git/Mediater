// Tiny in-process background queue (one job at a time, de-duplicated by key).
// Used for probing files, grabbing artwork frames and building scrub thumbnails.
const queue = [];
const pending = new Set();
let running = false;
let current = null;

export function enqueue(key, fn) {
    if (pending.has(key)) return false;
    pending.add(key);
    queue.push({ key, fn });
    setImmediate(pump);
    return true;
}

async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
        const job = queue.shift();
        current = job.key;
        try { await job.fn(); } catch (e) { console.warn(`[jobs] ${job.key} failed: ${e.message}`); }
        pending.delete(job.key);
    }
    current = null;
    running = false;
}

export const jobStatus = () => ({ running: current, queued: queue.map(j => j.key) });
