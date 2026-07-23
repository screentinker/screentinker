const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.contentDir);
  },
  filename: (req, file, cb) => {
    // busboy decodes the Content-Disposition filename header as latin1 by
    // default. Modern clients send raw UTF-8 bytes for non-ASCII filenames
    // (e.g. browsers + curl on UTF-8 locales send "Begrussungsscreens.jpg"
    // with c3 bc for u-umlaut). Reading those bytes as latin1 produces the
    // string "A-tilde + quarter-mark" which JS then re-encodes as 4 UTF-8
    // bytes on the way to the DB - classic double-encoding mojibake.
    //
    // The `defParamCharset: 'utf8'` option below only takes effect for
    // RFC 5987 encoded `filename*=...` params, which most clients don't send.
    // For the plain `filename="..."` case, re-decode here to recover the
    // original UTF-8 byte sequence. Mutating originalname here propagates to
    // every downstream consumer (route handlers reading req.file.originalname).
    if (file.originalname) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    }
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

// `defParamCharset: 'utf8'` only takes effect for RFC 5987 encoded
// `filename*=utf-8''...` params. Most real clients (browsers, curl, programmatic
// HTTP) send the plain `filename="..."` form, where busboy still reads the bytes
// as latin1 regardless of this option. The actual UTF-8 recovery happens in the
// storage.filename callback above via Buffer.from(name,'latin1').toString('utf8').
// Kept here as defense-in-depth for the rare RFC 5987 case.
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxFileSize },
  defParamCharset: 'utf8'
});

// #216: dedicated uploader for WebVTT subtitle files. The main `fileFilter` only allows
// video/image, so subtitles need their own instance. Written into the same content dir
// (served at /uploads/content/<file>) with a .vtt name; capped small — subtitles are tiny.
const subtitleStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.contentDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}.vtt`),
});
const subtitleUpload = multer({
  storage: subtitleStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB — generous for a subtitle track
  fileFilter: (req, file, cb) => {
    // Browsers send .vtt as text/vtt; some send text/plain or application/octet-stream.
    // Gate on the extension (authoritative here) plus those benign text mimetypes.
    const okExt = /\.vtt$/i.test(file.originalname || '');
    const okMime = ['text/vtt', 'text/plain', 'application/octet-stream'].includes(file.mimetype);
    if (okExt && okMime) return cb(null, true);
    cb(new Error('Only .vtt subtitle files are allowed'), false);
  },
});
upload.subtitleUpload = subtitleUpload;

module.exports = upload;
