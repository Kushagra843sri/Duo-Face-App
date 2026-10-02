import { PhoneCall } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Text } from 'react-native';

import { callCustomer } from '@/api/driver';
import { ApiError } from '@/api/errors';
import { describeError } from '@/components/ErrorState';
import { Button, Muted, SectionCard } from '@/components/ui';

/** After a call is requested, wait this long before allowing another tap (the phone is about to ring). */
const COOLDOWN_MS = 20_000;

/**
 * Masked call to the customer (docs/decisions/028). The driver never sees the
 * customer's number: the server asks the telephony provider to ring the
 * driver first, then connect the customer. The customer sees only the
 * company's number.
 */
export function CallCustomerCard({ assignmentId }: { assignmentId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [cooldown, setCooldown] = useState(false);
  const busyRef = useRef(false);

  async function placeCall() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await callCustomer(assignmentId);
      setMessage({ kind: 'info', text: 'Answer the incoming call from Duo-Face. You will be connected to the customer.' });
      setCooldown(true);
      setTimeout(() => setCooldown(false), COOLDOWN_MS);
    } catch (error) {
      // 409 (no phone on profile / not in progress), 429 (limit), 503 (not available): the server's message is driver-safe.
      setMessage({ kind: 'error', text: error instanceof ApiError ? error.message : describeError(error).title });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <SectionCard title="Customer" icon={PhoneCall}>
      <Muted>The customer number stays private. We call you first, then connect you.</Muted>
      <Button label="Call customer" icon={PhoneCall} variant="secondary" loading={busy} disabled={cooldown} onPress={placeCall} />
      {message ? (
        <Text className={`text-sm font-medium ${message.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{message.text}</Text>
      ) : null}
    </SectionCard>
  );
}
