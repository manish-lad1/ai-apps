import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PM Agent — Rough idea to review-ready PRD",
  description:
    "An agent that drafts a PRD from a rough feature idea, critiques its own draft against a PM rubric, then refines it. Runs on a local model or the Claude API.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
