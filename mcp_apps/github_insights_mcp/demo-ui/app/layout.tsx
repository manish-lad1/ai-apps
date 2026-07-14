import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GitHub Insights — chat with a repo",
  description:
    "A reference MCP client: ask natural-language questions about a GitHub repo and watch an LLM decide which read-only tools to call, with a visible tool trace.",
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
