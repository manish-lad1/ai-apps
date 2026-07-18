import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Knowledge Base RAG — grounded answers with citations",
  description:
    "Ask questions against a built-in newsletter + portfolio corpus, or upload your own files and URLs. Every answer is grounded in retrieved sources and cited. Runs on Ollama + Voyage locally, or Claude + Voyage in production.",
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
