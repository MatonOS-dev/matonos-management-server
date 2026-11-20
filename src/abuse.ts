import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), 'data');
let words: Set<string> | undefined;
const leet: Record<string, string> = { '0':'o', '1':'i', '3':'e', '4':'a', '5':'s', '7':'t', '@':'a', '$':'s' };

async function wordList() {
  if (words) return words;
  const set = new Set<string>();
  for (const file of await readdir(dataDir)) {
    if (!file.endsWith('.txt')) continue;
    for (const raw of (await readFile(resolve(dataDir, file), 'utf8')).split(/\r?\n/)) {
      const word = normalize(raw);
      if (word.length >= 2) set.add(word);
    }
  }
  // The upstream lists are intentionally maintained as-is; this supplements common variants.
  for (const word of ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot']) set.add(word);
  words = set;
  return set;
}

function normalize(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[013457@$]/g, (char) => leet[char])
    .replace(/(.)\1{1,}/gu, '$1');
}

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
