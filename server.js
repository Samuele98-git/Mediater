const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const session = require('express-session');

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'data.json');

// --- DATABASE ENGINE ---
function getDB() {
    let db = { users: [], playlists: [] };
    if (fs.existsSync(DB_FILE)) {
        try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
    }
    // Default Admin (username: admin, pass: 123)
    if (!db.users || db.users.length === 0) {
        db.users = [{ username: 'admin', password: '123', role: 'ADMIN' }];
        saveDB(db);
    }
    if (!db.playlists) { db.playlists = []; saveDB(db); }
    return db;
}

function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());
app.use(session({
    secret: 'mediater-key', resave: false, saveUninitialized: true,
    cookie: { maxAge: 86400000 * 7 }
}));

// --- AUTH ---
app.get('/api/session', (req, res) => res.json({ loggedIn: !!req.session.role, role: req.session.role, username: req.session.username }));

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const db = getDB();
    const user = db.users.find(u => u.username === username && u.password === password);
    if (user) {
        req.session.role = user.role;
        req.session.username = user.username;
        req.session.save();
        res.json({ success: true, role: user.role });
    } else {
        res.status(401).json({ success: false });
    }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({success:true}); });

// --- USER MANAGEMENT ---
app.post('/api/users', (req, res) => {
    if (req.session.role !== 'ADMIN') return res.status(403).send();
    const db = getDB();
    const { username, password, role } = req.body;
    if(db.users.find(u => u.username === username)) return res.status(400).send("User exists");
    db.users.push({ username, password, role });
    saveDB(db);
    res.json(db.users);
});

// NEW: Update Password Route
app.put('/api/users/:username', (req, res) => {
    if (req.session.role !== 'ADMIN') return res.status(403).send();
    const db = getDB();
    const user = db.users.find(u => u.username === req.params.username);
    if (user) {
        user.password = req.body.password;
        saveDB(db);
        res.json({ success: true });
    } else {
        res.status(404).send("User not found");
    }
});

app.delete('/api/users/:username', (req, res) => {
    if (req.session.role !== 'ADMIN') return res.status(403).send();
    const db = getDB();
    if (req.params.username === 'admin') return res.status(400).send("Cannot delete main admin");
    db.users = db.users.filter(u => u.username !== req.params.username);
    saveDB(db);
    res.json(db.users);
});

// --- CONTENT ---
app.get('/api/data', (req, res) => {
    if (!req.session.role) return res.status(401).send();
    res.json(getDB());
});

app.post('/api/save', (req, res) => {
    if (req.session.role !== 'ADMIN') return res.status(403).send();
    const db = getDB();
    db.playlists = req.body.playlists;
    saveDB(db);
    res.json({success:true});
});

app.post('/api/upload/:playlistIdx', upload.single('file'), (req, res) => {
    if (req.session.role !== 'ADMIN') return res.status(403).send();
    const db = getDB();
    const idx = parseInt(req.params.playlistIdx) || 0;
    if (db.playlists[idx]) {
        db.playlists[idx].videos.push(req.file.filename);
        saveDB(db);
        res.send('Uploaded');
    } else res.status(400).send('Error');
});

app.post('/api/cover/:playlistIdx', upload.single('file'), (req, res) => {
    if (req.session.role !== 'ADMIN') return res.status(403).send();
    const db = getDB();
    const idx = parseInt(req.params.playlistIdx);
    if (db.playlists[idx]) {
        db.playlists[idx].cover = req.file.filename;
        saveDB(db);
        res.send('Cover Updated');
    } else res.status(400).send('Error');
});

app.get('/stream/:filename', (req, res) => {
    const filePath = path.join(UPLOAD_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (!req.params.filename.match(/\.(mp4|mkv|mov)$/i)) return res.sendFile(filePath);
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': 'video/mp4' };
        res.writeHead(206, head); file.pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
        fs.createReadStream(filePath).pipe(res);
    }
});

app.listen(PORT, () => console.log(`Mediater Running on ${PORT}`));