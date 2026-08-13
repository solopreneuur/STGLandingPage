import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const TITLE = "StudyTheGame — Find and break down the best videos in your niche";
const DESCRIPTION =
  "Find the outlier reels in your niche and break down why they worked — so your next video actually has a shot at going viral.";

// Inline SVG favicon: black rounded square, yellow "S". Carried from the
// original page — no favicon files exist or are needed.
const FAVICON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='7'%20fill='%230E0E12'/%3E%3Ctext%20x='16'%20y='23'%20font-family='Arial,sans-serif'%20font-size='22'%20font-weight='900'%20fill='%23FAFF00'%20text-anchor='middle'%3ES%3C/text%3E%3C/svg%3E";

export const metadata: Metadata = {
  metadataBase: new URL("https://studythegame.app"),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "https://studythegame.app" },
  icons: { icon: FAVICON, apple: FAVICON },
  openGraph: {
    type: "website",
    siteName: "StudyTheGame",
    title: TITLE,
    description: DESCRIPTION,
    url: "https://studythegame.app",
    images: [
      {
        url: "https://studythegame.app/og-image.png",
        width: 1200,
        height: 630,
        type: "image/png",
        alt: "StudyTheGame",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["https://studythegame.app/og-image.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0E0E12",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Google Fonts via <link>, deliberately NOT next/font/google — that
            fetches at build time and a cold cache offline breaks the build. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;500;600&family=Rubik+Mono+One&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {/* Moody atmosphere layers (decorative, non-interactive) */}
        <div className="ambient" aria-hidden="true" />
        <div className="grain" aria-hidden="true" />
        {/* No width constraint here: the results feed is full-viewport.
            Pages that want the narrow column wrap themselves in <Shell>. */}
        <div className="relative z-[2]">{children}</div>
        <Analytics />
      </body>
    </html>
  );
}
