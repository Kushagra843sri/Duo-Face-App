import { Bike, Camera, IdCard, UserRound } from 'lucide-react-native';
import { useEffect, useState } from 'react';

import { getDriverProfile, saveDriverProfile } from '@/api/profile';
import type { DriverProfile } from '@/api/profile';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { BankSection } from '@/components/profile/BankSection';
import { Field } from '@/components/profile/Field';
import { PhotoField } from '@/components/profile/PhotoField';
import { ProfileSummary } from '@/components/profile/ProfileSummary';
import { SectionForm } from '@/components/profile/SectionForm';
import { FilterChips, Muted, Screen, SectionCard } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { recoverPendingPhoto } from '@/lib/profilePhotos';
import { isAdultDob, isFutureDate, isValidAadhaar, isValidLicence, isValidPan, isValidPhone, isValidPincode, isValidVehicleNumber, required, rule, upper, validate } from '@/lib/validators';

type Reload = () => void;

function PersonalSection({ profile, onSaved }: { profile: DriverProfile; onSaved: Reload }) {
  const p = profile.personal;
  const [v, setV] = useState({
    fullName: p?.fullName ?? '',
    contactPhone: p?.contactPhone ?? '',
    dateOfBirth: p?.dateOfBirth ?? '',
    line1: p?.address.line1 ?? '',
    city: p?.address.city ?? '',
    state: p?.address.state ?? '',
    pincode: p?.address.pincode ?? '',
    emergencyName: p?.emergencyContact.name ?? '',
    emergencyPhone: p?.emergencyContact.phone ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof v) => (text: string) => setV((prev) => ({ ...prev, [key]: text }));

  async function save() {
    const found = validate(v, {
      fullName: required('Full name'),
      contactPhone: rule(isValidPhone, 'Include the country code, e.g. +919876543210.'),
      dateOfBirth: rule(isAdultDob, 'You must be at least 18. Use YYYY-MM-DD.'),
      line1: required('Address'),
      city: required('City'),
      pincode: rule(isValidPincode, 'Enter a valid 6-digit pincode.'),
      emergencyName: required('Emergency contact name'),
      emergencyPhone: rule(isValidPhone, 'Include the country code, e.g. +919876543210.'),
    });
    setErrors(found);
    if (Object.keys(found).length > 0) throw new Error('Please fix the highlighted fields.');
    await saveDriverProfile({
      personal: {
        fullName: v.fullName.trim(),
        contactPhone: v.contactPhone.trim(),
        dateOfBirth: v.dateOfBirth.trim(),
        address: { line1: v.line1.trim(), city: v.city.trim(), ...(v.state.trim() ? { state: v.state.trim() } : {}), pincode: v.pincode.trim() },
        emergencyContact: { name: v.emergencyName.trim(), phone: v.emergencyPhone.trim() },
      },
    });
    onSaved();
  }

  return (
    <SectionForm title="Personal details" icon={UserRound} onSave={save}>
      <Field label="Full name" value={v.fullName} onChangeText={set('fullName')} error={errors.fullName} />
      <Field label="Phone number" value={v.contactPhone} onChangeText={set('contactPhone')} error={errors.contactPhone} keyboardType="phone-pad" placeholder="+919876543210" hint="Customers are connected through this number; they never see it." />
      <Field label="Date of birth" value={v.dateOfBirth} onChangeText={set('dateOfBirth')} error={errors.dateOfBirth} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" maxLength={10} />
      <Field label="Address" value={v.line1} onChangeText={set('line1')} error={errors.line1} />
      <Field label="City" value={v.city} onChangeText={set('city')} error={errors.city} />
      <Field label="State" value={v.state} onChangeText={set('state')} optional />
      <Field label="Pincode" value={v.pincode} onChangeText={set('pincode')} error={errors.pincode} keyboardType="number-pad" maxLength={6} />
      <Field label="Emergency contact name" value={v.emergencyName} onChangeText={set('emergencyName')} error={errors.emergencyName} />
      <Field label="Emergency contact phone" value={v.emergencyPhone} onChangeText={set('emergencyPhone')} error={errors.emergencyPhone} keyboardType="phone-pad" placeholder="+919876543210" />
    </SectionForm>
  );
}

function IdentitySection({ profile, onSaved }: { profile: DriverProfile; onSaved: Reload }) {
  const saved = profile.identity;
  const [aadhaar, setAadhaar] = useState('');
  const [pan, setPan] = useState('');
  const [licence, setLicence] = useState('');
  const [expiry, setExpiry] = useState(saved.licenceExpiry ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save() {
    // Sensitive values are required once; afterwards blank = keep the saved one.
    const found = validate(
      { aadhaar, pan, licence, expiry },
      {
        aadhaar: rule(isValidAadhaar, 'Enter a valid 12-digit Aadhaar number.', Boolean(saved.aadhaarMasked)),
        pan: rule(isValidPan, 'Enter a valid PAN, e.g. ABCDE1234F.', Boolean(saved.panMasked)),
        licence: rule(isValidLicence, 'Enter a valid driving licence number.', Boolean(saved.licenceMasked)),
        expiry: rule(isFutureDate, 'Licence expiry must be a future date (YYYY-MM-DD).'),
      }
    );
    setErrors(found);
    if (Object.keys(found).length > 0) throw new Error('Please fix the highlighted fields.');
    await saveDriverProfile({
      identity: {
        ...(aadhaar.trim() ? { aadhaarNumber: aadhaar.replace(/[\s-]/g, '') } : {}),
        ...(pan.trim() ? { panNumber: upper(pan) } : {}),
        ...(licence.trim() ? { licenceNumber: upper(licence) } : {}),
        licenceExpiry: expiry.trim(),
      },
    });
    setAadhaar('');
    setPan('');
    setLicence(''); // never keep full numbers on screen after saving
    onSaved();
  }

  return (
    <SectionForm title="Identity & licence" icon={IdCard} onSave={save}>
      <Muted>Used to verify you before payouts. Full numbers are never shown again after saving. Changing them sends your KYC back for review.</Muted>
      <Field label="Aadhaar number" value={aadhaar} onChangeText={setAadhaar} error={errors.aadhaar} keyboardType="number-pad" maxLength={14} savedMasked={saved.aadhaarMasked} hint="We keep only the last 4 digits." />
      <Field label="PAN" value={pan} onChangeText={(t) => setPan(t.toUpperCase())} error={errors.pan} autoCapitalize="characters" maxLength={10} savedMasked={saved.panMasked} placeholder="ABCDE1234F" />
      <Field label="Driving licence number" value={licence} onChangeText={(t) => setLicence(t.toUpperCase())} error={errors.licence} autoCapitalize="characters" savedMasked={saved.licenceMasked} />
      <Field label="Licence expiry" value={expiry} onChangeText={setExpiry} error={errors.expiry} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" maxLength={10} />
    </SectionForm>
  );
}

const VEHICLE_TYPES = [
  { value: 'bicycle', label: 'Bicycle' },
  { value: 'scooter', label: 'Scooter' },
  { value: 'motorcycle', label: 'Motorcycle' },
  { value: 'ev', label: 'EV' },
  { value: 'car', label: 'Car' },
] as const;

function VehicleSection({ profile, onSaved }: { profile: DriverProfile; onSaved: Reload }) {
  const [type, setType] = useState(profile.vehicle?.type ?? 'motorcycle');
  const [registration, setRegistration] = useState(profile.vehicle?.registrationNumber ?? '');
  const [makeModel, setMakeModel] = useState(profile.vehicle?.makeModel ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save() {
    const found = validate({ registration }, { registration: rule(isValidVehicleNumber, 'Enter a valid vehicle number, e.g. DL1AB1234.') });
    setErrors(found);
    if (Object.keys(found).length > 0) throw new Error('Please fix the highlighted fields.');
    await saveDriverProfile({ vehicle: { type, registrationNumber: upper(registration), ...(makeModel.trim() ? { makeModel: makeModel.trim() } : {}) } });
    onSaved();
  }

  return (
    <SectionForm title="Vehicle" icon={Bike} onSave={save}>
      <FilterChips flush value={type} onChange={setType} options={VEHICLE_TYPES.map((t) => ({ value: t.value as string, label: t.label }))} />
      <Field label="Vehicle number" value={registration} onChangeText={(t) => setRegistration(t.toUpperCase())} error={errors.registration} autoCapitalize="characters" placeholder="DL1AB1234" />
      <Field label="Make & model" value={makeModel} onChangeText={setMakeModel} placeholder="Honda Shine" optional />
    </SectionForm>
  );
}

export default function DriverProfileScreen() {
  const { data, isLoading, error, retry } = useApiResource(getDriverProfile);

  // If Android killed the app while the camera was open, finish that photo now.
  useEffect(() => {
    void recoverPendingPhoto('driver').then((recovered) => recovered && retry());
  }, [retry]);

  if (isLoading && !data) return <LoadingState label="Loading your profile…" />;
  if (error || !data) return <ErrorState error={error} retry={retry} />;

  return (
    <Screen keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" nestedScrollEnabled>
      <ProfileSummary
        name={data.personal?.fullName ?? 'Your profile'}
        subtitle={data.personal?.contactPhone}
        photoUri={data.photos.selfieUrl}
        kycStatus={data.kycStatus}
        bankStatus={data.bankStatus}
        completeness={data.completeness}
      />

      <PersonalSection profile={data} onSaved={retry} />
      <IdentitySection profile={data} onSaved={retry} />
      <VehicleSection profile={data} onSaved={retry} />
      <BankSection bank={data.bank} save={async (bank) => { await saveDriverProfile({ bank }); retry(); }} />

      <SectionCard title="Live photos" icon={Camera}>
        <Muted>These must be taken now with your camera; you can&apos;t upload from the gallery. They help us confirm you and your vehicle.</Muted>
        <PhotoField role="driver" kind="selfie" label="Your photo" hint="Face the camera in good light." uri={data.photos.selfieUrl} cameraOnly onChanged={retry} />
        <PhotoField role="driver" kind="vehicle" label="Your vehicle" hint="Show the whole vehicle with the number plate visible." uri={data.photos.vehicleUrl} cameraOnly onChanged={retry} />
      </SectionCard>
    </Screen>
  );
}
