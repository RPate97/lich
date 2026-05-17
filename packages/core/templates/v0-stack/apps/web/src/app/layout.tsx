import type { ReactNode } from 'react';

export const metadata = {
  title: '{{projectName}}',
  description: 'A {{projectName}} app built with levelzero.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
