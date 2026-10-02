import type { LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Text } from 'react-native';

import { ApiError } from '@/api/errors';
import { Button, SectionCard } from '@/components/ui';

interface Props {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  /** Validate and save. Throw an Error with a driver-facing message to show it under the button. */
  onSave: () => Promise<void>;
  saveLabel?: string;
}

/** A profile section: fields + its own Save, so a half-filled form never blocks another section. */
export function SectionForm({ title, icon, children, onSave, saveLabel = 'Save' }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await onSave();
      setMessage({ kind: 'ok', text: 'Saved.' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof ApiError || error instanceof Error ? error.message : 'Could not save. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title={title} icon={icon}>
      {children}
      {message ? <Text className={`text-sm font-semibold ${message.kind === 'ok' ? 'text-green-600' : 'text-red-600'}`}>{message.text}</Text> : null}
      <Button label={saveLabel} loading={busy} onPress={save} />
    </SectionCard>
  );
}
