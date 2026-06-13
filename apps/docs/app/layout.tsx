import type { Metadata } from "next";
import localFont from "next/font/local";
import { Provider } from "./provider";
import { SITE_DESCRIPTION, SITE_TAGLINE, SITE_URL } from "@/lib/site";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    template: "%s | OpenAcme",
    default: `OpenAcme — ${SITE_TAGLINE}`,
  },
  description: SITE_DESCRIPTION,
  manifest: "/site.webmanifest",
  openGraph: {
    siteName: "OpenAcme",
    title: SITE_TAGLINE,
    description: SITE_DESCRIPTION,
    images: ["/og/default.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TAGLINE,
    description: SITE_DESCRIPTION,
    images: ["/og/default.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="paper-surface flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
