/**
 * The web app's light palette (apps/web/src/styles.css), so both clients look
 * like one product. The app is light-only for now. Text colours meet WCAG AA on
 * the backgrounds they are used on.
 */
export const colors = {
  bg: '#f6f6f8',
  surface: '#ffffff',
  surface2: '#f0f0f4',
  text: '#16161a',
  muted: '#5d5d6b',
  line: '#e3e3ea',
  accent: '#5b4cf0',
  accentSoft: '#ecebfe',
  onAccent: '#ffffff',
  link: '#4b3cd6',
  warnBg: '#fff6e6',
  warnText: '#7a4b00',
  warnLine: '#f5d9a8',
  errBg: '#fdecec',
  errText: '#8c1d18',
  errLine: '#f4c2bf',
  danger: '#b3261e',
  codeBg: '#f3f3f7',
} as const;

/** A soft card shadow; iOS reads the shadow props, Android the elevation. */
export const shadow = {
  shadowColor: '#101018',
  shadowOpacity: 0.08,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 2,
} as const;

export const radius = 16;
