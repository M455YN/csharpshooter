'use strict';

// Opening tags of a Razor page and their attributes, the value of each with its C# string unwrapped (select=@(@"...")):
// C# Razor Tag Helper Support's scanner (folding.js, isNameChar to scanOpeningTags, MIT), copied as it is so
// CSharpShooter SQL reads a Tag Helper's SQL without that extension.

function isNameChar(ch) {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_' ||
    ch === '-' ||
    ch === ':' ||
    ch === '.'
  );
}

function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isNameStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function verbatimOpenLength(text, i) {
  if (text[i] === '$' && text[i + 1] === '@' && text[i + 2] === '"') return 3;
  if (text[i] === '@' && text[i + 1] === '$' && text[i + 2] === '"') return 3;
  if (text[i] === '@' && text[i + 1] === '"') return 2;
  return 0;
}

function skipVerbatim(text, contentStart) {
  for (let i = contentStart; i < text.length; i++) {
    if (text[i] === '"') {
      if (text[i + 1] === '"') {
        i += 1;
        continue;
      }
      return i + 1;
    }
  }
  return text.length;
}

function skipQuoted(text, quoteIndex) {
  const q = text[quoteIndex];
  for (let i = quoteIndex + 1; i < text.length; i++) {
    // HTML attributes often wrap Razor: lookup-sql="@(@" ... ")"
    // The quote that opens @" must not close the attribute.
    if (text[i] === '@') {
      const next = skipRazorAt(text, i);
      if (next > i) {
        i = next - 1;
        continue;
      }
    }
    if (text[i] === q) {
      return i + 1;
    }
  }
  return text.length;
}

/**
 * Skip a Razor token starting at '@': @@, @* *@, @", @(...), @Name(...).
 */
function skipRazorAt(text, i) {
  if (text[i] !== '@') return i;
  if (text[i + 1] === '@') return i + 2;
  if (text[i + 1] === '*') return skipRazorComment(text, i);

  const verbLen = verbatimOpenLength(text, i);
  if (verbLen) return skipVerbatim(text, i + verbLen);

  if (text[i + 1] === '(') {
    return skipBalanced(text, i + 1, '(', ')');
  }

  if (isNameStart(text[i + 1])) {
    let j = i + 2;
    while (j < text.length && isNameChar(text[j])) {
      j += 1;
    }
    if (text[j] === '(') {
      return skipBalanced(text, j, '(', ')');
    }
    if (text[j] === '[') {
      return skipBalanced(text, j, '[', ']');
    }
    return j;
  }

  return i + 1;
}

function skipRazorComment(text, atIndex) {
  const end = text.indexOf('*@', atIndex + 2);
  return end === -1 ? text.length : end + 2;
}

function skipHtmlComment(text, ltIndex) {
  const end = text.indexOf('-->', ltIndex + 4);
  return end === -1 ? text.length : end + 3;
}

function indexOfIgnoreCase(text, needle, from) {
  const n = needle.length;
  for (let i = from; i <= text.length - n; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      const a = text[i + j];
      const b = needle[j];
      if (a !== b && a.toLowerCase() !== b) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function skipScriptOrStyle(text, i) {
  if (text[i] !== '<') return i;
  let close = null;
  if (
    text.slice(i, i + 7).toLowerCase() === '<script' &&
    !isNameChar(text[i + 7] || '')
  ) {
    close = '</script>';
  } else if (
    text.slice(i, i + 6).toLowerCase() === '<style' &&
    !isNameChar(text[i + 6] || '')
  ) {
    close = '</style>';
  }
  if (!close) return i;
  const closeAt = indexOfIgnoreCase(text, close, i + 1);
  if (closeAt === -1) return text.length;
  return closeAt + close.length;
}

function skipRazorCommentOrHtmlComment(text, i) {
  if (text[i] === '@' && text[i + 1] === '*') {
    return skipRazorComment(text, i);
  }
  if (text[i] === '<' && text.startsWith('<!--', i)) {
    return skipHtmlComment(text, i);
  }
  return i;
}

/**
 * Trivia to skip while scanning the document (not inside a tag).
 * Single quotes are left alone so English text like "don't" cannot swallow
 * the rest of the file.
 */
function skipTopLevelTrivia(text, i) {
  const commentEnd = skipRazorCommentOrHtmlComment(text, i);
  if (commentEnd !== i) return commentEnd;
  const scriptEnd = skipScriptOrStyle(text, i);
  if (scriptEnd !== i) return scriptEnd;
  const verbLen = verbatimOpenLength(text, i);
  if (verbLen) {
    return skipVerbatim(text, i + verbLen);
  }
  if (text[i] === '"') {
    return skipQuoted(text, i);
  }
  return i;
}

/**
 * Skip a string, Razor comment, or HTML comment starting at i (inside a tag).
 * Returns i unchanged if nothing special starts there.
 */
function skipStringOrComment(text, i) {
  const commentEnd = skipRazorCommentOrHtmlComment(text, i);
  if (commentEnd !== i) return commentEnd;
  const verbLen = verbatimOpenLength(text, i);
  if (verbLen) {
    return skipVerbatim(text, i + verbLen);
  }
  if (text[i] === '"' || text[i] === "'") {
    return skipQuoted(text, i);
  }
  return i;
}

function skipBalanced(text, openIndex, openCh, closeCh) {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const skipped = skipStringOrComment(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = text[i];
    if (ch === openCh) {
      depth += 1;
    } else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
    i += 1;
  }
  return text.length;
}

function peekTagName(text, ltIndex) {
  let i = ltIndex + 1;
  if (i >= text.length) return null;
  const closing = text[i] === '/';
  if (closing) {
    i += 1;
  }
  if (!isNameStart(text[i])) return null;
  const nameStart = i;
  i += 1;
  while (i < text.length && isNameChar(text[i])) {
    i += 1;
  }
  return {
    name: text.slice(nameStart, i),
    closing,
    nameEnd: i
  };
}

/**
 * From '<', find the matching '>' that actually closes the tag, skipping
 * attribute strings and Razor expressions so a '>' inside SQL is ignored.
 */
function parseTag(text, ltIndex) {
  const peeked = peekTagName(text, ltIndex);
  if (!peeked) return null;

  let i = peeked.nameEnd;
  while (i < text.length) {
    const skipped = skipStringOrComment(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }

    const razorEnd = skipRazorAt(text, i);
    if (razorEnd > i) {
      i = razorEnd;
      continue;
    }

    if (text[i] === '>') {
      let j = i - 1;
      while (j > ltIndex && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r' || text[j] === '\n')) {
        j -= 1;
      }
      const selfClosing = !peeked.closing && text[j] === '/';
      return {
        startIndex: ltIndex,
        endIndex: i + 1,
        name: peeked.name,
        nameEnd: peeked.nameEnd,
        closing: peeked.closing,
        selfClosing
      };
    }

    i += 1;
  }
  return null;
}

function pushRange(ranges, start, end) {
  if (end > start) {
    ranges.push({ start, end });
  }
}

function unwrapRazorStringBody(text, start, end) {
  if (start == null || end == null || end <= start) {
    return { start, end };
  }

  let i = start;
  while (i < end && isWs(text[i])) i += 1;
  if (i >= end) {
    return { start, end };
  }

  if (text[i] === '@' && text[i + 1] === '(') {
    const close = skipBalanced(text, i + 1, '(', ')');
    const innerEnd = Math.min(close - 1, end);
    return unwrapRazorStringBody(text, i + 2, innerEnd);
  }

  const verbLen = verbatimOpenLength(text, i);
  if (verbLen) {
    const contentStart = i + verbLen;
    const after = skipVerbatim(text, contentStart);
    return { start: contentStart, end: Math.min(after - 1, end) };
  }

  if (text[i] === '"' || text[i] === "'") {
    const after = skipQuoted(text, i);
    return { start: i + 1, end: Math.min(after - 1, end) };
  }

  let best = null;
  for (let k = i; k < end; k++) {
    const verb = verbatimOpenLength(text, k);
    if (verb) {
      const contentStart = k + verb;
      const after = skipVerbatim(text, contentStart);
      const contentEnd = Math.min(after - 1, end);
      const len = contentEnd - contentStart;
      if (!best || len > best.len) {
        best = { start: contentStart, end: contentEnd, len };
      }
      k = after - 1;
      continue;
    }
    const skipped = skipStringOrComment(text, k);
    if (skipped !== k) {
      k = skipped - 1;
    }
  }

  if (best && best.len > 0) {
    return { start: best.start, end: best.end };
  }

  return { start: i, end };
}

function unwrapAttributeContent(text, valueStart, valueEnd) {
  if (valueStart == null || valueEnd == null || valueEnd <= valueStart) {
    return { start: valueStart, end: valueEnd };
  }

  let start = valueStart;
  let end = valueEnd;
  const q = text[start];
  if (q === '"' || q === "'") {
    start += 1;
    if (end > start && text[end - 1] === q) {
      end -= 1;
    }
  }

  return unwrapRazorStringBody(text, start, end);
}

function collectAttributes(text, nameEnd, tagEndIndex) {
  const attrs = [];
  let i = nameEnd;
  const end = tagEndIndex;

  while (i < end) {
    const ch = text[i];
    if (ch === '>' || (ch === '/' && text[i + 1] === '>')) {
      break;
    }
    if (isWs(ch)) {
      i += 1;
      continue;
    }
    if (!isNameStart(ch)) {
      i += 1;
      continue;
    }

    const attrNameStart = i;
    i += 1;
    while (i < end && isNameChar(text[i])) {
      i += 1;
    }
    const attrName = text.slice(attrNameStart, i);
    const attrNameEnd = i;

    let j = i;
    while (j < end && isWs(text[j])) {
      j += 1;
    }

    if (text[j] !== '=') {
      attrs.push({
        name: attrName,
        nameStart: attrNameStart,
        nameEnd: attrNameEnd,
        valueStart: null,
        valueEnd: null,
        contentStart: null,
        contentEnd: null
      });
      continue;
    }

    j += 1;
    while (j < end && isWs(text[j])) {
      j += 1;
    }

    const valueStart = j;
    let valueEnd;
    if (text[j] === '"' || text[j] === "'") {
      valueEnd = skipQuoted(text, j);
    } else if (text[j] === '@') {
      valueEnd = skipRazorAt(text, j);
    } else {
      valueEnd = j;
      while (valueEnd < end && !isWs(text[valueEnd]) && text[valueEnd] !== '>' && text[valueEnd] !== '/') {
        valueEnd += 1;
      }
    }

    if (valueEnd <= valueStart) {
      i = j + 1;
      continue;
    }

    const content = unwrapAttributeContent(text, valueStart, valueEnd);
    attrs.push({
      name: attrName,
      nameStart: attrNameStart,
      nameEnd: attrNameEnd,
      valueStart,
      valueEnd,
      contentStart: content.start,
      contentEnd: content.end
    });
    i = valueEnd;
  }

  return attrs;
}

function scanOpeningTags(text) {
  const tags = [];
  if (!text) return tags;

  let i = 0;
  const len = text.length;
  while (i < len) {
    const skipped = skipTopLevelTrivia(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (text[i] !== '<') {
      i += 1;
      continue;
    }

    const peeked = peekTagName(text, i);
    if (!peeked) {
      i += 1;
      continue;
    }

    const tag = parseTag(text, i);
    if (!tag) {
      i += 1;
      continue;
    }

    i = tag.endIndex;
    if (tag.closing) {
      continue;
    }

    tags.push({
      startIndex: tag.startIndex,
      endIndex: tag.endIndex,
      name: tag.name,
      nameEnd: peeked.nameEnd,
      selfClosing: tag.selfClosing,
      attributes: collectAttributes(text, peeked.nameEnd, tag.endIndex)
    });
  }

  return tags;
}

module.exports = { scanOpeningTags };
