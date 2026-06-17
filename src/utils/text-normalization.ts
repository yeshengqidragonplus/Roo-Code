/**
 * Common character mappings for normalization
 */
export const NORMALIZATION_MAPS = {
	// Smart quotes to regular quotes
	SMART_QUOTES: {
		"\u201C": '"', // Left double quote (U+201C)
		"\u201D": '"', // Right double quote (U+201D)
		"\u2018": "'", // Left single quote (U+2018)
		"\u2019": "'", // Right single quote (U+2019)
	},
	// Other typographic characters
	TYPOGRAPHIC: {
		"\u2026": "...", // Ellipsis
		"\u2014": "-", // Em dash
		"-": "-", // En dash
		"\u00A0": " ", // Non-breaking space
	},
}

/**
 * Matches zero-width and directional-control characters that are invisible in
 * editors but break exact string comparison (they are not matched by `\s`).
 * U+200B-U+200D (zero-width space/non-joiner/joiner), U+200E/U+200F (LTR/RTL
 * marks), U+2060 (word joiner), U+FEFF (BOM / zero-width no-break space).
 */
const ZERO_WIDTH_REGEX = /[\u200B-\u200F\u2060\uFEFF]/g

/**
 * Converts full-width characters to their half-width ASCII equivalents.
 * Full-width ASCII punctuation/letters/digits live at U+FF01-U+FF5E (offset
 * 0xFEE0 from U+0021-U+007E); the ideographic space U+3000 maps to a regular
 * space. This is what makes e.g. a full-width "\uFF08\uFF09\uFF0C\uFF01\uFF1F\uFF1A\uFF1B" match the
 * half-width "(),!?:;" a model commonly emits.
 */
function toHalfWidth(str: string): string {
	return str.replace(/[\uFF01-\uFF5E\u3000]/g, (ch) => {
		const code = ch.charCodeAt(0)
		return code === 0x3000 ? " " : String.fromCharCode(code - 0xfee0)
	})
}

/**
 * Options for string normalization
 */
export interface NormalizeOptions {
	unicodeNormalize?: boolean // Apply Unicode NFC normalization (collapses NFD combining sequences)
	fullWidth?: boolean // Convert full-width ASCII/punctuation to half-width
	zeroWidth?: boolean // Strip zero-width and directional-control characters
	smartQuotes?: boolean // Replace smart quotes with straight quotes
	typographicChars?: boolean // Replace typographic characters
	extraWhitespace?: boolean // Collapse multiple whitespace to single space
	trim?: boolean // Trim whitespace from start and end
}

/**
 * Default options for normalization
 */
const DEFAULT_OPTIONS: NormalizeOptions = {
	unicodeNormalize: true,
	fullWidth: true,
	zeroWidth: true,
	smartQuotes: true,
	typographicChars: true,
	extraWhitespace: true,
	trim: true,
}

/**
 * Normalizes a string based on the specified options
 *
 * @param str The string to normalize
 * @param options Normalization options
 * @returns The normalized string
 */
export function normalizeString(str: string, options: NormalizeOptions = DEFAULT_OPTIONS): string {
	const opts = { ...DEFAULT_OPTIONS, ...options }
	let normalized = str

	// Apply Unicode NFC normalization so that decomposed (NFD) sequences — e.g.
	// "e" + U+0301 vs a single "é" — compare equal. macOS file paths/content are
	// a common source of NFD text.
	if (opts.unicodeNormalize) {
		normalized = normalized.normalize("NFC")
	}

	// Strip zero-width / directional-control characters that are invisible but
	// break exact comparison.
	if (opts.zeroWidth) {
		normalized = normalized.replace(ZERO_WIDTH_REGEX, "")
	}

	// Convert full-width characters to half-width (e.g. "（），" -> "(),")
	if (opts.fullWidth) {
		normalized = toHalfWidth(normalized)
	}

	// Replace smart quotes
	if (opts.smartQuotes) {
		for (const [smart, regular] of Object.entries(NORMALIZATION_MAPS.SMART_QUOTES)) {
			normalized = normalized.replace(new RegExp(smart, "g"), regular)
		}
	}

	// Replace typographic characters
	if (opts.typographicChars) {
		for (const [typographic, regular] of Object.entries(NORMALIZATION_MAPS.TYPOGRAPHIC)) {
			normalized = normalized.replace(new RegExp(typographic, "g"), regular)
		}
	}

	// Normalize whitespace
	if (opts.extraWhitespace) {
		normalized = normalized.replace(/\s+/g, " ")
	}

	// Trim whitespace
	if (opts.trim) {
		normalized = normalized.trim()
	}

	return normalized
}

/**
 * Unescapes common HTML entities in a string
 *
 * @param text The string containing HTML entities to unescape
 * @returns The unescaped string with HTML entities converted to their literal characters
 */
export function unescapeHtmlEntities(text: string): string {
	if (!text) return text

	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#91;/g, "[")
		.replace(/&#93;/g, "]")
		.replace(/&lsqb;/g, "[")
		.replace(/&rsqb;/g, "]")
		.replace(/&amp;/g, "&")
}
