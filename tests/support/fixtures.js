'use strict';
// Extracts the visible title/text of the blob document embedded in a sample
// launcher page, so unit tests score the real sample content rather than a copy.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./server');

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function htmlToSnapshot(html) {
  const title = decodeEntities((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || html;
  const text = decodeEntities(
    body
      .replace(/<script[\s\S]*?<\\?\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text };
}

/** First template literal in the page that contains an HTML document. */
function blobDocumentFrom(relPath) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const m = src.match(/`(\s*<!DOCTYPE html>[\s\S]*?)`/i);
  if (!m) throw new Error(`no embedded blob document in ${relPath}`);
  return htmlToSnapshot(m[1]);
}

module.exports = { blobDocumentFrom, htmlToSnapshot };
