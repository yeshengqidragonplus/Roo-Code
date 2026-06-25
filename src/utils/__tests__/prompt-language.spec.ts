import { detectPromptLanguage } from "../prompt-language"

describe("detectPromptLanguage", () => {
	it("detects Simplified Chinese", () => {
		expect(detectPromptLanguage("帮我写一个函数来计算斐波那契数列")).toBe("zh-CN")
	})

	it("returns null for English (Latin script)", () => {
		expect(detectPromptLanguage("Refactor this function to use async/await")).toBeNull()
	})

	it("detects Japanese via kana even when Han is mixed in", () => {
		expect(detectPromptLanguage("この関数を非同期にしてください")).toBe("ja")
	})

	it("detects Korean", () => {
		expect(detectPromptLanguage("이 함수를 리팩터링해 주세요")).toBe("ko")
	})

	it("detects Russian (Cyrillic)", () => {
		expect(detectPromptLanguage("Напиши функцию для вычисления чисел Фибоначчи")).toBe("ru")
	})

	it("detects Chinese in prose even when a code fence is present", () => {
		const input = "帮我优化这段代码：\n```ts\nconst add = (a, b) => a + b\n```"
		expect(detectPromptLanguage(input)).toBe("zh-CN")
	})

	it("returns null when only code/paths carry non-Latin-free content", () => {
		// File paths and inline code are stripped; nothing prose-like remains.
		expect(detectPromptLanguage("update `src/index.ts` and run build")).toBeNull()
	})

	it("returns null for empty input", () => {
		expect(detectPromptLanguage("")).toBeNull()
	})
})
