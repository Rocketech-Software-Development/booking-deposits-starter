import { useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Badge, Button, Card, ErrorView, Loading, Muted, Row, Title, colors, styles } from '../components/ui';
import { api } from '../lib/api';
import { STATUS_LABEL, dateTime, money } from '../lib/format';
import type { Booking, ConnectStatus, Provider } from '../lib/types';

/**
 * DEMO SCREEN. In a real marketplace these actions live in the provider's own app or a web
 * dashboard, behind real auth. They're here so you can try every Stripe flow from one device.
 */
export default function ProviderToolsScreen() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadProvider = useCallback(async (id: string) => {
    const [s, b] = await Promise.all([api.providerTools.connectStatus(id), api.providerTools.bookings(id)]);
    setStatus(s);
    setBookings(b);
  }, []);

  const load = useCallback(async () => {
    try {
      setError(null);
      const list = await api.providers();
      setProviders(list);
      const id = providerId ?? list[0]?.id ?? null;
      setProviderId(id);
      if (id) await loadProvider(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [providerId, loadProvider]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const run = async (key: string, task: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await task();
      if (providerId) await loadProvider(providerId);
    } catch (e) {
      Alert.alert('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openOnboarding = () =>
    run('onboard', async () => {
      const { url } = await api.providerTools.onboardingLink(providerId!);
      // Stripe hosts onboarding. In test mode you can fill it with test data.
      await WebBrowser.openBrowserAsync(url);
    });

  const openDashboard = () =>
    run('dashboard', async () => {
      const { url } = await api.providerTools.dashboardLink(providerId!);
      await WebBrowser.openBrowserAsync(url);
    });

  const confirmAction = (booking: Booking, action: 'complete' | 'no-show' | 'cancel' | 'refund', message: string) =>
    Alert.alert('Are you sure?', message, [
      { text: 'Back', style: 'cancel' },
      {
        text: 'Yes',
        onPress: () => run(`${booking.id}:${action}`, () => api.providerTools.action(providerId!, booking.id, action)),
      },
    ]);

  if (error && !providers) return <ErrorView message={error} onRetry={load} />;
  if (!providers || !providerId) return <Loading />;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Muted>Demo only. These are the provider's actions; a real app keeps them behind provider login.</Muted>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {providers.map((p) => {
          const selected = p.id === providerId;
          return (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => {
                setProviderId(p.id);
                loadProvider(p.id).catch((e: Error) => setError(e.message));
              }}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 12,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: selected ? colors.primary : colors.border,
                backgroundColor: selected ? colors.primary : colors.card,
              }}
            >
              <Text style={{ color: selected ? colors.primaryText : colors.text }}>{p.name}</Text>
            </Pressable>
          );
        })}
      </View>

      <Card>
        <Title>Payouts (Stripe Connect)</Title>
        {status ? (
          <>
            <Row label="Details submitted" value={status.detailsSubmitted ? 'Yes' : 'No'} />
            <Row label="Can receive transfers" value={status.transfersActive ? 'Yes' : 'No'} />
            <Row label="Payouts to bank" value={status.payoutsEnabled ? 'On' : 'Off'} />
          </>
        ) : null}
        {!status?.acceptingBookings ? (
          <Button title="Set up payouts" onPress={openOnboarding} loading={busy === 'onboard'} />
        ) : null}
        {status?.detailsSubmitted ? (
          <Button title="Open Express Dashboard" kind="secondary" onPress={openDashboard} loading={busy === 'dashboard'} />
        ) : null}
      </Card>

      <Text style={styles.sectionLabel}>Bookings</Text>
      {bookings.length === 0 ? <Muted>No bookings yet.</Muted> : null}
      {bookings.map((b) => {
        const m = (amount: number) => money(amount, b.currency);
        const refundable = b.totals.collected - b.totals.refunded;
        return (
          <Card key={b.id}>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Badge label={STATUS_LABEL[b.status]} />
              {b.disputed ? <Badge label="Disputed" tone="danger" /> : null}
              {b.amountDue > 0 ? <Badge label={`${m(b.amountDue)} owed`} tone="warning" /> : null}
            </View>
            <Text style={styles.body}>{dateTime(b.startsAt)}</Text>
            <Row label="On hold" value={m(b.totals.held)} />
            <Row label="Charged" value={m(b.totals.collected)} />
            {b.totals.refunded > 0 ? <Row label="Refunded" value={m(b.totals.refunded)} /> : null}
            {b.payments
              .filter((p) => p.status === 'authorized' && p.captureBefore)
              .map((p) => (
                <Muted key={p.id}>Hold expires {dateTime(p.captureBefore!)}</Muted>
              ))}

            {b.status === 'confirmed' ? (
              <View style={{ gap: 8 }}>
                <Button
                  title="Customer came"
                  kind="secondary"
                  loading={busy === `${b.id}:complete`}
                  onPress={() => confirmAction(b, 'complete', 'A held deposit is charged and counts toward the price.')}
                />
                <Button
                  title="Mark no-show"
                  kind="secondary"
                  loading={busy === `${b.id}:no-show`}
                  onPress={() =>
                    confirmAction(
                      b,
                      'no-show',
                      `The customer is charged ${m(Math.max(b.depositAmount, b.noShowFeeAmount))} under the policy they accepted.`,
                    )
                  }
                />
                <Button
                  title="Cancel and give everything back"
                  kind="danger"
                  loading={busy === `${b.id}:cancel`}
                  onPress={() => confirmAction(b, 'cancel', 'Holds are released and charges refunded in full.')}
                />
              </View>
            ) : null}
            {refundable > 0 ? (
              <Button
                title={`Refund ${m(refundable)}`}
                kind="danger"
                loading={busy === `${b.id}:refund`}
                onPress={() => confirmAction(b, 'refund', `Refund ${m(refundable)} to the customer's card.`)}
              />
            ) : null}
          </Card>
        );
      })}
    </ScrollView>
  );
}
