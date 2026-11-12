/**
 * Hold-back buffer for streamed answers (ADR-0005). The answer is released one
 * unit at a time so each unit can be moderated before the client sees it:
 * - prose at a blank line;
 * - prose at a sentence end once the unit passes 500 characters, and at the
 *   last whitespace before 2,000 characters if no sentence ends by then;
 * - a fenced code block (``` or ~~~) whole, up to 2,000 characters; a longer
 *   block in chunks of whole lines of at most 2,000 characters.
 *
 * Units are slices of the stream that keep their trailing line breaks, so
 * concatenating them in order rebuilds the answer. Blank lines that would start
 * a unit are dropped, since they carry nothing to moderate or show. Every unit has at most
 * `maxUnitChars` characters, which keeps each guard call well inside its context.
 */
export const softParagraphChars = 500;
export const maxUnitChars = 2000;

export interface ParagraphSplitter {
  /** Adds streamed text and returns any units now complete. */
  push(text: string): string[];
  /** Returns whatever is left at the end of the stream. */
  flush(): string[];
}

interface Fence {
  readonly char: '`' | '~';
  readonly length: number;
}

const fenceLine = /^ {0,3}(`{3,}|~{3,})/;

function openingFence(line: string): Fence | undefined {
  const m = fenceLine.exec(line);
  const run = m?.[1];
  if (run === undefined) return undefined;
  // A backtick fence's info string may not contain backticks (CommonMark).
  if (run.startsWith('`') && line.slice(m?.[0].length).includes('`')) return undefined;
  return { char: run.startsWith('`') ? '`' : '~', length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  const run = m?.[1];
  return run !== undefined && run.startsWith(fence.char) && run.length >= fence.length;
}

/** End of the first sentence that ends at or after the soft limit, including its trailing whitespace. */
function sentenceCut(text: string): number {
  const re = /[.!?]["')\]]?\s+/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (end >= softParagraphChars && end <= maxUnitChars) return end;
    if (end > maxUnitChars) return -1;
  }
  return -1;
}

/** Last position before the limit just after whitespace, or the limit itself. */
function hardCut(text: string, preferLineEnd: boolean): number {
  const window = text.slice(0, maxUnitChars);
  const at = preferLineEnd
    ? window.lastIndexOf('\n')
    : Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
  return at > 0 ? at + 1 : maxUnitChars;
}

export function createParagraphSplitter(): ParagraphSplitter {
  let buffer = '';
  // Offset up to which complete lines of `buffer` have been examined.
  let scanned = 0;
  let fence: Fence | undefined;

  function emit(out: string[], end: number): void {
    const unit = buffer.slice(0, end);
    buffer = buffer.slice(end);
    scanned = Math.max(0, scanned - end);
    // A whitespace-only run carries nothing to moderate or show, so it is dropped.
    if (unit.trim() !== '') out.push(unit);
  }

  function drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const nl = buffer.indexOf('\n', scanned);
      if (nl !== -1) {
        const line = buffer.slice(scanned, nl);
        const lineEnd = nl + 1;
        if (fence === undefined) {
          const opening = openingFence(line);
          if (opening !== undefined) {
            const start = scanned;
            fence = opening;
            if (buffer.slice(0, start).trim() !== '') {
              emit(out, start);
              scanned = lineEnd - start;
            } else {
              scanned = lineEnd;
            }
            continue;
          }
          if (line.trim() === '') {
            // A blank line ends a paragraph; blank lines before any content are dropped.
            emit(out, lineEnd);
            continue;
          }
          scanned = lineEnd;
        } else {
          if (closesFence(line, fence)) {
            let end = lineEnd;
            while (end > maxUnitChars) {
              const cut = hardCut(buffer, true);
              emit(out, cut);
              end -= cut;
            }
            fence = undefined;
            emit(out, end);
            continue;
          }
          scanned = lineEnd;
        }
        // Cut inside the examined lines until they fit; unexamined text may still close a fence.
        while (scanned > maxUnitChars) emit(out, hardCut(buffer, fence !== undefined));
        continue;
      }

      // No complete line left to examine: apply the length cuts to what is buffered.
      if (fence === undefined && buffer.length >= softParagraphChars) {
        const cut = sentenceCut(buffer);
        if (cut !== -1) {
          emit(out, cut);
          continue;
        }
      }
      if (buffer.length > maxUnitChars) {
        emit(out, hardCut(buffer, fence !== undefined));
        continue;
      }
      if (final && buffer.trim() !== '') {
        out.push(buffer);
        buffer = '';
        scanned = 0;
      }
      return out;
    }
  }

  return {
    push(text: string): string[] {
      buffer += text;
      return drain(false);
    },
    flush(): string[] {
      const out = drain(true);
      buffer = '';
      scanned = 0;
      fence = undefined;
      return out;
    },
  };
}
