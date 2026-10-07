import { Check, KeyRound, Phone } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Modal, Text, TextInput, View } from 'react-native';

import { deliverDriverAssignment, getCustomerContact } from '@/api/driver';
import { ApiError } from '@/api/errors';
import { describeError } from '@/components/ErrorState';
import { Button, Muted, usePalette } from '@/components/ui';
import { useDeliveryProximity } from '@/hooks/useDeliveryProximity';
import { showAlert } from '@/lib/alerts';
import { canCallCustomer, canMarkDelivered, describeProximity } from '@/lib/deliveryProximity';
import type { Point } from '@/lib/deliveryProximity';
import { getFreshDeliveryFix } from '@/lib/locationService';
import { previewRole } from '@/lib/preview';

interface Props {
  assignmentId: string;
  /** From the order DTO; absent when the server could not resolve the address. */
  destination?: Point;
  /** Called after the server accepted the delivery. */
  onDelivered: () => void;
}

/** Preview mode has no GPS: build a fix `meters` north of the destination. */
function previewFix(destination: Point, meters: number) {
  return { latitude: destination.latitude + meters / 111_195, longitude: destination.longitude, accuracyMeters: 8 };
}

/**
 * Proof of delivery (docs/decisions/028): "Mark delivered" is enabled only
 * within 50 m of the customer (a UI hint — the server re-checks the fresh fix
 * sent at tap time). When the driver is at the door but outside 50 m (the
 * address is geocoded, so it can be off), the customer's 6-digit code
 * finishes the delivery instead.
 */
export function DeliveryProofPanel({ assignmentId, destination, onDelivered }: Props) {
  const palette = usePalette();
  const proximity = useDeliveryProximity(destination, true);
  const [busy, setBusy] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [callNumber, setCallNumber] = useState<string | null>(null);
  const [callBusy, setCallBusy] = useState(false);

  const near = canMarkDelivered(proximity.distanceMeters, proximity.accuracyMeters);
  // Only within ~300 m of the delivery location; the server re-checks with a fresh fix before giving out the number.
  const nearForCall = !!destination && canCallCustomer(proximity.distanceMeters, proximity.accuracyMeters);

  function showFailure(error: unknown) {
    if (error instanceof ApiError && (error.status === 409 || error.status === 423)) {
      showAlert('Cannot mark delivered yet', error.message);
    } else {
      const { title, description } = describeError(error);
      showAlert(title, description);
    }
  }

  async function markDelivered() {
    if (busy || !destination) return;
    setBusy(true);
    try {
      const location =
        previewRole && proximity.distanceMeters !== null
          ? previewFix(destination, proximity.distanceMeters)
          : await getFreshDeliveryFix(); // a fresh fix at tap time, not the cached watcher value
      await deliverDriverAssignment(assignmentId, { location });
      onDelivered();
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function openCallOption() {
    if (callBusy || !destination) return;
    setCallBusy(true);
    try {
      const location =
        previewRole && proximity.distanceMeters !== null
          ? previewFix(destination, proximity.distanceMeters)
          : await getFreshDeliveryFix();
      const { phoneNumber } = await getCustomerContact(assignmentId, location);
      setCallNumber(phoneNumber);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) showAlert('Cannot call yet', error.message);
      else {
        const { title, description } = describeError(error);
        showAlert(title, description);
      }
    } finally {
      setCallBusy(false);
    }
  }

  async function dial() {
    if (!callNumber) return;
    const url = `tel:${callNumber}`;
    setCallNumber(null);
    try {
      await Linking.openURL(url);
    } catch {
      showAlert('Cannot place the call', 'This phone could not open the dialer.');
    }
  }

  async function submitCode() {
    if (busy) return;
    if (!/^\d{6}$/.test(code)) {
      setCodeError('Enter the 6-digit code.');
      return;
    }
    setBusy(true);
    setCodeError(null);
    try {
      await deliverDriverAssignment(assignmentId, { otp: code });
      setCodeOpen(false);
      setCode('');
      onDelivered();
    } catch (error) {
      // Wrong code / locked / unavailable: shown in the dialog, with attempts left.
      setCodeError(error instanceof ApiError ? error.message : describeError(error).title);
    } finally {
      setBusy(false);
    }
  }

  const hint = !destination
    ? 'The delivery location could not be found. Ask the customer for their delivery code.'
    : proximity.status === 'denied'
      ? 'Location permission is needed to confirm you are at the delivery address.'
      : describeProximity(proximity.distanceMeters, proximity.accuracyMeters);

  return (
    <>
      <Text className={near ? 'text-center text-sm font-semibold text-green-600' : 'text-center text-sm font-semibold text-muted dark:text-muted-dark'}>{hint}</Text>

      <Button label="Mark delivered" icon={Check} disabled={!near || !destination} loading={busy && !codeOpen} onPress={markDelivered} />
      {nearForCall ? <Button label="Call customer" icon={Phone} variant="secondary" loading={callBusy} onPress={openCallOption} /> : null}
      <Button label="Enter customer code" icon={KeyRound} variant="secondary" small disabled={busy} onPress={() => setCodeOpen(true)} />

      {previewRole && proximity.simulateArrival ? (
        <Button label="Preview: simulate arriving at the door" variant="ghost" small onPress={proximity.simulateArrival} />
      ) : null}

      <Modal visible={callNumber !== null} transparent animationType="fade" onRequestClose={() => setCallNumber(null)}>
        <View className="flex-1 items-center justify-end bg-black/50 p-4">
          <View className="w-full gap-4 rounded-3xl bg-surface p-5 dark:bg-surface-dark">
            <Text className="text-lg font-extrabold text-ink dark:text-ink-dark">Call the customer</Text>
            <Muted>You are near the delivery location. This opens the dialer on this phone to call the customer.</Muted>
            <View className="gap-2">
              <Button label="Call customer" icon={Phone} onPress={dial} />
              <Button label="Cancel" variant="ghost" onPress={() => setCallNumber(null)} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={codeOpen} transparent animationType="fade" onRequestClose={() => setCodeOpen(false)}>
        <View className="flex-1 items-center justify-end bg-black/50 p-4">
          <View className="w-full gap-4 rounded-3xl bg-surface p-5 dark:bg-surface-dark">
            <Text className="text-lg font-extrabold text-ink dark:text-ink-dark">Customer code</Text>
            <Muted>Ask the customer for the 6-digit delivery code shown in their app.</Muted>
            <TextInput
              value={code}
              onChangeText={(text) => {
                setCode(text.replace(/\D/g, '').slice(0, 6));
                setCodeError(null);
              }}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
              placeholder="······"
              placeholderTextColor={palette.muted}
              className="h-14 rounded-2xl border border-line bg-canvas px-4 text-center text-2xl font-extrabold tracking-widest text-ink dark:border-line-dark dark:bg-canvas-dark dark:text-ink-dark"
            />
            {codeError ? <Text className="text-sm font-medium text-red-600">{codeError}</Text> : null}
            <View className="gap-2">
              <Button label="Confirm delivery" loading={busy} onPress={submitCode} />
              <Button label="Cancel" variant="ghost" onPress={() => setCodeOpen(false)} />
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
