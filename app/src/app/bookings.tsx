import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable } from 'react-native';
import { Badge, Card, ErrorView, Loading, Muted, Title, styles } from '../components/ui';
import { api } from '../lib/api';
import { STATUS_LABEL, dateTime } from '../lib/format';
import type { Booking } from '../lib/types';

export default function MyBookingsScreen() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setBookings((await api.myBookings()).filter((b) => b.status !== 'expired'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (error && !bookings) return <ErrorView message={error} onRetry={load} />;
  if (!bookings) return <Loading />;

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      data={bookings}
      keyExtractor={(b) => b.id}
      ListEmptyComponent={<Muted>No bookings yet.</Muted>}
      renderItem={({ item }) => (
        <Pressable accessibilityRole="button" onPress={() => router.push(`/booking/${item.id}`)}>
          <Card>
            <Badge label={STATUS_LABEL[item.status]} />
            <Title>{item.serviceName}</Title>
            <Muted>
              {item.providerName} · {dateTime(item.startsAt)}
            </Muted>
          </Card>
        </Pressable>
      )}
    />
  );
}
