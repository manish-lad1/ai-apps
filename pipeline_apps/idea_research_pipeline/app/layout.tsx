import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Idea Research Pipeline",
  description:
    "Take a raw product idea through question generation, human approval, parallel decomposed research, and a report with a critique loop.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
