/**
 * DEVELOPMENT-ONLY UI preview (not authentication).
 *
 * Active only when BOTH hold: the JS bundle is a development build
 * (`__DEV__`) AND `EXPO_PUBLIC_UI_PREVIEW` is exactly "merchant" or
 * "driver". In a production build `__DEV__` is false, so this is always
 * null and the preview code paths are unreachable. In preview mode the app
 * makes NO network calls (api/client.ts serves lib/previewData.ts instead),
 * signs nobody in to anything, and talks to neither Firebase nor the server.
 * The role comes from the env flag at build time — there is no role picker.
 */
export type PreviewRole = 'merchant' | 'driver';

function resolvePreviewRole(): PreviewRole | null {
  if (!__DEV__) return null;
  // Tolerate stray quotes/whitespace/case from hand-edited .env files.
  const flag = process.env.EXPO_PUBLIC_UI_PREVIEW?.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  return flag === 'merchant' || flag === 'driver' ? flag : null;
}

export const previewRole: PreviewRole | null = resolvePreviewRole();
