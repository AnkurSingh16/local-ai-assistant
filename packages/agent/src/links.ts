/**
 * ADR-0003: the answer may link only to entries in the citation list. A link
 * anywhere else could carry conversation text to a host in its query string,
 * so it is unwrapped (Markdown) or removed (a bare URL) before the paragraph
 * is checked and released.
 */
const markdownLink = /\[([^\]\n]{0,300})\]\((\S{1,2048}?)\)/g;
const bareUrl = /\bhttps?:\/\/[^\s<>()\]]{1,2048}/g;

/** Trailing punctuation belongs to the sentence, not the URL. */
const trailing = /[.,;:!?'"]+$/;

export function keepListedLinks(text: string, listed: ReadonlySet<string>): string {
  const kept = text.replace(markdownLink, (whole, label: string, url: string) =>
    listed.has(url) ? whole : label,
  );
  return kept.replace(bareUrl, (url) => {
    const bare = url.replace(trailing, '');
    return listed.has(bare) ? url : `[link removed]${url.slice(bare.length)}`;
  });
}

/** Citation numbers such as [1] or [2][3], in order of first appearance. */
export function citationsIn(text: string): number[] {
  const seen: number[] = [];
  for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && !seen.includes(n)) seen.push(n);
  }
  return seen;
}
