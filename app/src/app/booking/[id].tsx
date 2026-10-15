import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text } from 'react-native';
import { Badge, Button, Card, ErrorView, Loading, Muted, PolicyList, Row, Title, styles } from '../../components/ui';
import { api } from '../../lib/api';
import { STATUS_LABEL, STRATEGY_LABEL, dateTime, money } from '../../lib/format';
import type { Booking } from '../../lib/types';
import { usePaymentSheet } from '../../lib/usePaymentSheet';

export default function BookingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const openPaymentSheet = usePaymentSheet();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // refresh reads the intents from Stripe, so the screen is right even if a webhook is late.
  const load = useCallback(async () => {
    try {
      setError(null);
      setBooking(await api.refreshBooking(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (error && !booking) return <ErrorView message={error} onRetry={load} />;
  if (!booking) return <Loading />;

  const m = (amount: number) => money(amount, booking.currency);
  const lateCharge = Math.max(booking.depositAmount, booking.noShowFeeAmount);

  const cancel = () => {
    const message = booking.canCancelForFree
      ? booking.strategy === 'hold'
        ? 'We release the hold on your card.'
        : booking.strategy === 'charge'
          ? `We refund your ${m(booking.depositAmount)} deposit.`
          : 'Nothing is charged.'
      : `It's past the free cancellation time, so ${m(lateCharge)} is charged, as the policy says.`;
    Alert.alert('Cancel this booking?', message, [
      { text: 'Keep booking', style: 'cancel' },
      {
        text: 'Cancel booking',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            setBooking(await api.cancelBooking(booking.id));
          } catch (e) {
            Alert.alert('Could not cancel', (e as Error).message);
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const payOutstanding = async () => {
    setBusy(true);
    try {
      const { paymentSheet } = await api.payOutstanding(booking.id);
      const result = await openPaymentSheet(paymentSheet);
      if (result.status === 'failed') Alert.alert('Payment failed', result.message);
      await load();
    } catch (e) {
      Alert.alert('Could not start payment', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tone =
    booking.status === 'confirmed' || booking.status === 'completed'
      ? 'success'
      : booking.status === 'pending_payment'
        ? 'warning'
        : 'neutral';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
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
    >
      <Card>
        <Badge label={STATUS_LABEL[booking.status]} tone={tone} />
        <Title>{booking.serviceName}</Title>
        <Row label="With" value={booking.providerName} />
        <Row label="When" value={dateTime(booking.startsAt)} />
        <Row label="Price" value={m(booking.priceAmount)} />
        <Row label="Deposit" value={STRATEGY_LABEL[booking.strategy]} />
        {booking.totals.held > 0 ? <Row label="On hold" value={m(booking.totals.held)} /> : null}
        {booking.totals.collected > 0 ? <Row label="Charged" value={m(booking.totals.collected)} /> : null}
        {booking.totals.refunded > 0 ? <Row label="Refunded" value={m(booking.totals.refunded)} /> : null}
      </Card>

      {booking.amountDue > 0 ? (
        <Card>
          <Title>{m(booking.amountDue)} still owed</Title>
          <Text style={styles.body}>
            We couldn't charge your saved card for the fee in the policy. Your bank may need you to confirm the payment.
          </Text>
          <Button title={`Pay ${m(booking.amountDue)}`} onPress={payOutstanding} loading={busy} />
        </Card>
      ) : null}

      {booking.status === 'pending_payment' ? (
        <Card>
          <Text style={styles.body}>We're waiting for Stripe to confirm your payment. Pull down to check again.</Text>
        </Card>
      ) : null}

      {booking.status === 'confirmed' || booking.status === 'pending_payment' ? (
        <Card>
          <Text style={styles.body}>
            {booking.canCancelForFree
              ? `Free cancellation until ${dateTime(booking.freeCancellationUntil)}.`
              : booking.status === 'confirmed'
                ? `Free cancellation ended ${dateTime(booking.freeCancellationUntil)}. Cancelling now costs ${m(lateCharge)}.`
                : 'You can cancel before paying at no cost.'}
          </Text>
          <Button title="Cancel booking" kind="danger" onPress={cancel} loading={busy} />
        </Card>
      ) : null}

      <Card>
        <Text style={styles.sectionLabel}>The policy you agreed to</Text>
        <PolicyList lines={booking.policyLines} />
        <Muted>Accepted {dateTime(booking.policyAcceptedAt)}</Muted>
      </Card>
    </ScrollView>
  );
}
