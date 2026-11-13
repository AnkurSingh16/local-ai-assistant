import { toBlocks } from '@local-ai/client';
import type { ReactElement } from 'react';

export function Answer({ text }: { readonly text: string }): ReactElement {
  return (
    <div className="answer">
      {toBlocks(text).map((block, i) =>
        block.kind === 'code' ? (
          <pre key={i}>
            <code>{block.content}</code>
          </pre>
        ) : (
          <p key={i}>{block.content}</p>
        ),
      )}
    </div>
  );
}
