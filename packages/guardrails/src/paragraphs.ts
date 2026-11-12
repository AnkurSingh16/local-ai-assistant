/**
 * Hold-back buffer for streamed answers (ADR-0005). Text is released one unit at
 * a time so each unit can be moderated before the client sees it:
 * - at a blank line;
 * - at a sentence boundary once the paragraph passes 500 characters;
 * - a fenced code block is held whole up to 2,000 characters, and a longer one
 *   is released in chunks of at most 2,000 characters split at line boundaries.
 */
export const softParagraphChars = 500;
export const maxCodeChunkChars = 2000;

const fence = /^\s*```/;

export interface ParagraphSplitter {
  /** Adds streamed text and returns any units now complete. */
  push(text: string): string[];
  /** Returns whatever is left at the end of the stream. */
  flush(): string[];
}

function sentenceCut(text: string): number {
  // The last sentence end at or after the soft limit, followed by whitespace.
  const re = /[.!?]["')\]]?\s/g;
  let cut = -1;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (end >= softParagraphChars) {
      cut = end;
      break;
    }
  }
  return cut;
}

export function createParagraphSplitter(): ParagraphSplitter {
  let buffer = '';
  let inCode = false;

  function drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      if (inCode) {
        const lines = buffer.split('\n');
        // Find the closing fence (not the opening one at index 0).
        const close = lines.findIndex((l, i) => i > 0 && fence.test(l));
        if (close !== -1) {
          const block = lines.slice(0, close + 1).join('\n');
          if (block.length <= maxCodeChunkChars) {
            out.push(block);
            buffer = lines
              .slice(close + 1)
              .join('\n')
              .replace(/^\n+/, '');
            inCode = false;
            continue;
          }
        }
        if (buffer.length > maxCodeChunkChars || (final && buffer !== '')) {
          // Release whole lines up to the chunk limit; the block stays open.
          let size = 0;
          let count = 0;
          for (const line of lines) {
            const next = size + line.length + 1;
            if (next > maxCodeChunkChars && count > 0) break;
            size = next;
            count++;
          }
          const chunk = lines.slice(0, count).join('\n');
          const head = chunk.length > maxCodeChunkChars ? chunk.slice(0, maxCodeChunkChars) : chunk;
          out.push(head);
          buffer = buffer.slice(head.length).replace(/^\n/, '');
          if (final && buffer === '') break;
          continue;
        }
        break;
      }

      const fenceAt = buffer.search(/(^|\n)\s*```/);
      const blank = buffer.indexOf('\n\n');
      if (fenceAt !== -1 && (blank === -1 || fenceAt < blank)) {
        const start = buffer[fenceAt] === '\n' ? fenceAt + 1 : fenceAt;
        const before = buffer.slice(0, start).trim();
        if (before !== '') out.push(before);
        buffer = buffer.slice(start);
        inCode = true;
        continue;
      }
      if (blank !== -1) {
        const para = buffer.slice(0, blank).trim();
        if (para !== '') out.push(para);
        buffer = buffer.slice(blank).replace(/^\n+/, '');
        continue;
      }
      if (buffer.length >= softParagraphChars) {
        const cut = sentenceCut(buffer);
        if (cut !== -1) {
          out.push(buffer.slice(0, cut).trim());
          buffer = buffer.slice(cut);
          continue;
        }
      }
      if (final) {
        const rest = buffer.trim();
        if (rest !== '') out.push(rest);
        buffer = '';
      }
      break;
    }
    return out;
  }

  return {
    push(text: string): string[] {
      buffer += text;
      return drain(false);
    },
    flush(): string[] {
      return drain(true);
    },
  };
}
