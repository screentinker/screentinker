/**
 * PDF → one image per page, rendered IN THE BROWSER.
 *
 * ⚠️ WHY THE BROWSER AND NOT THE SERVER. Every serious server-side PDF renderer that is not
 * copyleft is either pdf.js on a Node canvas shim or a headless Chromium, and prod has neither
 * installed. Rendering here means the server never parses a PDF, carries no PDF dependency, spends
 * no CPU on it, and gains no new attack surface: the pages arrive as ordinary PNGs through the
 * ordinary upload path, and the upload allowlist stays exactly as strict as it was. The machine
 * doing the work is the one that already has the PDF open.
 *
 * pdf.js is Apache-2.0 and vendored under frontend/vendor/pdfjs/ (see the README there). It is
 * imported LAZILY below so the 1.7 MB is fetched only when someone actually uploads a PDF.
 *
 * What a page becomes: a PNG whose longest edge is MAX_EDGE px. A portrait letter page on a
 * landscape screen shows with side bars, which is what every other CMS does with a PDF and is the
 * correct outcome; a PDF exported from a 16:9 slide deck lands at exactly 1920x1080.
 */

const PDFJS_VERSION = '6.3.289';
const VENDOR = '/vendor/pdfjs/';

/** Longest edge of a rendered page, in pixels. 1920 is full HD on the long side. */
export const MAX_EDGE = 1920;

/** A PDF with more pages than this is refused rather than half-uploaded. The playlist bulk-add
 *  endpoint caps at 500 too, so this is the honest limit end to end. */
export const MAX_PAGES = 500;

/**
 * Scale so the longer side of a (w × h) viewport becomes maxEdge, never upscaling past what
 * the PDF's own units would make ridiculous. Pure, so it is tested without a DOM.
 */
export function fitScale(width, height, maxEdge = MAX_EDGE) {
  const longest = Math.max(width, height);
  if (!(longest > 0)) return 1;
  return maxEdge / longest;
}

/** `Quarterly report.pdf` → `Quarterly report`; used for the folder, the playlist and page names. */
export function baseName(filename) {
  return String(filename || 'document').replace(/\.pdf$/i, '').trim() || 'document';
}

/** `Quarterly report`, 3, 12 → `Quarterly report-p03.png`. Zero-padded so the pages sort. */
export function pageFileName(base, index, total) {
  const width = String(total).length;
  return `${base}-p${String(index).padStart(Math.max(2, width), '0')}.png`;
}

export function isPdf(file) {
  return file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${VENDOR}pdf.min.mjs`).then((mod) => {
      // Same-origin worker: allowed under the dashboard CSP's default-src 'self' without a
      // worker-src directive. A blob: worker would NOT be, so this path is load-bearing.
      mod.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;
      return mod;
    });
  }
  return pdfjsPromise;
}

/**
 * Render every page of a PDF File to a PNG File.
 *
 * @param {File} file            the PDF
 * @param {(done:number,total:number)=>void} [onPage]  progress, called after each page
 * @returns {Promise<File[]>}    one PNG File per page, in page order, named to sort
 */
export async function renderPdfToPages(file, onPage) {
  const pdfjs = await loadPdfjs();
  const data = await file.arrayBuffer();
  // Keep the loading task: it, not the document proxy, owns destroy(). Calling destroy on the
  // proxy threw "doc.destroy is not a function" in the finally block AFTER every page had
  // rendered correctly, which turned a working import into a failed one. Caught in a real browser.
  const loadingTask = pdfjs.getDocument({
    data,
    wasmUrl: `${VENDOR}wasm/`,
    // A PDF that carries JavaScript is a document, not a program. Nothing here runs it.
    isEvalSupported: false,
    enableXfa: false,
  });
  const doc = await loadingTask.promise;

  try {
    const total = doc.numPages;
    if (total > MAX_PAGES) {
      throw new Error(`This PDF has ${total} pages; the limit is ${MAX_PAGES}.`);
    }
    const base = baseName(file.name);
    const out = [];
    for (let n = 1; n <= total; n += 1) {
      const page = await doc.getPage(n);
      try {
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: fitScale(natural.width, natural.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        // White behind the page: PDFs are transparent where nothing is drawn, and a transparent
        // PNG on a black signage background reads as a black page.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the page'))), 'image/png');
        });
        out.push(new File([blob], pageFileName(base, n, total), { type: 'image/png' }));
        // Release the bitmap now rather than at GC time: a 50-page document at 1920px is a lot
        // of canvas to leave lying around while the next one renders.
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        page.cleanup();
      }
      if (onPage) onPage(n, total);
    }
    return out;
  } finally {
    await loadingTask.destroy();
  }
}

export { PDFJS_VERSION };
