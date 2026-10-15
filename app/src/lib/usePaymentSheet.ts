import { PaymentSheetError, useStripe } from '@stripe/stripe-react-native';
import * as Linking from 'expo-linking';
import { useCallback } from 'react';
import type { PaymentSheetParams } from './types';

export type PaymentSheetResult = { status: 'completed' } | { status: 'canceled' } | { status: 'failed'; message: string };

/**
 * Opens Stripe's PaymentSheet for a PaymentIntent (deposit or outstanding fee) or a SetupIntent
 * (card on file). The backend creates the intent; the app never sees amounts it could change.
 */
export function usePaymentSheet() {
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  return useCallback(
    async (params: PaymentSheetParams): Promise<PaymentSheetResult> => {
      const common = {
        merchantDisplayName: params.merchantDisplayName,
        customerId: params.customerId,
        customerSessionClientSecret: params.customerSessionClientSecret,
        // Where 3D Secure and bank redirects come back to. Needs the `scheme` from app.json.
        returnURL: Linking.createURL('stripe-redirect'),
        // Apple Pay needs a development build and a merchant id; it is ignored in Expo Go.
        applePay: { merchantCountryCode: params.merchantCountryCode },
        allowsDelayedPaymentMethods: false,
      };

      const { error: initError } = params.paymentIntentClientSecret
        ? await initPaymentSheet({ ...common, paymentIntentClientSecret: params.paymentIntentClientSecret })
        : await initPaymentSheet({ ...common, setupIntentClientSecret: params.setupIntentClientSecret ?? '' });
      if (initError) return { status: 'failed', message: initError.message };

      const { error } = await presentPaymentSheet();
      if (!error) return { status: 'completed' };
      if (error.code === PaymentSheetError.Canceled) return { status: 'canceled' };
      return { status: 'failed', message: error.message };
    },
    [initPaymentSheet, presentPaymentSheet],
  );
}
