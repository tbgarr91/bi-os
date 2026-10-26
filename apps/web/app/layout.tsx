import type { ReactNode } from "react";

export const metadata = { title: "BI OS", description: "Business Intelligence OS (pre-release)" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 720, padding: "0 1rem" }}>{children}</body>
    </html>
  );
}
