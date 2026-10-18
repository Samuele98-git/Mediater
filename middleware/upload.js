import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { UPLOAD_DIR } from '../lib/config.js';
import { VIDEO_EXT, SUB_EXT } from '../lib/release-name.js';

// form field name -> folder inside UPLOAD_DIR (everything else is an image)
const FOLDERS = { video: 'videos', trailerFile: 'videos', subtitle: 'subtitles' };
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, FOLDERS[file.fieldname] || 'images')),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
        cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + ext);
    }
});

function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    let ok;
    if (file.fieldname === 'video' || file.fieldname === 'trailerFile') ok = VIDEO_EXT.has(ext) || file.mimetype.startsWith('video/');
    else if (file.fieldname === 'subtitle') ok = SUB_EXT.has(ext);
    // SVG is refused on purpose: it can carry scripts.
    else ok = IMAGE_EXT.has(ext) && file.mimetype.startsWith('image/');
    if (ok) return cb(null, true);
    const err = new Error(`Unsupported file for "${file.fieldname}": ${file.originalname}`);
    err.status = 400;
    cb(err, false);
}

export const upload = multer({ storage, fileFilter, limits: { fileSize: 100 * 1024 ** 3 } });

/** Profile pictures: any signed-in user can send one, so they are small images only. */
export const avatarUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, 'images')),
        filename: (req, file, cb) => cb(null, 'avatar-' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, ''))
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 30 },
    fileFilter: (req, file, cb) => {
        if (IMAGE_EXT.has(path.extname(file.originalname).toLowerCase()) && file.mimetype.startsWith('image/')) return cb(null, true);
        const err = new Error('Please choose a JPG, PNG, WebP, GIF or AVIF picture');
        err.status = 400;
        cb(err, false);
    }
});

/** Deletes an uploaded file that ends up unused (form rejected, not allowed…). */
export function discardUpload(req) {
    if (req.file && req.file.path) fs.rm(req.file.path, { force: true }, () => {});
}

/** Public path ("/uploads/...") for a stored upload. */
export const uploadPath = (file) => '/uploads/' + path.relative(UPLOAD_DIR, file.path).split(path.sep).join('/');

export const torrentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname).toLowerCase() === '.torrent') return cb(null, true);
        const err = new Error('Please choose a .torrent file');
        err.status = 400;
        cb(err, false);
    }
});
