import type { Metadata } from "next";

import "./globals.css";
import { Providers } from "@/app/providers";

export const metadata: Metadata = {
  title: "Relay — Team task workspace",
  description: "Plan, coordinate, and finish team work in one focused workspace.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
