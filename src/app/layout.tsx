import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Next, Atkinson_Hyperlegible_Mono } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

// next/font self-hosts these at build time, so no runtime request to Google (spec §6.7).
const sans = Atkinson_Hyperlegible_Next({ subsets: ["latin"], variable: "--font-atkinson" });
const mono = Atkinson_Hyperlegible_Mono({ subsets: ["latin"], variable: "--font-atkinson-mono" });

// §11.1: the title is "Family Vault" and nothing more — tab titles and task
// switchers are visible while locked.
export const metadata: Metadata = {
  title: "Family Vault",
  description: "A private family document vault.",
  applicationName: "Family Vault",
  appleWebApp: { capable: true, title: "Family Vault", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
  formatDetection: { telephone: false, date: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F1F2EE" },
    { media: "(prefers-color-scheme: dark)", color: "#111312" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
