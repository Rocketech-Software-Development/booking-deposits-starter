import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Button, Card, ErrorView, Loading, PolicyList, Row, Title, colors, styles } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { STRATEGY_LABEL, dateTime, money } from '../lib/format';
import type { ProviderDetail, Quote } from '../lib/types';
import { usePaymentSheet } from '../lib/usePaymentSheet';

export default function CheckoutScreen() {
  const { providerId, slotId } = useLocalSearchParams<{ providerId: string; slotId: string }>();
  const openPaymentSheet = usePaymentSheet();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [provider, setProvider] = useState<ProviderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [q, p] = await Promise.all([api.quote(providerId, slotId), api.provider(providerId)]);
      setQuote(q);
      setProvider(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [providerId, slotId]);

  useEffect(() => {
    load();
  }, [load]);

  const pay = async () => {
    if (!quote) return;
    setPaying(true);
    let bookingId: string | null = null;
    try {
      const { booking, paymentSheet } = await api.createBooking({
        providerId,
        slotId,
        policyAccepted: accepted,
        policyHash: quote.policyHash,
      });
      bookingId = booking.id;

      const result = await openPaymentSheet(paymentSheet);
      if (result.status === 'completed') {
        // Don't wait for the webhook: ask the backend to read the intent from Stripe now.
        // If that request fails the webhook still confirms the booking, so never cancel here.
        await api.refreshBooking(booking.id).catch(() => undefined);
        router.replace(`/booking/${booking.id}`);
        return;
      }
      // Closed or failed: give the slot back right away instead of holding it for the payment window.
      await api.cancelBooking(booking.id).catch(() => undefined);
      if (result.status === 'failed') Alert.alert('Payment failed', result.message);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'policy_changed') {
        setAccepted(false);
        await load();
        Alert.alert('The policy changed', 'Please read the updated cancellation policy and accept it again.');
      } else {
        if (bookingId) await api.cancelBooking(bookingId).catch(() => undefined);
        Alert.alert('Could not book', (e as Error).message);
      }
    } finally {
      setPaying(false);
    }
  };

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!quote || !provider) return <Loading />;

  const amount = money(quote.depositAmount, quote.currency);
  const payLabel =
    quote.strategy === 'hold' ? `Hold ${amount}` : quote.strategy === 'charge' ? `Pay ${amount} deposit` : 'Save card and book';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card>
        <Title>{provider.serviceName}</Title>
        <Row label="With" value={provider.name} />
        <Row label="When" value={dateTime(quote.startsAt)} />
        <Row label="Price" value={money(quote.priceAmount, quote.currency)} />
        <Row label="Today" value={quote.strategy === 'card_on_file' ? 'Nothing charged' : amount} />
        <Row label="How" value={STRATEGY_LABEL[quote.strategy]} />
        <Row label="Free cancellation until" value={dateTime(quote.freeCancellationUntil)} />
      </Card>

      <Card>
        <Text style={styles.sectionLabel}>Cancellation policy</Text>
        <PolicyList lines={quote.policyLines} />
      </Card>

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: accepted }}
        onPress={() => setAccepted((v) => !v)}
        style={{ flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 4 }}
      >
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: accepted ? colors.primary : colors.muted,
            backgroundColor: accepted ? colors.primary : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {accepted ? <Text style={{ color: colors.primaryText, fontWeight: '700' }}>✓</Text> : null}
        </View>
        <Text style={[styles.body, { flex: 1 }]}>
          I agree to this cancellation policy and to my card being charged as it describes.
        </Text>
      </Pressable>

      <Button title={payLabel} onPress={pay} disabled={!accepted} loading={paying} />
    </ScrollView>
  );
}
