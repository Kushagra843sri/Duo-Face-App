/**
 * Admins are the Firebase UIDs listed in ADMIN_FIREBASE_UIDS (comma separated).
 * Server-side only: there is no sign-up path, nothing a client can send, and no
 * database record to tamper with. Empty/unset = nobody is an admin.
 */
export function loadAdminUids(source: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (source.ADMIN_FIREBASE_UIDS ?? '')
      .split(',')
      .map((uid) => uid.trim())
      .filter(Boolean)
  );
}
