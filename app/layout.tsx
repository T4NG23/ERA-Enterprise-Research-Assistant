import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scholar Flow",
  description:
    "Prepare venue-aware academic paper submission packages with Scholar Flow.",
  icons: {
    icon: "/scholar-flow-mark.svg",
    shortcut: "/scholar-flow-mark.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
