import { Store } from 'lucide-react-native';

import { EmptyState } from '@/components/EmptyState';

export default function MerchantHome() {
  return (
    <EmptyState
      icon={Store}
      title="Merchant interface"
      description="Store profile, catalog and order pipeline arrive in Phase 2."
    />
  );
}
