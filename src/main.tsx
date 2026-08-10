import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import './index.css'
import App from './App.tsx'
import { privyAppId, privyEnabled } from './lib/privy.ts'

if (!privyEnabled) {
  // eslint-disable-next-line no-console
  console.warn(
    '[up.meme] VITE_PRIVY_APP_ID is not set — wallet login is disabled. ' +
      'Create an app at dashboard.privy.io and add it to .env.local',
  )
}

const app = <App />

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {privyEnabled ? (
      <PrivyProvider
        appId={privyAppId!}
        config={{
          // solana-only platform — wallet login, no email/social
          loginMethods: ['wallet'],
          appearance: {
            theme: 'dark',
            accentColor: '#5fcb88',
            logo: '/logo-white.png',
            landingHeader: 'enter up.meme',
            showWalletLoginFirst: true,
            walletChainType: 'solana-only',
            // recommended solana wallets, in order; detected wallets follow
            walletList: ['phantom', 'solflare', 'backpack', 'detected_solana_wallets'],
          },
          embeddedWallets: {
            solana: { createOnLogin: 'users-without-wallets' },
          },
        }}
      >
        {app}
      </PrivyProvider>
    ) : (
      app
    )}
  </StrictMode>,
)
