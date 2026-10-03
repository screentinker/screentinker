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
    // Deliberately NOT path.extname(file.originalname): the extension decides how a
    // browser interprets the file, and these are served from the dashboard's own origin,
    // so a caller must not choose it. multer picks the name before any bytes exist, so we
    // land on a neutral `.part` and lib/upload-sniff.finalizeUpload() renames it to a
    // content-derived extension once the bytes are on disk.
    cb(null, `${uuidv4()}.part`);
  }
});

/*
 * ⚠️ THIS GATE READS A HEADER THE CALLER WROTE, so it is a courtesy, not a control. The authority
 * is lib/upload-sniff.finalizeUpload, which reads the bytes on disk and unlinks anything it does
 * not recognise. This exists to reject the obvious early and cheaply.
 *
 * HTML bundles are admitted by EXTENSION as well as mimetype, because browsers are inconsistent
 * about a .wgt: Chrome sends application/octet-stream, some send application/x-zip-compressed, and
 * a few send nothing useful at all. Admitting bare octet-stream on its own would let every curl
 * default upload reach the disk before the sniffer refused it, so the extension has to agree.
 */
const ZIP_MIMETYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream', ''];
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'video/mp4', 'video/webm', 'video/avi', 'video/mkv', 'video/mov',
    'video/x-msvideo', 'video/quicktime', 'video/x-matroska',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
    // Audio, for slide voiceovers and deck music beds. The prefix test below covers these too;
    // they are named for the same reason the video and image types are — so the list reads as the
    // set this product accepts rather than as whatever the prefix happens to admit.
    'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/x-flac',
  ];
  const looksLikeBundle = /\.(zip|wgt)$/i.test(file.originalname || '')
    && ZIP_MIMETYPES.includes(String(file.mimetype || '').toLowerCase());
  /*
   * Admitted by EXTENSION as well, for the same reason bundles are: callers disagree about media
   * types. A browser sends video/mp4 or audio/mpeg, but plenty of clients send octet-stream — curl
   * sends it for a .wav AND for a .mp4 — and refusing those makes uploading look broken for
   * anything that is not a file picker.
   *
   * ⚠️ EVERY MEDIA KIND, not just audio. This started as an audio-only fallback, which left the
   * product accepting a script-uploaded .wav and refusing the .mp4 beside it — an inconsistency
   * with no reason behind it, found by trying to upload a video from the command line.
   *
   * The extension has to AGREE with an unhelpful type, exactly as for a .wgt: bare octet-stream on
   * its own would let every default upload reach the disk. And the real gate is unchanged either
   * way — finalizeUpload reads the bytes and unlinks anything the magic does not recognise, so a
   * .mp4 full of something else gets no further than this filter lets it.
   */
  const looksLikeMedia = /\.(mp3|m4a|m4b|wav|ogg|oga|opus|flac|mp4|m4v|webm|mkv|mov|avi|jpg|jpeg|png|gif|webp|avif|heic|bmp)$/i
    .test(file.originalname || '')
    && ZIP_MIMETYPES.includes(String(file.mimetype || '').toLowerCase());
  if (allowedTypes.includes(file.mimetype) || file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')
      || file.mimetype.startsWith('audio/')
      || looksLikeMedia
      || looksLikeBundle) {
    cb(null, true);
  } else {
    cb(new Error('Only audio, video, image and HTML-bundle files are allowed'), false);
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
