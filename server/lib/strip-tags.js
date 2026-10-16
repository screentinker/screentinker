'use strict';

/*
 * Drop every <…> run from a string, repeating until nothing changes.
 *
 * ⚠️ THIS FLATTENS MARKUP TO TEXT. IT IS NOT AN HTML SANITISER. Everything that uses it renders the
 * result as text (textContent, a Markdown rendition, a JSON field that is escaped on output), and it
 * has to stay that way: a string with no complete tag left in it can still hold a lone "<", and
 * entity decoding done afterwards can produce new ones.
 *
 * Why loop: a single pass of /<[^>]*>/g already leaves no complete tag behind, so for every input
 * the second pass is a no-op and the output is what one pass gave. The loop makes that a property of
 * the code instead of an argument about the regex: a later edit that narrows the pattern to named
 * tags (the usual next step, "keep <br> as a newline") is exactly the kind that turns "<scr<b>ipt>"
 * into "<script>" in one pass, and the loop is what stops it.
 */
function stripTags(s) {
  let out = String(s);
  let prev;
  do {
    prev = out;
    out = stripOnce(out);
  } while (out !== prev);
  return out;
}

/*
 * One pass of `.replace(/<[^>]*>/g, '')`, in linear time.
 *
 * The regex is quadratic on a run of "<" with no ">" after it: every "<" starts a match that walks
 * `[^>]*` to the end of the string before failing, so 50 KB of "<" is ~1.25e9 steps (seconds of a
 * pinned event loop) and a 2 MB caption file is many minutes. The scan below does what the regex
 * does — a "<" starts a tag that runs to the FIRST ">" after it, "<" included — and stops at the
 * first "<" with no ">" left, because no later "<" can have one either.
 */
function stripOnce(str) {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = str.indexOf('<', i);
    if (lt < 0) break;
    const gt = str.indexOf('>', lt + 1);
    if (gt < 0) break;
    out += str.slice(i, lt);
    i = gt + 1;
  }
  return i === 0 ? str : out + str.slice(i);
}

module.exports = { stripTags };
