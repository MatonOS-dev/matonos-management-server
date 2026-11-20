// SPDX-License-Identifier: GPL-2.0-only
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), 'data');
let words: Promise<Set<string>> | undefined;

async function wordList() {
  words ??= readFile(resolve(dataDir, 'en.txt'), 'utf8').then((contents) =>
    new Set(contents.split(/\r?\n/).map(normalize).filter((word) => word.length >= 2))
  );
  return words;
}

function normalize(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/(.)\1{1,}/gu, '$1');
}

// Match complete normalized words or phrases. Token boundaries avoid hits such
// as “classic”, “Scunthorpe”, or “assessment” when a short entry is embedded.
export async function textRejected(value: string) {
  const list = await wordList();
  const tokens = normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  for (let start = 0; start < tokens.length; start++) {
    let joined = '';
    for (let end = start; end < Math.min(tokens.length, start + 8); end++) {
      joined += tokens[end];
      if (joined.length > 32) break;
      if (list.has(joined)) return true;
    }
  }
  return false;
}

export function spamText(value: string) {
  return /(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value);
}
