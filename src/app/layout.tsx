import type { Metadata, Viewport } from 'next';

import { getMenuIndex } from '@/domain/menu';
import './globals.css';

/**
 * Metadata is read from the catalogue so the page title follows the restaurant
 * in `menu.json` rather than being hard-coded in two places.
 */
export function generateMetadata(): Metadata {
  const { menu } = getMenuIndex();
  return {
    title: `${menu.restaurant.name} — Voice Ordering`,
    description: `Order from ${menu.restaurant.name} by voice. Say what you want, change your mind, and confirm before it goes to the kitchen.`,
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  // Matches the paper background, so mobile browser chrome blends into the page.
  themeColor: '#fbf7f3',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
