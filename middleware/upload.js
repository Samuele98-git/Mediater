import multer from 'multer';
import path from 'path';

// Define storage location
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'video' || file.fieldname === 'path') {
            cb(null, 'public/uploads/videos');
        } else {
            cb(null, 'public/uploads/images');
        }
    },
    filename: (req, file, cb) => {
        // Unique filename: timestamp-name.ext
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

// Filter file types
const fileFilter = (req, file, cb) => {
    if (file.fieldname === 'video' || file.fieldname === 'path') {
        if (file.mimetype.startsWith('video/')) cb(null, true);
        else cb(new Error('Not a video file!'), false);
    } else {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Not an image file!'), false);
    }
};

export const upload = multer({ 
    storage: storage,
    limits: { fileSize: 1024 * 1024 * 5000 } // 5GB Limit (Adjust as needed)
});