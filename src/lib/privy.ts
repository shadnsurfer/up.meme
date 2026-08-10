export const privyAppId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;

/** only mount PrivyProvider with a real app id — an invalid id crashes the app */
export const privyEnabled = typeof privyAppId === 'string' && privyAppId.length > 0;
