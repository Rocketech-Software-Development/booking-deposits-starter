import { StripeProvider } from '@stripe/stripe-react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Linking from 'expo-linking';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ErrorView, Loading, colors } from '../components/ui';
import { api } from '../lib/api';
import type { AppConfig } from '../lib/types';

// Stripe returns here after 3D Secure or a bank redirect. Expo Go needs the '/--/' path.
const urlScheme =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient ? Linking.createURL('/--/') : Linking.createURL('');

export default function RootLayout() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The publishable key comes from the backend, so test keys live in one place.
  const load = useCallback(() => {
    setError(null);
    api
      .config()
      .then(setConfig)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorView message={error} onRetry={load} />;
  if (!config) return <Loading />;

  return (
    <StripeProvider
      publishableKey={config.publishableKey}
      merchantIdentifier="merchant.com.example.bookingdeposits"
      urlScheme={urlScheme}
    >
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerTintColor: colors.primary, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="index" options={{ title: 'Book a service' }} />
        <Stack.Screen name="provider/[id]" options={{ title: 'Pick a time' }} />
        <Stack.Screen name="checkout" options={{ title: 'Deposit and policy' }} />
        <Stack.Screen name="booking/[id]" options={{ title: 'Your booking' }} />
        <Stack.Screen name="bookings" options={{ title: 'My bookings' }} />
        <Stack.Screen name="provider-tools" options={{ title: 'Provider tools (demo)' }} />
      </Stack>
    </StripeProvider>
  );
}
