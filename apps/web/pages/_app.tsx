import type { AppProps } from "next/app";
import Head from "next/head";
import { SITE_DESCRIPTION, SITE_NAME } from "../lib/site";
import "../styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>{SITE_NAME}</title>
        <meta name="description" content={SITE_DESCRIPTION} />
        {/* viewport-fit=cover lets the device run under the notch and home bar;
            the corner controls keep clear of them with env(safe-area-inset-*). */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0f0e0d" />
        <link rel="icon" href="/icons/favicon-night.svg" type="image/svg+xml" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
