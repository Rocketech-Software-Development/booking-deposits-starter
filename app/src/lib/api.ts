import type {
  AppConfig,
  Booking,
  ConnectStatus,
  PaymentSheetParams,
  Provider,
  ProviderDetail,
  Quote,
} from './types';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4242').replace(/\/$/, '');

/**
 * DEMO IDENTITY. The backend trusts these headers, which is fine on your laptop and nowhere else.
 * Replace them with your real auth token (and check it on the server) before shipping.
 */
export const DEMO_USER_ID = 'user_demo';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { as?: { provider?: string } } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-demo-user': DEMO_USER_ID };
  if (init.as?.provider) headers['x-demo-provider'] = init.as.provider;

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'network', `Can't reach the backend at ${API_URL}. Is it running?`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(response.status, error?.code ?? 'unknown', error?.message ?? `Request failed (${response.status})`);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown, as?: { provider?: string }) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), as });

export const api = {
  config: () => request<AppConfig>('/config'),

  providers: () => request<{ providers: Provider[] }>('/providers').then((r) => r.providers),
  provider: (id: string) => request<{ provider: ProviderDetail }>(`/providers/${id}`).then((r) => r.provider),
  quote: (providerId: string, slotId: string) =>
    request<{ quote: Quote }>(`/quote?providerId=${encodeURIComponent(providerId)}&slotId=${encodeURIComponent(slotId)}`).then(
      (r) => r.quote,
    ),

  createBooking: (input: { providerId: string; slotId: string; policyAccepted: boolean; policyHash: string }) =>
    post<{ booking: Booking; paymentSheet: PaymentSheetParams }>('/bookings', input),
  myBookings: () => request<{ bookings: Booking[] }>('/bookings').then((r) => r.bookings),
  booking: (id: string) => request<{ booking: Booking }>(`/bookings/${id}`).then((r) => r.booking),
  refreshBooking: (id: string) => post<{ booking: Booking }>(`/bookings/${id}/refresh`).then((r) => r.booking),
  cancelBooking: (id: string) => post<{ booking: Booking }>(`/bookings/${id}/cancel`).then((r) => r.booking),
  payOutstanding: (id: string) =>
    post<{ booking: Booking; paymentSheet: PaymentSheetParams }>(`/bookings/${id}/pay-outstanding`),

  providerTools: {
    bookings: (providerId: string) =>
      request<{ bookings: Booking[] }>(`/providers/${providerId}/bookings`, { as: { provider: providerId } }).then(
        (r) => r.bookings,
      ),
    action: (providerId: string, bookingId: string, action: 'complete' | 'no-show' | 'cancel' | 'refund', body?: unknown) =>
      post<{ booking: Booking }>(`/providers/${providerId}/bookings/${bookingId}/${action}`, body, { provider: providerId }).then(
        (r) => r.booking,
      ),
    connectStatus: (providerId: string) =>
      request<{ status: ConnectStatus }>(`/providers/${providerId}/connect/status`, { as: { provider: providerId } }).then(
        (r) => r.status,
      ),
    onboardingLink: (providerId: string) =>
      post<{ url: string }>(`/providers/${providerId}/connect/onboarding-link`, undefined, { provider: providerId }),
    dashboardLink: (providerId: string) =>
      post<{ url: string }>(`/providers/${providerId}/connect/dashboard-link`, undefined, { provider: providerId }),
  },
};
