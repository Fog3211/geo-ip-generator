import "~/styles/globals.css";

import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { GoogleAnalytics } from "~/app/_components/analytics";

export const metadata: Metadata = {
    metadataBase: new URL('https://geo-ip-generator.example.com'),
    title: {
        default: 'Geo IP Generator - Generate Real IP Addresses by Country/Region',
        template: '%s | Geo IP Generator'
    },
    description: 'Professional geo-location IP address generation service. Generate real IP addresses from any country or region worldwide.',
    keywords: [
        'geo ip', 'ip generator', 'random ip', 'country ip', 'ipv4', 'ipv6', 'geolocation', 'ip ranges', 'ip2location'
    ],
    icons: [{ rel: 'icon', url: '/favicon.ico' }],
    robots: {
        index: true,
        follow: true,
        nocache: false,
        googleBot: {
            index: true,
            follow: true,
            noimageindex: false
        }
    },
    alternates: {
        canonical: '/'
    },
    openGraph: {
        type: 'website',
        url: 'https://geo-ip-generator.example.com/',
        title: 'Geo IP Generator - Generate Real IP Addresses by Country/Region',
        description: 'Generate real IPv4/IPv6 addresses by country or region. Free, fast, and reliable.',
        images: [
            {
                url: '/favicon.ico',
                width: 64,
                height: 64,
                alt: 'Geo IP Generator'
            }
        ]
    },
    twitter: {
        card: 'summary',
        title: 'Geo IP Generator - Generate Real IP Addresses by Country/Region',
        description: 'Generate real IPv4/IPv6 addresses by country or region. Free, fast, and reliable.'
    },
    manifest: '/site.webmanifest',
    themeColor: '#ffffff'
};

const geist = Geist({
	subsets: ["latin"],
	variable: "--font-geist-sans",
});

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className={`${geist.variable}`}>
			<body>
				<GoogleAnalytics />
				{children}
			</body>
		</html>
	);
}
