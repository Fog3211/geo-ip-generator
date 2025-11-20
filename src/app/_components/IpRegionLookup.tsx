"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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

interface CountrySuggestion {
	id: string;
	code2: string;
	nameEn: string;
	nameZh: string | null;
}

const ipCountOptions = Array.from({ length: 10 }, (_, i) => i + 1);

export function IpRegionLookup() {
	const [query, setQuery] = useState("");
	const [generateCount, setGenerateCount] = useState(4);
	const [useAI, setUseAI] = useState(false); // Toggle between standard and AI API
	const [isClient, setIsClient] = useState(false);
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const [showSuggestions, setShowSuggestions] = useState(false);
	const [suggestions, setSuggestions] = useState<CountrySuggestion[]>([]);
	const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
	const [highlightedIndex, setHighlightedIndex] = useState(-1);
	
	const dropdownRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const suggestionsRef = useRef<HTMLDivElement>(null);

	// State for IP generation
	const [generateData, setGenerateData] = useState<GenerateIpResponse | null>(null);
	const [generateLoading, setGenerateLoading] = useState(false);
	const [generateError, setGenerateError] = useState<string | null>(null);

	// Data metadata (last updated)
	const [lastUpdated, setLastUpdated] = useState<string | null>(null);
	const [allCountries, setAllCountries] = useState<CountrySuggestion[]>([]);

	useEffect(() => {
		setIsClient(true);
	}, []);

	// Fetch all countries for suggestions
	useEffect(() => {
		const fetchCountries = async () => {
			try {
				const res = await fetch('/api/countries');
				if (!res.ok) return;
				const data = await res.json();
				if (data.success && data.data?.countries) {
					const countries = data.data.countries.map((c: Country) => ({
						id: c.id,
						code2: c.code2,
						nameEn: c.nameEn,
						nameZh: c.nameZh,
					}));
					setAllCountries(countries);
				}
				const meta = data?.data?.meta as { lastUpdated?: string } | undefined;
				if (meta?.lastUpdated) {
					setLastUpdated(meta.lastUpdated);
				}
			} catch (error) {
				// silent
			}
		};
		fetchCountries();
	}, []);

	// Filter suggestions based on query
	useEffect(() => {
		if (!query.trim() || !allCountries.length) {
			setSuggestions([]);
			setShowSuggestions(false);
			return;
		}

		const normalizedQuery = query.trim().toLowerCase();
		const filtered = allCountries
			.filter(country => {
				const nameEnLower = country.nameEn.toLowerCase();
				const nameZhLower = country.nameZh?.toLowerCase() ?? '';
				const code2Lower = country.code2.toLowerCase();
				const idLower = country.id.toLowerCase();
				
				return nameEnLower.includes(normalizedQuery) ||
					nameZhLower.includes(normalizedQuery) ||
					code2Lower.includes(normalizedQuery) ||
					idLower.includes(normalizedQuery);
			})
			.slice(0, 8); // Limit to 8 suggestions

		setSuggestions(filtered);
		setShowSuggestions(filtered.length > 0);
		setHighlightedIndex(-1);
	}, [query, allCountries]);

	// Handle click outside dropdown to close it
	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setIsDropdownOpen(false);
			}
			if (suggestionsRef.current && !suggestionsRef.current.contains(event.target as Node) &&
				inputRef.current && !inputRef.current.contains(event.target as Node)) {
				setShowSuggestions(false);
			}
		}

		if (isClient) {
			document.addEventListener('mousedown', handleClickOutside);
			return () => {
				document.removeEventListener('mousedown', handleClickOutside);
			};
		}
	}, [isClient]);

	// Handle keyboard navigation in suggestions
	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (!showSuggestions || suggestions.length === 0) {
			if (e.key === "Enter") {
				handleGenerate();
			}
			return;
		}

		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				setHighlightedIndex(prev => 
					prev < suggestions.length - 1 ? prev + 1 : prev
				);
				break;
			case "ArrowUp":
				e.preventDefault();
				setHighlightedIndex(prev => prev > 0 ? prev - 1 : -1);
				break;
			case "Enter":
				e.preventDefault();
				if (highlightedIndex >= 0 && suggestions[highlightedIndex]) {
					selectSuggestion(suggestions[highlightedIndex]);
				} else {
					handleGenerate();
				}
				break;
			case "Escape":
				setShowSuggestions(false);
				inputRef.current?.blur();
				break;
		}
	}, [showSuggestions, suggestions, highlightedIndex]);

	const selectSuggestion = (country: CountrySuggestion) => {
		setQuery(country.nameEn);
		setShowSuggestions(false);
		inputRef.current?.blur();
		setHighlightedIndex(-1);
	};

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
			setShowSuggestions(false);
			
			const params = new URLSearchParams({
				country: query.trim(),
				count: generateCount.toString(),
			});
			
			// Use AI API if enabled, otherwise use standard API
			const apiEndpoint = useAI ? '/api/generate-ip-ai' : '/api/generate-ip';
			const response = await fetch(`${apiEndpoint}?${params}`);
			
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
					<p className="mt-2 text-xs text-gray-500">
						Data last updated: {new Date(lastUpdated).toLocaleString()}
					</p>
				)}
			</div>

			{/* Generation input */}
			<div className="bg-white rounded-xl shadow-lg p-4 sm:p-6 border border-gray-100">
				<div className="space-y-4">
					<div className="flex items-center justify-between">
						<label className="block text-sm font-medium text-gray-700">
							Enter country code or name
						</label>
						{/* AI Mode Toggle */}
						<button
							type="button"
							onClick={() => setUseAI(!useAI)}
							className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
								useAI ? 'bg-blue-600' : 'bg-gray-300'
							}`}
							role="switch"
							aria-checked={useAI}
							aria-label="Toggle AI mode"
						>
							<span
								className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
									useAI ? 'translate-x-6' : 'translate-x-1'
								}`}
							/>
						</button>
					</div>
					<div className="flex items-center gap-2 text-xs text-gray-600">
						<span className={`px-2 py-1 rounded ${useAI ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
							{useAI ? '🤖 AI Mode' : '⚡ Standard Mode'}
						</span>
						<span className="text-gray-500">
							{useAI 
								? 'Supports natural language (e.g., "Deutschland", "日本")'
								: 'Fast mode: codes (CN, US) or exact names (China, 中国)'
							}
						</span>
					</div>
					
					{/* Mobile-optimized responsive layout */}
					<div className="space-y-3 sm:space-y-0 sm:flex sm:gap-3">
						<div className="relative flex-1">
							<input
								ref={inputRef}
								type="text"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onFocus={() => query.trim() && suggestions.length > 0 && setShowSuggestions(true)}
								onKeyDown={handleKeyDown}
								placeholder="e.g: CN, China, 中国, US, America, 日本, Deutschland..."
								className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-base transition-all"
							/>
							
							{/* Suggestions dropdown */}
							{showSuggestions && suggestions.length > 0 && (
								<div
									ref={suggestionsRef}
									className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl max-h-64 overflow-y-auto"
								>
									{suggestions.map((country, index) => (
										<button
											key={country.id}
											type="button"
											onClick={() => selectSuggestion(country)}
											className={`w-full px-4 py-3 text-left hover:bg-blue-50 transition-colors duration-150 text-sm ${
												highlightedIndex === index
													? 'bg-blue-100 text-blue-700'
													: 'text-gray-700'
											}`}
										>
											<div className="flex items-center justify-between">
												<div className="flex items-center gap-2">
													<span className="font-medium">{country.nameEn}</span>
													{country.nameZh && (
														<span className="text-gray-500">({country.nameZh})</span>
													)}
												</div>
												<span className="text-xs font-mono text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
													{country.code2}
												</span>
											</div>
										</button>
									))}
								</div>
							)}
						</div>
						
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
							className="w-full sm:w-auto px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-medium text-base min-h-[48px] shadow-md hover:shadow-lg transform hover:-translate-y-0.5 disabled:transform-none"
						>
							{generateLoading ? (
								<span className="flex items-center gap-2">
									<svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
										<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
										<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
									</svg>
									Generating...
								</span>
							) : (
								"Generate IP"
							)}
						</button>
					</div>
				</div>
			</div>

			{/* Generation results */}
			<div className="space-y-4">
				{generateError && (
					<div className="bg-red-50 border-l-4 border-red-400 rounded-lg p-4 animate-fade-in">
						<div className="flex items-start">
							<svg className="w-5 h-5 text-red-400 mt-0.5 mr-3" fill="currentColor" viewBox="0 0 20 20">
								<path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
							</svg>
							<p className="text-red-700 text-sm sm:text-base">
								{generateError}
							</p>
						</div>
					</div>
				)}

				{generateData && (
					<div className="bg-white rounded-xl shadow-lg p-4 sm:p-5 border border-gray-100 animate-fade-in">
						{/* Header: compact meta & actions */}
						<div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
							<div className="flex-1">
								<h3 className="font-semibold text-base sm:text-lg text-gray-800 mb-2">
									<span className="inline-flex items-center gap-2">
										<svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
											<path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
										</svg>
										Generated {generateData.ips.length} IP address{generateData.ips.length > 1 ? 'es' : ''} from {generateData.country.nameZh || generateData.country.nameEn}
									</span>
								</h3>
								<div className="flex flex-wrap gap-2 mt-2">
									<span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
										{generateData.country.id}
									</span>
									{generateData.country.continent && (
										<span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">
											{generateData.country.continent}
										</span>
									)}
									{generateData.country.region && (
										<span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800 border border-purple-200">
											{generateData.country.region}
										</span>
									)}
									<span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200">
										{generateData.totalRanges.toLocaleString()} ranges
									</span>
									{generateData.cached && (
										<span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 border border-yellow-200">
											cached
										</span>
									)}
								</div>
							</div>
							{generateData.ips.length > 1 && (
								<button
									onClick={() => {
										const allIps = generateData.ips.map(ip => ip.ip).join('\n');
										handleCopyToClipboard(allIps, true);
									}}
									className="self-start sm:self-auto inline-flex items-center gap-2 px-4 py-2 text-sm bg-gradient-to-r from-gray-100 to-gray-200 hover:from-gray-200 hover:to-gray-300 text-gray-700 rounded-lg transition-all shadow-sm hover:shadow"
								>
									<svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
										<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
									</svg>
									<span className="hidden sm:inline">Copy All</span>
									<span className="sm:hidden">All</span>
								</button>
							)}
						</div>

						{/* Compact, responsive grid list */}
						<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4 mt-4">
							{generateData.ips.map((ipData, index) => (
								<div 
									key={index} 
									className="group border-2 border-gray-200 rounded-lg p-4 bg-gradient-to-br from-white to-gray-50 hover:from-blue-50 hover:to-white transition-all shadow-sm hover:shadow-md hover:border-blue-300"
								>
									<div className="flex items-start justify-between gap-2 mb-2">
										<div className="font-mono text-base md:text-lg font-bold text-blue-700 break-all leading-6">
											{ipData.ip}
										</div>
										<button
											aria-label="Copy IP"
											title="Copy"
											onClick={() => handleCopyToClipboard(ipData.ip, false)}
											className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 transition-all hover:scale-110"
										>
											<svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
												<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
												<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
											</svg>
										</button>
									</div>
									<div className="space-y-1 text-xs text-gray-600">
										<div className="flex items-center gap-1">
											<svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
											</svg>
											<span className="font-mono">{ipData.ipRange.startIp} - {ipData.ipRange.endIp}</span>
										</div>
										{ipData.location.isp && (
											<div className="flex items-center gap-1 text-gray-500">
												<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
												</svg>
												<span>ISP: {ipData.location.isp}</span>
											</div>
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
