import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Button, Card, ErrorView, Loading, Muted, Title, colors, styles } from '../../components/ui';
import { api } from '../../lib/api';
import { dayLabel, money, time } from '../../lib/format';
import type { ProviderDetail } from '../../lib/types';

export default function ProviderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [provider, setProvider] = useState<ProviderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setProvider(await api.provider(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const days = useMemo(() => {
    const groups = new Map<string, { id: string; startsAt: string }[]>();
    for (const slot of provider?.slots ?? []) {
      const key = dayLabel(slot.startsAt);
      groups.set(key, [...(groups.get(key) ?? []), slot]);
    }
    return [...groups.entries()];
  }, [provider]);

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!provider) return <Loading />;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card>
        <Title>{provider.name}</Title>
        <Muted>{provider.description}</Muted>
        <Text style={styles.body}>
          {provider.serviceName} · {provider.durationMinutes} min · {money(provider.priceAmount, provider.currency)}
        </Text>
      </Card>

      {!provider.acceptingBookings ? (
        <Card>
          <Text style={styles.body}>
            This provider hasn't finished setting up payouts, so it can't take deposits yet. Open Provider tools on the
            first screen and run Stripe onboarding for it.
          </Text>
        </Card>
      ) : null}

      {days.length === 0 ? <Muted>No open slots.</Muted> : null}
      {days.map(([day, slots]) => (
        <View key={day} style={{ gap: 8 }}>
          <Text style={styles.sectionLabel}>{day}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {slots.map((slot) => {
              const selected = slot.id === slotId;
              return (
                <Pressable
                  key={slot.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => setSlotId(slot.id)}
                  style={{
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: selected ? colors.primary : colors.border,
                    backgroundColor: selected ? colors.primary : colors.card,
                  }}
                >
                  <Text style={{ color: selected ? colors.primaryText : colors.text, fontWeight: '500' }}>
                    {time(slot.startsAt)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}

      <Button
        title="Continue"
        disabled={!slotId || !provider.acceptingBookings}
        onPress={() => router.push({ pathname: '/checkout', params: { providerId: provider.id, slotId: slotId! } })}
      />
    </ScrollView>
  );
}
