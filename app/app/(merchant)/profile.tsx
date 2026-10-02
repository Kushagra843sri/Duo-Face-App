import { Camera, FileText, MapPin, Store } from 'lucide-react-native';
import { useState } from 'react';
import { Text } from 'react-native';

import { getMerchantProfile, saveMerchantProfile } from '@/api/profile';
import type { MerchantProfile } from '@/api/profile';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { BankSection } from '@/components/profile/BankSection';
import { Field } from '@/components/profile/Field';
import { PhotoField } from '@/components/profile/PhotoField';
import { ProfileSummary } from '@/components/profile/ProfileSummary';
import { SectionForm } from '@/components/profile/SectionForm';
import { Button, Muted, Screen, SectionCard } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { getCurrentLocationInput, getLocationPermission, requestLocationPermission } from '@/lib/locationService';
import { isValidEmail, isValidFssai, isValidGstin, isValidPan, isValidPhone, isValidPincode, required, rule, upper, validate } from '@/lib/validators';

type Reload = () => void;

function ShopSection({ profile, onSaved }: { profile: MerchantProfile; onSaved: Reload }) {
  const p = profile.personal;
  const [v, setV] = useState({
    shopName: p?.shopName ?? '',
    ownerName: p?.ownerName ?? '',
    contactPhone: p?.contactPhone ?? '',
    email: p?.email ?? '',
    line1: p?.address.line1 ?? '',
    city: p?.address.city ?? '',
    state: p?.address.state ?? '',
    pincode: p?.address.pincode ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof v) => (text: string) => setV((prev) => ({ ...prev, [key]: text }));

  async function save() {
    const found = validate(v, {
      shopName: required('Shop name'),
      ownerName: required('Owner name'),
      contactPhone: rule(isValidPhone, 'Include the country code, e.g. +919876543210.'),
      email: rule(isValidEmail, 'Enter a valid email.', true),
      line1: required('Address'),
      city: required('City'),
      pincode: rule(isValidPincode, 'Enter a valid 6-digit pincode.'),
    });
    setErrors(found);
    if (Object.keys(found).length > 0) throw new Error('Please fix the highlighted fields.');
    await saveMerchantProfile({
      personal: {
        shopName: v.shopName.trim(),
        ownerName: v.ownerName.trim(),
        contactPhone: v.contactPhone.trim(),
        ...(v.email.trim() ? { email: v.email.trim() } : {}),
        address: { line1: v.line1.trim(), city: v.city.trim(), ...(v.state.trim() ? { state: v.state.trim() } : {}), pincode: v.pincode.trim() },
      },
    });
    onSaved();
  }

  return (
    <SectionForm title="Shop & owner" icon={Store} onSave={save}>
      <Field label="Shop name" value={v.shopName} onChangeText={set('shopName')} error={errors.shopName} />
      <Field label="Owner name" value={v.ownerName} onChangeText={set('ownerName')} error={errors.ownerName} />
      <Field label="Phone number" value={v.contactPhone} onChangeText={set('contactPhone')} error={errors.contactPhone} keyboardType="phone-pad" placeholder="+919876543210" />
      <Field label="Email" value={v.email} onChangeText={set('email')} error={errors.email} keyboardType="email-address" autoCapitalize="none" optional />
      <Field label="Shop address" value={v.line1} onChangeText={set('line1')} error={errors.line1} />
      <Field label="City" value={v.city} onChangeText={set('city')} error={errors.city} />
      <Field label="State" value={v.state} onChangeText={set('state')} optional />
      <Field label="Pincode" value={v.pincode} onChangeText={set('pincode')} error={errors.pincode} keyboardType="number-pad" maxLength={6} />
    </SectionForm>
  );
}

function TaxSection({ profile, onSaved }: { profile: MerchantProfile; onSaved: Reload }) {
  const saved = profile.identity;
  const [pan, setPan] = useState('');
  const [gstin, setGstin] = useState(saved.gstin ?? '');
  const [fssai, setFssai] = useState(saved.fssai ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save() {
    const found = validate(
      { pan, gstin, fssai },
      {
        pan: rule(isValidPan, 'Enter a valid PAN, e.g. ABCDE1234F.', Boolean(saved.panMasked)),
        gstin: rule(isValidGstin, 'Enter a valid 15-character GSTIN.', true),
        fssai: rule(isValidFssai, 'FSSAI number is 14 digits.', true),
      }
    );
    setErrors(found);
    if (Object.keys(found).length > 0) throw new Error('Please fix the highlighted fields.');
    await saveMerchantProfile({
      identity: {
        ...(pan.trim() ? { panNumber: upper(pan) } : {}),
        ...(gstin.trim() ? { gstin: upper(gstin) } : {}),
        ...(fssai.trim() ? { fssai: fssai.replace(/\s/g, '') } : {}),
      },
    });
    setPan(''); // never keep the full PAN on screen after saving
    onSaved();
  }

  return (
    <SectionForm title="PAN & tax details" icon={FileText} onSave={save}>
      <Muted>Needed to pay out your sales. The full PAN is never shown again after saving.</Muted>
      <Field label="PAN" value={pan} onChangeText={(t) => setPan(t.toUpperCase())} error={errors.pan} autoCapitalize="characters" maxLength={10} savedMasked={saved.panMasked} placeholder="ABCDE1234F" />
      <Field label="GSTIN" value={gstin} onChangeText={(t) => setGstin(t.toUpperCase())} error={errors.gstin} autoCapitalize="characters" maxLength={15} optional />
      <Field label="FSSAI number" value={fssai} onChangeText={setFssai} error={errors.fssai} keyboardType="number-pad" maxLength={14} optional />
    </SectionForm>
  );
}

function LocationSection({ profile, onSaved }: { profile: MerchantProfile; onSaved: Reload }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function useCurrentLocation() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      let permission = await getLocationPermission();
      if (permission.status !== 'granted' && permission.canAskAgain) permission = await requestLocationPermission();
      if (permission.status !== 'granted') throw new Error('Location permission is needed to set your shop location.');
      const fix = await getCurrentLocationInput();
      await saveMerchantProfile({ pickupLocation: { latitude: fix.latitude, longitude: fix.longitude } });
      setMessage({ kind: 'ok', text: 'Shop location saved.' });
      onSaved();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Could not get your location.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="Pickup location" icon={MapPin}>
      <Muted>Drivers are matched to the nearest shop pickup point. Stand at your shop and tap the button so riders find the right spot.</Muted>
      {profile.pickupLocation ? (
        <Text className="text-sm font-semibold text-green-600">
          Saved: {profile.pickupLocation.latitude.toFixed(5)}, {profile.pickupLocation.longitude.toFixed(5)}
        </Text>
      ) : null}
      <Button label={profile.pickupLocation ? 'Update to my current location' : 'Use my current location'} icon={MapPin} variant="secondary" loading={busy} onPress={useCurrentLocation} />
      {message ? <Text className={`text-sm font-semibold ${message.kind === 'ok' ? 'text-green-600' : 'text-red-600'}`}>{message.text}</Text> : null}
    </SectionCard>
  );
}

export default function MerchantProfileScreen() {
  const { data, isLoading, error, retry } = useApiResource(getMerchantProfile);

  if (isLoading) return <LoadingState label="Loading your profile…" />;
  if (error || !data) return <ErrorState error={error} retry={retry} />;

  return (
    <Screen keyboardShouldPersistTaps="handled">
      <ProfileSummary
        name={data.personal?.shopName ?? 'Your shop'}
        subtitle={data.personal?.ownerName}
        photoUri={data.photoUrl}
        kycStatus={data.kycStatus}
        bankStatus={data.bankStatus}
        completeness={data.completeness}
      />

      <ShopSection profile={data} onSaved={retry} />
      <TaxSection profile={data} onSaved={retry} />
      <BankSection bank={data.bank} save={async (bank) => { await saveMerchantProfile({ bank }); retry(); }} />
      <LocationSection profile={data} onSaved={retry} />

      <SectionCard title="Photo (optional)" icon={Camera}>
        <PhotoField
          role="merchant"
          kind="shop"
          label="Shop or owner photo"
          hint="Optional. Without one, your initial is shown instead."
          uri={data.photoUrl}
          cameraOnly={false}
          removable
          onChanged={retry}
        />
      </SectionCard>
    </Screen>
  );
}
