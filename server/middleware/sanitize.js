// Simple XSS sanitizer for user input strings
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Middleware: sanitize common body fields
function sanitizeBody(req, res, next) {
  if (req.body) {
    const fieldsToSanitize = ['name', 'title', 'filename'];
    for (const field of fieldsToSanitize) {
      if (typeof req.body[field] === 'string') {
        req.body[field] = sanitizeString(req.body[field]);
      }
    }
  }
  next();
}

module.exports = { sanitizeString, sanitizeBody };
