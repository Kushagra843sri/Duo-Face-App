import { router } from 'expo-router';
import { Ban, Boxes, ClipboardList, Package, PackageCheck, Truck } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { getMerchantInventory, getMerchantMe, getMerchantOrders, getMerchantProducts } from '@/api/merchant';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { HeroHeader, IconChip, PressableCard, Screen, StatCard } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';

interface DashboardData {
  shopName: string;
  productCount: number;
  inventoryCount: number;
  activeInventoryCount: number;
  disabledInventoryCount: number;
  orderCount: number;
}

async function loadDashboard(): Promise<DashboardData> {
  // Promise.all deliberately: if any of these 409s (a real state — /merchant/me
  // can succeed on the Duo-Face-shop check while /merchant/products or
  // /merchant/orders still 409 on the separate Customer-App-shop link, see
  // decision 009), the whole dashboard shows the "setup required" state
  // rather than a confusing mix of partial data.
  const [me, products, inventory, orders] = await Promise.all([
    getMerchantMe(),
    getMerchantProducts(),
    getMerchantInventory(),
    getMerchantOrders(),
  ]);

  return {
    shopName: me.shopName,
    productCount: products.length,
    inventoryCount: inventory.length,
    activeInventoryCount: inventory.filter((item) => item.status === 'active').length,
    disabledInventoryCount: inventory.filter((item) => item.status === 'disabled').length,
    orderCount: orders.length,
  };
}

function openInventory(filter: 'all' | 'active' | 'disabled') {
  router.navigate({ pathname: '/(merchant)/inventory', params: { filter } });
}

function SectionLabel({ children }: { children: string }) {
  return <Text className="mt-2 text-xs font-bold uppercase tracking-wider text-muted dark:text-muted-dark">{children}</Text>;
}

function QuickLink({ title, subtitle, icon, href }: { title: string; subtitle: string; icon: typeof Truck; href: string }) {
  return (
    <PressableCard onPress={() => router.push(href as never)}>
      <View className="flex-row items-center gap-3">
        <IconChip icon={icon} />
        <View className="flex-1">
          <Text className="text-base font-bold text-ink dark:text-ink-dark">{title}</Text>
          <Text className="text-sm text-muted dark:text-muted-dark">{subtitle}</Text>
        </View>
      </View>
    </PressableCard>
  );
}

export default function MerchantDashboard() {
  const { data, isLoading, error, retry } = useApiResource(loadDashboard);

  if (isLoading) {
    return <LoadingState label="Loading dashboard…" />;
  }

  if (error || !data) {
    return <ErrorState error={error} retry={retry} />;
  }

  return (
    <Screen>
      <HeroHeader eyebrow="Your shop" title={data.shopName} subtitle="Welcome back" actionLabel="View & edit profile" onPress={() => router.push('/(merchant)/profile' as never)} />

      <View className="flex-row gap-3">
        <StatCard label="Products" value={data.productCount} icon={Package} onPress={() => router.navigate('/(merchant)/products')} />
        <StatCard label="Orders" value={data.orderCount} icon={ClipboardList} onPress={() => router.navigate('/(merchant)/orders')} />
      </View>

      <SectionLabel>Inventory</SectionLabel>
      <View className="flex-row gap-3">
        <StatCard label="Tracked" value={data.inventoryCount} icon={Boxes} onPress={() => openInventory('all')} />
        <StatCard label="Active" value={data.activeInventoryCount} icon={PackageCheck} onPress={() => openInventory('active')} />
        <StatCard label="Disabled" value={data.disabledInventoryCount} icon={Ban} onPress={() => openInventory('disabled')} />
      </View>

      <SectionLabel>Quick actions</SectionLabel>
      <QuickLink title="Orders" subtitle="Review orders and request drivers" icon={ClipboardList} href="/(merchant)/orders" />
      <QuickLink title="Deliveries" subtitle="Track drivers on the way" icon={Truck} href="/(merchant)/deliveries" />
      <QuickLink title="Inventory" subtitle="Update stock quantities" icon={Boxes} href="/(merchant)/inventory" />
    </Screen>
  );
}
