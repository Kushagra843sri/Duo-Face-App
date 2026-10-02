import { Landmark } from 'lucide-react-native';
import { useState } from 'react';

import type { BankInput, BankView } from '@/api/profile';
import { Field } from '@/components/profile/Field';
import { SectionForm } from '@/components/profile/SectionForm';
import { Muted } from '@/components/ui';
import { isValidAccount, isValidIfsc, isValidUpi, required, rule, upper, validate } from '@/lib/validators';

interface Props {
  bank: BankView | null;
  save: (bank: BankInput) => Promise<unknown>;
}

/**
 * Bank / UPI details used to pay out earnings after the platform commission.
 * The account number is shown masked once saved; it is only sent when typed.
 */
export function BankSection({ bank, save }: Props) {
  const [holder, setHolder] = useState(bank?.accountHolderName ?? '');
  const [account, setAccount] = useState('');
  const [ifsc, setIfsc] = useState(bank?.ifsc ?? '');
  const [bankName, setBankName] = useState(bank?.bankName ?? '');
  const [upi, setUpi] = useState(bank?.upiId ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function onSave() {
    const found = validate(
      { holder, account, ifsc, upi },
      {
        holder: required('Account holder name'),
        // Required the first time; afterwards blank means "keep the saved one".
        account: bank?.accountMasked ? rule(isValidAccount, 'Account number must be 9-18 digits.', true) : rule(isValidAccount, 'Account number must be 9-18 digits.'),
        ifsc: rule(isValidIfsc, 'Enter a valid IFSC, e.g. SBIN0001234.'),
        upi: rule(isValidUpi, 'Enter a valid UPI id, e.g. name@bank.', true),
      }
    );
    setErrors(found);
    if (Object.keys(found).length > 0) throw new Error('Please fix the highlighted fields.');

    await save({
      accountHolderName: holder.trim(),
      ...(account.trim() ? { accountNumber: account.replace(/[\s-]/g, '') } : {}),
      ifsc: upper(ifsc),
      ...(bankName.trim() ? { bankName: bankName.trim() } : {}),
      ...(upi.trim() ? { upiId: upi.trim() } : {}),
    });
    setAccount(''); // never keep a full account number on screen after saving
  }

  return (
    <SectionForm title="Bank & payouts" icon={Landmark} onSave={onSave}>
      <Muted>Your earnings are paid to this account after our commission is deducted. Changing it sends it back for review.</Muted>
      <Field label="Account holder name" value={holder} onChangeText={setHolder} error={errors.holder} />
      <Field
        label="Account number"
        value={account}
        onChangeText={setAccount}
        error={errors.account}
        keyboardType="number-pad"
        maxLength={18}
        savedMasked={bank?.accountMasked}
        hint="Stored encrypted. We only ever show the last 4 digits."
      />
      <Field label="IFSC code" value={ifsc} onChangeText={(t) => setIfsc(t.toUpperCase())} error={errors.ifsc} autoCapitalize="characters" maxLength={11} placeholder="SBIN0001234" />
      <Field label="Bank name" value={bankName} onChangeText={setBankName} optional />
      <Field label="UPI id" value={upi} onChangeText={setUpi} error={errors.upi} autoCapitalize="none" placeholder="name@bank" optional />
    </SectionForm>
  );
}
