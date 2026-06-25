import { type Language } from "@roo-code/types"

/**
 * Detects the dominant natural language of a user prompt.
 *
 * Lightweight script-range heuristic that avoids pulling in heavy NLP
 * libraries. It only recognizes languages that have a distinct, non-Latin
 * script, and only returns codes that exist in the shared LANGUAGES map
 * (src/shared/language.ts). Latin-script input (English, and most European
 * languages) intentionally returns null so the caller can fall back to a
 * neutral "keep the same language" instruction rather than mislabeling it.
 *
 * Order matters: Hiragana/Katakana and Hangul are checked before Han,
 * because Japanese and Korean text frequently mixes in Han characters.
 */
const SCRIPT_RANGES: Array<[RegExp, Language]> = [
	[/[぀-ゟ゠-ヿ]/, "ja"], // Hiragana + Katakana (before Han)
	[/[가-힯]/, "ko"], // Hangul (before Han)
	[/[一-鿿㐀-䶿]/, "zh-CN"], // CJK Unified (Han)
	[/[Ѐ-ӿ]/, "ru"], // Cyrillic
	[/[ऀ-ॿ]/, "hi"], // Devanagari
	[/[ưẠ-ỹ]/, "vi"], // Vietnamese diacritics
]

/**
 * @returns a Language code present in LANGUAGES, or null when no distinct
 * non-Latin script is detected (e.g. plain English).
 */
export function detectPromptLanguage(text: string): Language | null {
	if (!text) {
		return null
	}

	// Strip code fences, inline code, URLs, and file paths so that prose,
	// not code, drives the detection.
	const stripped = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[@/\\.\w-]+\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|cpp|c|rb|php|css|html|json|md)\b/gi, " ")

	for (const [regex, lang] of SCRIPT_RANGES) {
		if (regex.test(stripped)) {
			return lang
		}
	}

	return null
}
