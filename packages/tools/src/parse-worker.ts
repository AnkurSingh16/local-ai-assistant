// Runs in a worker thread (ADR-0008), so a hostile page can only exhaust this
// worker's memory and time, never the API's. Erasable TypeScript only: Node
// strips the types when it loads this file directly from source.
import { parentPort, workerData } from 'node:worker_threads';

import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { z } from 'zod';

const inputSchema = z.object({
  body: z.string(),
  url: z.string(),
  contentType: z.string(),
  maxChars: z.number().int().positive(),
});

const squash = (text: string): string =>
  text
    .replace(/[ \t\f\v\u00A0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function parse(input: z.infer<typeof inputSchema>): { title: string; text: string } {
  if (input.contentType === 'text/plain') {
    return { title: '', text: squash(input.body).slice(0, input.maxChars) };
  }
  // No scripts and no subresources: jsdom's defaults, stated so a change is deliberate.
  const dom = new JSDOM(input.body, {
    url: input.url,
    runScripts: undefined,
    resources: undefined,
    virtualConsole: new VirtualConsole(),
  });
  // Script, style and template text is never page content, so it cannot reach
  // the model even through the fallback below.
  for (const node of dom.window.document.querySelectorAll('script, style, noscript, template')) {
    node.remove();
  }
  const article = new Readability(dom.window.document).parse();
  const title = squash(article?.title ?? dom.window.document.title).slice(0, 200);
  const text = squash(article?.textContent ?? dom.window.document.body.textContent);
  dom.window.close();
  return { title, text: text.slice(0, input.maxChars) };
}

// Loading jsdom takes longer than parsing a page; the parent starts the parse
// timer only once this arrives, so start-up does not eat the 2-second budget.
parentPort?.postMessage({ ready: true });
try {
  parentPort?.postMessage({ ok: true, ...parse(inputSchema.parse(workerData)) });
} catch {
  parentPort?.postMessage({ ok: false });
}
