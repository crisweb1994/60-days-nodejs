import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "SaaS Task Platform",
  description: "Day 47 scaffold for a collaborative task management SaaS",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
