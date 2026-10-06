import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { Banknote, Camera, FileText, IdCard, MapPin, ShieldCheck, Store, Truck, User } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { decideVerification, getVerification } from '@/api/admin';
import type { VerificationDetail, VerificationKind, VerificationSection } from '@/api/admin';
import { ApiError } from '@/api/client';
import type { BankView, DriverProfile, MerchantProfile, VerificationStatus } from '@/api/profile';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Badge, Button, InfoRow, Muted, Screen, SectionCard, usePalette } from '@/components/ui';
import type { Tone } from '@/constants/theme';
import { useApiResource } from '@/hooks/useApiResource';
import { confirmAlert } from '@/lib/alerts';

const STATUS: Record<VerificationStatus, { label: string; tone: Tone }> = {
  incomplete: { label: 'Incomplete', tone: 'neutral' },
  pending_review: { label: 'To review', tone: 'warn' },
  verified: { label: 'Verified', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

const SECTION_LABEL: Record<VerificationSection, string> = { kyc: 'KYC', bank: 'Bank details' };

function Photo({ uri, label }: { uri: string | null; label: string }) {
  if (!uri) return <Muted>{label}: not provided</Muted>;
  return (
    <View className="gap-1">
      <Muted>{label}</Muted>
      <Image source={{ uri }} style={{ width: '100%', height: 220, borderRadius: 16 }} contentFit="cover" accessibilityLabel={label} />
    </View>
  );
}

function BankCard({ bank }: { bank: BankView | null }) {
  return (
    <SectionCard title="Bank details" icon={Banknote}>
      {bank ? (
        <>
          <InfoRow label="Account holder" value={bank.accountHolderName} />
          <InfoRow label="Account" value={bank.accountMasked ?? '-'} />
          <InfoRow label="IFSC" value={bank.ifsc} />
          {bank.bankName ? <InfoRow label="Bank" value={bank.bankName} /> : null}
          {bank.upiId ? <InfoRow label="UPI" value={bank.upiId} /> : null}
        </>
      ) : (
        <Muted>Not provided.</Muted>
      )}
    </SectionCard>
  );
}

function DriverDetails({ p, licenceExpired }: { p: DriverProfile; licenceExpired: boolean }) {
  return (
    <>
      <SectionCard title="Personal" icon={User}>
        {p.personal ? (
          <>
            <InfoRow label="Name" value={p.personal.fullName} />
            <InfoRow label="Phone" value={p.personal.contactPhone} />
            <InfoRow label="Date of birth" value={p.personal.dateOfBirth} />
            <InfoRow label="Address" value={`${p.personal.address.line1}, ${p.personal.address.city} ${p.personal.address.pincode}`} />
            <InfoRow label="Emergency contact" value={`${p.personal.emergencyContact.name} (${p.personal.emergencyContact.phone})`} />
          </>
        ) : (
          <Muted>Not provided.</Muted>
        )}
      </SectionCard>
      <SectionCard title="Identity & licence" icon={IdCard}>
        <InfoRow label="Aadhaar" value={p.identity.aadhaarMasked ?? '-'} />
        <InfoRow label="PAN" value={p.identity.panMasked ?? '-'} />
        <InfoRow label="Licence" value={p.identity.licenceMasked ?? '-'} />
        <InfoRow label="Licence expiry" value={p.identity.licenceExpiry ?? '-'} />
        {licenceExpired ? <Badge label="Licence has expired: this cannot be approved" tone="danger" /> : null}
        <Muted>Full numbers are never shown; they stay encrypted on the server.</Muted>
      </SectionCard>
      <SectionCard title="Vehicle" icon={Truck}>
        {p.vehicle ? (
          <>
            <InfoRow label="Type" value={p.vehicle.type} />
            <InfoRow label="Registration" value={p.vehicle.registrationNumber} />
            {p.vehicle.makeModel ? <InfoRow label="Make / model" value={p.vehicle.makeModel} /> : null}
          </>
        ) : (
          <Muted>Not provided.</Muted>
        )}
      </SectionCard>
      <SectionCard title="Live photos" icon={Camera}>
        <Photo uri={p.photos.selfieUrl} label="Selfie" />
        <Photo uri={p.photos.vehicleUrl} label="Vehicle" />
        <Muted>Photo links expire after a few minutes; reopen this page for fresh ones.</Muted>
      </SectionCard>
      <BankCard bank={p.bank} />
    </>
  );
}

function MerchantDetails({ p }: { p: MerchantProfile }) {
  return (
    <>
      <SectionCard title="Shop & owner" icon={Store}>
        {p.personal ? (
          <>
            <InfoRow label="Shop" value={p.personal.shopName} />
            <InfoRow label="Owner" value={p.personal.ownerName} />
            <InfoRow label="Phone" value={p.personal.contactPhone} />
            {p.personal.email ? <InfoRow label="Email" value={p.personal.email} /> : null}
            <InfoRow label="Address" value={`${p.personal.address.line1}, ${p.personal.address.city} ${p.personal.address.pincode}`} />
          </>
        ) : (
          <Muted>Not provided.</Muted>
        )}
        {p.pickupLocation ? (
          <InfoRow label="Pickup point" value={`${p.pickupLocation.latitude.toFixed(5)}, ${p.pickupLocation.longitude.toFixed(5)}`} />
        ) : null}
      </SectionCard>
      <SectionCard title="Tax & licences" icon={FileText}>
        <InfoRow label="PAN" value={p.identity.panMasked ?? '-'} />
        <InfoRow label="GSTIN" value={p.identity.gstin ?? '-'} />
        <InfoRow label="FSSAI" value={p.identity.fssai ?? '-'} />
        <Muted>The PAN is shown masked; the full number stays encrypted on the server.</Muted>
      </SectionCard>
      {p.photoUrl ? (
        <SectionCard title="Shop photo (optional)" icon={MapPin}>
          <Photo uri={p.photoUrl} label="Shop" />
        </SectionCard>
      ) : null}
      <BankCard bank={p.bank} />
    </>
  );
}

/** Approve / reject one section. Reject first asks for a reason the person will read. */
function DecisionBlock({
  section,
  status,
  busy,
  onApprove,
  onReject,
  disabledReason,
}: {
  section: VerificationSection;
  status: VerificationStatus;
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
  disabledReason: string | null;
}) {
  const palette = usePalette();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <SectionCard title={`Decision: ${SECTION_LABEL[section]}`} icon={ShieldCheck}>
      <Badge label={STATUS[status].label} tone={STATUS[status].tone} />
      {status !== 'pending_review' ? (
        <Muted>{status === 'verified' ? 'Already verified.' : status === 'rejected' ? 'Rejected. The person has been told why and can resubmit.' : 'Not submitted yet.'}</Muted>
      ) : rejecting ? (
        <View className="gap-2">
          <Text className="text-sm font-semibold text-ink dark:text-ink-dark">Reason (the person will read this)</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. The PAN photo is blurry. Please upload a clear one."
            placeholderTextColor={palette.muted}
            multiline
            maxLength={200}
            textAlignVertical="top"
            className="min-h-24 rounded-2xl border border-line bg-surface p-3 text-base text-ink dark:border-line-dark dark:bg-surface-dark dark:text-ink-dark"
          />
          <Muted>{reason.trim().length}/200 · at least 3 characters</Muted>
          <Button variant="danger" label="Send rejection" loading={busy} disabled={reason.trim().length < 3} onPress={() => onReject(reason.trim())} />
          <Button variant="ghost" small label="Cancel" onPress={() => setRejecting(false)} />
        </View>
      ) : (
        <View className="gap-2">
          {disabledReason ? <Muted>{disabledReason}</Muted> : null}
          <Button label={`Approve ${SECTION_LABEL[section]}`} loading={busy} disabled={!!disabledReason} onPress={onApprove} />
          <Button variant="secondary" label="Reject…" disabled={busy} onPress={() => setRejecting(true)} />
        </View>
      )}
    </SectionCard>
  );
}

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

export default function ReviewScreen() {
  const { kind, ownerId } = useLocalSearchParams<{ kind: string; ownerId: string }>();
  const reviewKind: VerificationKind = kind === 'merchant' ? 'merchant' : 'driver';
  const { data, isLoading, error, retry } = useApiResource(() => getVerification(reviewKind, ownerId), [reviewKind, ownerId]);
  // The newest copy the server returned from a decision; shown until the next fresh load.
  const [latest, setLatest] = useState<VerificationDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const working = useRef(false);

  const detail = latest ?? data;
  if (isLoading && !detail) return <LoadingState label="Loading profile…" />;
  if (error && !detail) return <ErrorState error={error} retry={retry} />;
  if (!detail) return null;
  const current = detail;

  async function decide(section: VerificationSection, decision: 'approve' | 'reject', reason?: string) {
    if (working.current) return; // one decision at a time: no double submits
    working.current = true;
    setBusy(true);
    setActionError(null);
    try {
      setLatest(await decideVerification(reviewKind, ownerId, section, { decision, ...(reason ? { reason } : {}), version: current.version }));
    } catch (err) {
      setActionError(describeError(err));
      // The profile may have changed under us (409): reload so the next decision is on the latest details.
      setLatest(null);
      retry();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  function approve(section: VerificationSection) {
    confirmAlert({
      title: `Approve ${SECTION_LABEL[section]}?`,
      message: `${current.name || 'This person'} will be notified that their ${SECTION_LABEL[section].toLowerCase()} was verified.`,
      confirmLabel: 'Approve',
      onConfirm: () => void decide(section, 'approve'),
    });
  }

  const licenceBlock = current.kind === 'driver' && current.licenceExpired ? 'The driving licence has expired. Reject this section and ask for an updated one.' : null;

  return (
    <Screen keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <SectionCard title={current.kind === 'driver' ? 'Driver' : 'Shop'} icon={current.kind === 'driver' ? Truck : Store}>
        <Text className="text-xl font-extrabold text-ink dark:text-ink-dark">{current.name || 'Unnamed'}</Text>
        <View className="flex-row flex-wrap gap-2">
          <Badge label={`KYC: ${STATUS[current.sections.kyc].label}`} tone={STATUS[current.sections.kyc].tone} />
          <Badge label={`Bank: ${STATUS[current.sections.bank].label}`} tone={STATUS[current.sections.bank].tone} />
        </View>
        {actionError ? <Text className="text-sm font-medium text-red-600">{actionError}</Text> : null}
      </SectionCard>

      {current.kind === 'driver' ? (
        <DriverDetails p={current.profile as DriverProfile} licenceExpired={current.licenceExpired} />
      ) : (
        <MerchantDetails p={current.profile as MerchantProfile} />
      )}

      {(['kyc', 'bank'] as const).map((section) => (
        <DecisionBlock
          key={`${section}-${current.version}-${current.sections[section]}`}
          section={section}
          status={current.sections[section]}
          busy={busy}
          onApprove={() => approve(section)}
          onReject={(reason) => void decide(section, 'reject', reason)}
          disabledReason={section === 'kyc' ? licenceBlock : null}
        />
      ))}

      {current.history.length > 0 ? (
        <SectionCard title="Earlier decisions">
          {current.history.map((h, i) => (
            <View key={`${h.section}-${h.at}-${i}`} className="gap-0.5">
              <Text className="text-sm font-semibold text-ink dark:text-ink-dark">
                {SECTION_LABEL[h.section]}: {h.decision}
                {h.at ? ` · ${new Date(h.at).toLocaleString()}` : ''}
              </Text>
              {h.reason ? <Muted>{h.reason}</Muted> : null}
            </View>
          ))}
        </SectionCard>
      ) : null}
    </Screen>
  );
}
