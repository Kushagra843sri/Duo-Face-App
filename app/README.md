# Duo-Face — mobile app

Expo React Native app for the Merchant and Delivery Partner interfaces. See the repository root [README](../README.md) for the full project overview and how the app and server fit together.

## Get started

```bash
npm install
npx expo start
```

## Structure

File-based routing via Expo Router. `app/index.tsx` is the entry point that will eventually resolve the logged-in user's role and route into `app/(merchant)/` or `app/(driver)/` — both are placeholder screens until Phase 2/3.

- `app/` — routes (Expo Router)
- `components/` — shared UI
- `api/` — server API client
- `socket/` — reserved for realtime (Phase 3+)
- `hooks/`, `lib/`, `types/`, `constants/` — shared client utilities

## Scripts

- `npx expo start` — dev server
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript check
