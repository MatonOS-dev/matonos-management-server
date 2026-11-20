// SPDX-License-Identifier: GPL-2.0-only
export function spamText(value: string) {
  return /(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value);
}
