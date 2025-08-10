"use client";

import { useState, useEffect, useRef } from "react";
import { trackIpGeneration, trackCountrySearch, trackIpCopy } from "~/lib/utils/analytics";

// Types for API responses
interface Country {
	id: string;
	code2: string;
	nameEn: string;
	nameZh: string;
	continent: string;
	region: string;
}

interface IpData {
	ip: string;
	location: {
		region: string | null;
		city: string | null;
		isp: string | null;
	};
	ipRange: {
		startIp: string;
		endIp: string;
	};
}

interface GenerateIpResponse {
	country: Country;
	ips: IpData[];
	totalRanges: number;
	cached: boolean;
}



interface ApiResponse<T> {
	success: boolean;
	data: T;
	timestamp: string;
}

interface ApiError {
	error: string;
	message: string;
	timestamp: string;
}

const ipCountOptions = Array.from({ length: 10 }, (_, i) => i + 1);

export function IpRegionLookup() {
	const [query, setQuery] = useState("");
	const [generateCount, setGenerateCount] = useState(4);
	const [isClient, setIsClient] = useState(false);
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

    // State for IP generation
	const [generateData, setGenerateData] = useState<GenerateIpResponse | null>(null);
	const [generateLoading, setGenerateLoading] = useState(false);
	const [generateError, setGenerateError] = useState<string | null>(null);

    // Data metadata (last updated)
    const [lastUpdated, setLastUpdated] = useState<string | null>(null);



	useEffect(() => {
		setIsClient(true);
	}, []);

  // Fetch metadata for last updated timestamp
  useEffect(() => {
    const fetchMeta = async () => {
      try {
        const res = await fetch('/api/countries');
        if (!res.ok) return;
        const data = await res.json();
        const meta = data?.data?.meta as { lastUpdated?: string } | undefined;
        if (meta?.lastUpdated) {
          setLastUpdated(meta.lastUpdated);
        }
      } catch (error) {
        // silent
      }
    };
    fetchMeta();
  }, []);

	// Handle click outside dropdown to close it
	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setIsDropdownOpen(false);
			}
		}

		if (isClient) {
			document.addEventListener('mousedown', handleClickOutside);
			return () => {
				document.removeEventListener('mousedown', handleClickOutside);
			};
		}
	}, [isClient]);

	// Safely handle clipboard operations
	const handleCopyToClipboard = async (text: string, isMultiple: boolean = false) => {
		if (!isClient) return;
		
		try {
			await navigator.clipboard.writeText(text);
			if (isClient) {
				trackIpCopy(text, isMultiple);
			}
		} catch (error) {
			console.warn('Failed to copy to clipboard:', error);
		}
	};



	const handleGenerate = async () => {
		if (!query.trim()) return;

		// Track search query only on client
		if (isClient) {
			trackCountrySearch(query.trim());
		}

		try {
			setGenerateLoading(true);
			setGenerateError(null);
			
			const params = new URLSearchParams({
				country: query.trim(),
				count: generateCount.toString(),
			});
			
			const response = await fetch(`/api/generate-ip?${params}`);
			
			if (!response.ok) {
				const errorData: ApiError = await response.json();
				if (isClient) {
					trackIpGeneration(query.trim(), generateCount, false);
				}
				throw new Error(errorData.message || 'Failed to generate IPs');
			}
			
			const result: ApiResponse<GenerateIpResponse> = await response.json();
			setGenerateData(result.data);
			
			// Track successful IP generation only on client
			if (isClient) {
				trackIpGeneration(result.data.country.nameEn, result.data.ips.length, true);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			setGenerateError(errorMessage);
			setGenerateData(null);
		} finally {
			setGenerateLoading(false);
		}
	};

	return (
		<div className="space-y-4 sm:space-y-6">
			{/* Title */}
			<div className="text-center px-2">
				<h2 className="mb-3 sm:mb-4 font-bold text-xl sm:text-2xl md:text-3xl text-gray-800">
					Geo IP Generator
				</h2>
				<p className="text-sm sm:text-base text-gray-600 leading-relaxed">
					Professional service to generate real IP addresses from any country or region worldwide
				</p>
        {lastUpdated && (
          <p className="mt-2 text-xs text-gray-500">Data last updated: {new Date(lastUpdated).toLocaleString()}</p>
        )}
			</div>

			{/* Generation input */}
			<div className="bg-white rounded-lg shadow-md p-4 sm:p-6">
				<div className="space-y-4">
					<label className="block text-sm font-medium text-gray-700">
						Enter country code or name
					</label>
					
					{/* Mobile-optimized responsive layout */}
					<div className="space-y-3 sm:space-y-0 sm:flex sm:gap-3">
						<input
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="e.g: CN, China, 中国, US, America..."
							className="w-full sm:flex-1 px-4 py-3 sm:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-base"
							onKeyPress={(e) => {
								if (e.key === "Enter") {
									handleGenerate();
								}
							}}
						/>
						
						{/* Custom Dropdown */}
						<div className="relative sm:w-32" ref={dropdownRef}>
							<button
								type="button"
								onClick={() => setIsDropdownOpen(!isDropdownOpen)}
								className="flex items-center justify-between w-full sm:w-32 px-4 py-3 bg-white border border-gray-300 rounded-lg hover:border-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 font-medium text-gray-700 text-base"
							>
								<span>{generateCount} IPs</span>
								<svg 
									className={`w-5 h-5 text-gray-500 transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`} 
									fill="none" 
									stroke="currentColor" 
									viewBox="0 0 24 24"
								>
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
								</svg>
							</button>

							{/* Dropdown Menu */}
							{isDropdownOpen && (
								<div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1 max-h-60 overflow-y-auto">
									{ipCountOptions.map((num) => (
										<button
											key={num}
											type="button"
											onClick={() => {
												setGenerateCount(num);
												setIsDropdownOpen(false);
											}}
											className={`w-full px-4 py-3 text-left hover:bg-blue-50 transition-colors duration-150 text-base ${
												generateCount === num 
													? 'bg-blue-100 text-blue-700 font-medium' 
													: 'text-gray-700'
											}`}
										>
											<div className="flex items-center justify-between">
												<span>{num} IPs</span>
												{generateCount === num && (
													<svg className="w-5 h-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
														<path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
													</svg>
												)}
											</div>
										</button>
									))}
								</div>
							)}
						</div>

						<button
							onClick={handleGenerate}
							disabled={!query.trim() || generateLoading}
							className="w-full sm:w-auto px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium text-base min-h-[48px]"
						>
							{generateLoading ? "Generating..." : "Generate IP"}
						</button>
					</div>
				</div>
			</div>

			{/* Generation results */}
			<div className="space-y-4">
				{generateError && (
					<div className="bg-red-50 border border-red-200 rounded-lg p-4">
						<p className="text-red-600 text-sm sm:text-base">
							❌ {generateError}
						</p>
					</div>
				)}

				{generateData && (
					<div className="bg-white rounded-lg shadow-md p-4 sm:p-5">
						{/* Header: compact meta & actions */}
						<div className="mb-3 sm:mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
							<div>
								<h3 className="font-semibold text-base sm:text-lg text-gray-800">
									✅ Generated {generateData.ips.length} IP address{generateData.ips.length > 1 ? 'es' : ''} from {generateData.country.nameZh || generateData.country.nameEn}
								</h3>
								<div className="flex flex-wrap gap-1.5 mt-2">
									<span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-800">
										{generateData.country.id}
									</span>
									{generateData.country.continent && (
										<span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-800">
											{generateData.country.continent}
										</span>
									)}
									{generateData.country.region && (
										<span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-800">
											{generateData.country.region}
										</span>
									)}
									<span className="text-xs text-gray-500 ml-1">
										{generateData.totalRanges.toLocaleString()} ranges{generateData.cached ? ' · cached' : ''}
									</span>
								</div>
							</div>
							{generateData.ips.length > 1 && (
								<button
									onClick={() => {
										const allIps = generateData.ips.map(ip => ip.ip).join('\n');
										handleCopyToClipboard(allIps, true);
									}}
									className="self-start sm:self-auto inline-flex items-center gap-2 px-3 py-2 text-xs sm:text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
								>
									<span className="hidden sm:inline">Copy All</span> 📋
								</button>
							)}
						</div>

						{/* Compact, responsive grid list */}
						<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
							{generateData.ips.map((ipData, index) => (
								<div key={index} className="group border border-gray-200 rounded-lg p-3 bg-white/70 hover:bg-white transition-colors shadow-sm hover:shadow">
									<div className="flex items-start justify-between gap-2">
										<div className="font-mono text-sm md:text-base font-semibold text-blue-700 break-all leading-6">
											{ipData.ip}
										</div>
										<button
											aria-label="Copy IP"
											title="Copy"
											onClick={() => handleCopyToClipboard(ipData.ip, false)}
											className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-100"
										>
											<svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
										</button>
									</div>
									<div className="mt-1.5 text-[11px] text-gray-600 leading-5">
										<span className="text-gray-400">🔗</span> {ipData.ipRange.startIp} - {ipData.ipRange.endIp}
										{ipData.location.isp && (
											<span className="ml-2 text-gray-500">· ISP: {ipData.location.isp}</span>
										)}
									</div>
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
} 