import { getSharedToolUseSection } from "../tool-use"

describe("getSharedToolUseSection", () => {
	it("should include native tool-calling instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("provider-native tool-calling mechanism")
		expect(section).toContain("Do not include XML markup or examples")
	})

	it("uses the on-demand policy by default", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("Use available tools when they materially improve accuracy")
		expect(section).not.toContain("You must call at least one tool per assistant response")
	})

	it("supports the evidence-required policy without forcing irrelevant calls", () => {
		const section = getSharedToolUseSection("evidence-required")

		expect(section).toContain("Before reporting completion")
		expect(section).toContain("Do not call irrelevant tools")
	})

	it("should NOT include single tool per message restriction", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("You must use exactly one tool call per assistant response")
		expect(section).not.toContain("Do not call zero tools or more than one tool")
	})

	it("should NOT include XML formatting instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("<actual_tool_name>")
		expect(section).not.toContain("</actual_tool_name>")
	})
})
