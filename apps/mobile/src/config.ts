/**
 * The API address. Expo inlines EXPO_PUBLIC_ variables at build time, so a phone
 * on the same Wi-Fi is pointed at the Mac with, for example,
 * EXPO_PUBLIC_API_URL=http://192.168.1.20:8787 npm run dev:mobile (ADR-0010).
 */
const configured: unknown = process.env.EXPO_PUBLIC_API_URL;
export const apiBaseUrl =
  typeof configured === 'string' && configured !== '' ? configured : 'http://127.0.0.1:8787';
