import type { ModeConfig } from "@roo-code/types"

vi.mock("vscode", () => ({}))

vi.mock("../../../../utils/globalContext", () => ({
	ensureSettingsDirectoryExists: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../../shared/modes", () => ({
	getAllModesWithPrompts: vi.fn(),
	getModeBySlug: vi.fn(),
}))

import { getModesSection } from "../modes"
import { getAllModesWithPrompts, getModeBySlug } from "../../../../shared/modes"

const mockContext = {} as any

const leadMode: ModeConfig = {
	slug: "arthur",
	name: "Arthur",
	roleDefinition: "Lead engineer prompt.",
	whenToUse: "Lead session.",
	description: "Lead",
	groups: ["read", "edit"],
	hidden: true,
}

const kbResearcher: ModeConfig = {
	slug: "kb-researcher",
	name: "KB Researcher",
	roleDefinition: "KB searcher.",
	whenToUse: "Search local KB.",
	description: "KB",
	groups: ["read"],
}

const webResearcher: ModeConfig = {
	slug: "web-researcher",
	name: "Web Researcher",
	roleDefinition: "Web searcher.",
	whenToUse: "Search the web.",
	description: "Web",
	groups: ["read"],
}

const codeMode: ModeConfig = {
	slug: "code",
	name: "Code",
	roleDefinition: "Engineer.",
	whenToUse: "Write code.",
	description: "Code",
	groups: ["read", "edit"],
}

const allModes: ModeConfig[] = [leadMode, kbResearcher, webResearcher, codeMode]

const workgroupMode: ModeConfig = {
	slug: "zhangu-game-studio",
	name: "战鼓工作室",
	roleDefinition: "Workgroup execution context.",
	whenToUse: "Unity tasks.",
	description: "Studio",
	groups: ["read"],
	kind: "autonomous",
	workgroup: {
		leadModeSlug: "arthur",
		instructions: "以主程身份工作，串行委派。",
		colleagueSlugs: ["kb-researcher", "web-researcher", "arthur"],
	},
}

const expertMode: ModeConfig = {
	slug: "kb-researcher",
	name: "KB Researcher",
	roleDefinition: "KB searcher.",
	whenToUse: "Search local KB.",
	description: "KB",
	groups: ["read"],
	kind: "autonomous",
}

describe("getModesSection", () => {
	beforeEach(() => {
		vi.mocked(getAllModesWithPrompts).mockResolvedValue(allModes)
		vi.mocked(getModeBySlug).mockImplementation(
			(slug: string, customModes?: ModeConfig[]) => customModes?.find((m) => m.slug === slug),
		)
	})

	describe("workgroup runtime mode", () => {
		it("lists only colleagues, excluding the lead and non-members", async () => {
			const result = await getModesSection(mockContext, "zhangu-game-studio", [workgroupMode, ...allModes])

			expect(result).toContain("WORKGROUP COLLEAGUES")
			expect(result).toContain("kb-researcher")
			expect(result).toContain("web-researcher")
			// The lead executes the workgroup itself; it must not be listed as a
			// delegable colleague.
			expect(result).not.toContain("arthur")
			// Non-colleague modes stay out of the workgroup prompt.
			expect(result).not.toContain("code")
		})

		it("shows the lead's display name and appends workgroup instructions", async () => {
			const result = await getModesSection(mockContext, "zhangu-game-studio", [workgroupMode, ...allModes])

			expect(result).toContain("You are working as Arthur in the \"战鼓工作室\" workgroup.")
			expect(result).toContain("WORKGROUP RULES")
			expect(result).toContain("以主程身份工作，串行委派。")
		})

		it("falls back to the workgroup name when no lead is configured", async () => {
			const legacy: ModeConfig = { ...workgroupMode, workgroup: { colleagueSlugs: ["kb-researcher"] } }
			const result = await getModesSection(mockContext, "zhangu-game-studio", [legacy, ...allModes])

			expect(result).toContain("You are working as 战鼓工作室 in the \"战鼓工作室\" workgroup.")
			expect(result).not.toContain("WORKGROUP RULES")
		})
	})

	describe("expert runtime mode", () => {
		it("returns an empty section so experts stay self-contained", async () => {
			await expect(getModesSection(mockContext, "kb-researcher", [expertMode, ...allModes])).resolves.toBe("")
		})
	})

	describe("plain runtime mode", () => {
		it("lists all non-hidden modes for switch_mode", async () => {
			const result = await getModesSection(mockContext, "code", allModes)

			expect(result).toContain("MODES")
			expect(result).toContain("code")
			expect(result).toContain("kb-researcher")
			// Hidden modes are delegable via new_task but never advertised.
			expect(result).not.toContain("arthur")
		})
	})
})
