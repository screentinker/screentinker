const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.contentDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'video/mp4', 'video/webm', 'video/avi', 'video/mkv', 'video/mov',
    'video/x-msvideo', 'video/quicktime', 'video/x-matroska',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'
  ];
  if (allowedTypes.includes(file.mimetype) || file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only video and image files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxFileSize }
});

module.exports = upload;
