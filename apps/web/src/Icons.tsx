import type { ReactElement } from 'react';

/**
 * Small inline icons. Inline SVG keeps the strict Content Security Policy
 * (images only from this origin) and needs no icon font. Decorative: every
 * button that uses one also has a text label or an aria-label.
 */
function Icon({ d, size = 18 }: { readonly d: string; readonly size?: number }): ReactElement {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

export const SendIcon = (): ReactElement => <Icon d="M12 19V5M5 12l7-7 7 7" />;
export const StopIcon = (): ReactElement => (
  <svg className="icon" width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
  </svg>
);
export const PlusIcon = (): ReactElement => <Icon d="M12 5v14M5 12h14" />;
export const BrainIcon = (): ReactElement => (
  <Icon d="M9.5 2a2.5 2.5 0 0 0-2.45 2A3 3 0 0 0 4 7v.5A3 3 0 0 0 3 13a3 3 0 0 0 2 2.83V16a3 3 0 0 0 4.5 2.6A2.5 2.5 0 0 0 12 21V4.5A2.5 2.5 0 0 0 9.5 2Zm5 0A2.5 2.5 0 0 1 16.95 4 3 3 0 0 1 20 7v.5a3 3 0 0 1 1 5.5 3 3 0 0 1-2 2.83V16a3 3 0 0 1-4.5 2.6A2.5 2.5 0 0 1 12 21" />
);
export const LockIcon = (): ReactElement => (
  <Icon size={13} d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" />
);
export const CloseIcon = (): ReactElement => <Icon d="M6 6l12 12M18 6 6 18" />;
export const RetryIcon = (): ReactElement => (
  <Icon size={15} d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
);
export const MessageIcon = (): ReactElement => (
  <Icon size={15} d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
);
export const LinkIcon = (): ReactElement => (
  <Icon
    size={13}
    d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"
  />
);
export const ShieldIcon = (): ReactElement => (
  <Icon size={16} d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />
);

/** The assistant's mark: a soft gradient orb, also used as its avatar. */
export function Mark({ size = 28 }: { readonly size?: number }): ReactElement {
  return (
    <span className="mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
