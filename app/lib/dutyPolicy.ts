/**
 * Pure rules for the on-duty location feed (docs/decisions/027), kept free of
 * React / native modules so they can be unit-tested once the app has a test
 * framework.
 */

/** One location a minute while on duty. */
export const DUTY_UPDATE_INTERVAL_MS = 60_000;

/**
 * The OS may deliver slightly early or in a batch; never send twice within
 * this window. Slightly under the interval so a normal tick is never skipped.
 */
export const DUTY_MIN_SEND_GAP_MS = 55_000;

/**
 * Looser than live tracking's 100 m: a driver waiting indoors often only gets
 * a coarse fix, and skipping it would make them look absent and drop out of
 * dispatch. Beyond this the fix is noise.
 */
export const DUTY_MAX_ACCURACY_METERS = 300;

export function shouldSendDutyFix(fix: { accuracy?: number | null }, lastSentAt: number | null, now: number): boolean {
  if (typeof fix.accuracy === 'number' && fix.accuracy > DUTY_MAX_ACCURACY_METERS) return false;
  if (lastSentAt !== null && now - lastSentAt < DUTY_MIN_SEND_GAP_MS) return false;
  return true;
}

export type DutyState = 'off' | 'on' | 'paused';

/**
 * What the app should do on launch/focus, given what the server believes and
 * what the device is actually doing.
 *  - server off, device still sending -> stop the stale task
 *  - server on, device not sending (reboot / force-quit) -> resume if the
 *    permissions are still there, else show "paused" so the driver can fix it
 */
export function decideReconcile(input: {
  serverOnDuty: boolean;
  taskRunning: boolean;
  hasBackgroundPermission: boolean;
}): { state: DutyState; action: 'none' | 'stop-task' | 'start-task' } {
  if (!input.serverOnDuty) {
    return { state: 'off', action: input.taskRunning ? 'stop-task' : 'none' };
  }
  if (input.taskRunning) return { state: 'on', action: 'none' };
  return input.hasBackgroundPermission ? { state: 'on', action: 'start-task' } : { state: 'paused', action: 'none' };
}
