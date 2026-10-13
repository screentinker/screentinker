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
    out = out.replace(/<[^>]*>/g, '');
  } while (out !== prev);
  return out;
}

module.exports = { stripTags };
