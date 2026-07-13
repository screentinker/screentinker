'use strict';

// #170: rotation-aware media dimensions. Both ffprobe (video) and sharp/EXIF (image) report the
// CODED/stored width×height, which ignore how the asset is meant to be DISPLAYED. A portrait
// phone video (coded 1920×1080 with a 90° display matrix) or a portrait photo (EXIF orientation
// 6) is therefore stored as LANDSCAPE, so the player renders it wrong-aspect and letterboxed
// (the blue-bar symptom). These pure helpers normalize to DISPLAY dimensions and are the single
// source of truth for both fresh ingest (content-ingest.js) and the backfill script. Unit-tested
// in test/media-orientation.test.js.

// Does a rotation of `degrees` swap width and height? True only for odd quarter-turns.
function rotationSwapsWH(degrees) {
  const d = (((Number(degrees) || 0) % 360) + 360) % 360;
  return d === 90 || d === 270;
}

// Rotation (degrees, normalized 0..359) a video should be displayed at. ffprobe exposes this two
// ways: the legacy `tags.rotate` string, and the modern Display Matrix side_data `rotation` (an
// int, often NEGATIVE, e.g. -90). Prefer the Display Matrix when present (what modern muxers
// write); fall back to the tag. The sign is irrelevant to the W/H swap decision either way.
function videoRotationDegrees(videoStream) {
  if (!videoStream) return 0;
  let deg = null;
  const dm = (videoStream.side_data_list || []).find(s => /display\s*matrix/i.test(s.side_data_type || ''));
  if (dm && dm.rotation != null && !Number.isNaN(parseInt(dm.rotation, 10))) {
    deg = parseInt(dm.rotation, 10);
  } else if (videoStream.tags && videoStream.tags.rotate != null && !Number.isNaN(parseInt(videoStream.tags.rotate, 10))) {
    deg = parseInt(videoStream.tags.rotate, 10);
  }
  return (((Number(deg) || 0) % 360) + 360) % 360;
}

// Display dimensions for a video stream, honoring rotation. Null-safe.
function videoDisplayDims(videoStream) {
  if (!videoStream || videoStream.width == null || videoStream.height == null) return { width: null, height: null };
  return rotationSwapsWH(videoRotationDegrees(videoStream))
    ? { width: videoStream.height, height: videoStream.width }
    : { width: videoStream.width, height: videoStream.height };
}

// EXIF orientation 5..8 encode a 90°/270° rotation (W/H swap); 1..4 do not.
function exifSwapsWH(orientation) {
  const o = Number(orientation);
  return o >= 5 && o <= 8;
}

// Display dimensions for an image, honoring EXIF orientation. Null-safe.
function imageDisplayDims(metadata) {
  if (!metadata || metadata.width == null || metadata.height == null) return { width: null, height: null };
  return exifSwapsWH(metadata.orientation)
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

module.exports = { rotationSwapsWH, videoRotationDegrees, videoDisplayDims, exifSwapsWH, imageDisplayDims };
