export interface Block {
  readonly kind: 'code' | 'text';
  readonly content: string;
}

/**
 * Splits the answer into fenced code blocks and paragraphs. Rendering is plain
 * text only: no HTML, no links and never images, which are the classic way to
 * leak data from a chat (ADR-0003). React and React Native escape everything.
 * Shared so both apps split answers the same way.
 */
export function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let prose: string[] = [];
  let code: string[] | null = null;
  let fence = '';
  const flushProse = (): void => {
    for (const para of prose.join('\n').split(/\n\s*\n/)) {
      if (para.trim() !== '') blocks.push({ kind: 'text', content: para.trim() });
    }
    prose = [];
  };
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (code === null && marker !== undefined) {
      flushProse();
      code = [];
      fence = marker;
    } else if (
      code !== null &&
      marker !== undefined &&
      marker.startsWith(fence.charAt(0)) &&
      marker.length >= fence.length &&
      line.trim() === marker
    ) {
      blocks.push({ kind: 'code', content: code.join('\n') });
      code = null;
    } else if (code !== null) {
      code.push(line);
    } else {
      prose.push(line);
    }
  }
  if (code !== null) blocks.push({ kind: 'code', content: code.join('\n') });
  flushProse();
  return blocks;
}
