#!/usr/bin/env node

const { readFileSync, statSync } = require('node:fs');
const { inflateRawSync } = require('node:zlib');

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;

const [, , filePath, extension, maxOutputRaw] = process.argv;
const maxOutputBytes = Number(maxOutputRaw);
if (!filePath || !['.docx', '.xlsx'].includes(extension) || !Number.isSafeInteger(maxOutputBytes)) {
  throw new Error('usage: extract-office-text.js <path> <.docx|.xlsx> <max-output-bytes>');
}

const prefixes =
  extension === '.docx' ? ['word/document.xml'] : ['xl/sharedStrings.xml', 'xl/worksheets/'];
const entries = readOfficeEntries(filePath, prefixes);
const text = extension === '.docx' ? extractDocxText(entries) : extractXlsxText(entries);
process.stdout.write(truncateUtf8(text, maxOutputBytes));

function readOfficeEntries(path, wantedPrefixes) {
  if (statSync(path).size > MAX_ARCHIVE_BYTES) {
    throw new Error('Office attachment is too large');
  }
  const archive = readFileSync(path);
  const endOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error('Office attachment has too many entries');
  }
  const result = new Map();
  let cursor = centralOffset;
  let extractedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    requireSignature(archive, cursor, 0x02014b50, 'central directory');
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
    cursor = nameStart + nameLength + extraLength + commentLength;
    if (!wantedPrefixes.some((prefix) => name === prefix || name.startsWith(prefix))) {
      continue;
    }
    if ((flags & 0x1) !== 0) {
      throw new Error('Encrypted Office attachments are not supported');
    }
    extractedBytes += uncompressedSize;
    if (extractedBytes > MAX_ARCHIVE_BYTES) {
      throw new Error('Office attachment expands too far');
    }
    requireSignature(archive, localOffset, 0x04034b50, 'local file header');
    const nameSize = archive.readUInt16LE(localOffset + 26);
    const extraSize = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + nameSize + extraSize;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const data =
      method === 0
        ? compressed
        : method === 8
          ? inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES })
          : unsupportedCompression(method);
    if (data.length !== uncompressedSize) {
      throw new Error('Corrupt Office entry');
    }
    result.set(name, data.toString('utf8'));
  }
  return result;
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let cursor = archive.length - 22; cursor >= minimumOffset; cursor -= 1) {
    if (archive.readUInt32LE(cursor) === 0x06054b50) {
      return cursor;
    }
  }
  throw new Error('Invalid Office attachment: ZIP directory not found');
}

function requireSignature(archive, offset, expected, label) {
  if (offset < 0 || offset + 4 > archive.length || archive.readUInt32LE(offset) !== expected) {
    throw new Error(`Invalid Office attachment ${label}`);
  }
}

function unsupportedCompression(method) {
  throw new Error(`Unsupported Office compression method: ${method}`);
}

function extractDocxText(entries) {
  const xml = entries.get('word/document.xml');
  if (!xml) {
    throw new Error('Invalid DOCX attachment: word/document.xml is missing');
  }
  return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map((match) => extractXmlText(match[1], 'w:t'))
    .filter(Boolean)
    .join('\n');
}

function extractXlsxText(entries) {
  const sharedXml = entries.get('xl/sharedStrings.xml') || '';
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    extractXmlText(match[1], 't')
  );
  const sheets = [...entries.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet[^/]*\.xml$/.test(name))
    .sort(([left], [right]) => left.localeCompare(right));
  if (sheets.length === 0) {
    throw new Error('Invalid XLSX attachment: no worksheets found');
  }
  const lines = [];
  for (const [name, xml] of sheets) {
    lines.push(`[${name.slice(name.lastIndexOf('/') + 1, -4)}]`);
    for (const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const reference = readXmlAttribute(cell[1], 'r') || '?';
      const type = readXmlAttribute(cell[1], 't');
      const raw = firstXmlTagText(cell[2], 'v');
      const value =
        type === 's'
          ? shared[Number(raw)] || ''
          : type === 'inlineStr'
            ? extractXmlText(cell[2], 't')
            : decodeXmlEntities(raw);
      if (value) {
        lines.push(`${reference}=${value}`);
      }
    }
  }
  return lines.join('\n');
}

function extractXmlText(xml, tagName) {
  const tag = tagName.replace(':', '\\:');
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'))]
    .map((match) => decodeXmlEntities(match[1]))
    .join('');
}

function firstXmlTagText(xml, tagName) {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`).exec(xml);
  return match ? decodeXmlEntities(match[1]) : '';
}

function readXmlAttribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  return match ? match[1] || match[2] : undefined;
}

function decodeXmlEntities(value) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

function truncateUtf8(content, maxBytes) {
  const bytes = Buffer.from(content);
  if (bytes.length <= maxBytes) {
    return content;
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${bytes.subarray(0, end).toString('utf8')}\n\n[Truncated at ${maxBytes} bytes]`;
}
