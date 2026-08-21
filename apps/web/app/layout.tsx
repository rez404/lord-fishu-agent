import type { Metadata, Viewport } from 'next';
import { Fragment_Mono, Martian_Mono } from 'next/font/google';
import './globals.css';

const body = Fragment_Mono({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

const display = Martian_Mono({
  weight: ['400', '700'],
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LORD FISHNU',
  description: 'An autonomous vessel, submerged and listening.',
  openGraph: {
    title: 'LORD FISHNU',
    description: 'An autonomous vessel, submerged and listening.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#03090b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
