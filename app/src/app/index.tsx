import { Link, Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { Badge, Card, ErrorView, Loading, Muted, Title, colors, styles } from '../components/ui';
import { api } from '../lib/api';
import { money } from '../lib/format';
import type { Provider } from '../lib/types';

export default function ProvidersScreen() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setProviders(await api.providers());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (error && !providers) return <ErrorView message={error} onRetry={load} />;
  if (!providers) return <Loading />;

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/bookings" style={{ color: colors.primary, fontSize: 16 }}>
              My bookings
            </Link>
          ),
        }}
      />
      <FlatList
        contentContainerStyle={styles.content}
        data={providers}
        keyExtractor={(p) => p.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => router.push(`/provider/${item.id}`)}>
            <Card>
              <Title>{item.name}</Title>
              <Muted>
                {item.category} · {item.serviceName} · {item.durationMinutes} min
              </Muted>
              <Text style={styles.body}>{money(item.priceAmount, item.currency)}</Text>
              {!item.acceptingBookings ? <Badge label="Payouts not set up yet" tone="warning" /> : null}
            </Card>
          </Pressable>
        )}
        ListFooterComponent={
          <Link href="/provider-tools" style={{ color: colors.primary, textAlign: 'center', padding: 16 }}>
            Provider tools (demo): payouts, no-shows, refunds
          </Link>
        }
      />
    </View>
  );
}
