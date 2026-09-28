import { Truck } from 'lucide-react-native';

import { EmptyState } from '@/components/EmptyState';

export default function DriverHome() {
  return (
    <EmptyState
      icon={Truck}
      title="Delivery partner interface"
      description="Onboarding, dispatch and navigation arrive in Phase 3."
    />
  );
}
