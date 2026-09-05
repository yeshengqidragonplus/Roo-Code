import { getSkillsSection } from "../skills"

describe("getSkillsSection", () => {
	it("should emit <available_skills> XML with name, description, and location", async () => {
		const mockSkillsManager = {
			getSkillsByNames: vi.fn().mockReturnValue([
				{
					name: "pdf-processing",
					description: "Extracts text & tables from PDFs",
					path: "/abs/path/pdf-processing/SKILL.md",
					source: "global" as const,
				},
			]),
		}

		const result = await getSkillsSection(mockSkillsManager, ["pdf-processing"])

		expect(result).toContain("<available_skills>")
		expect(result).toContain("</available_skills>")
		expect(result).toContain("<skill>")
		expect(result).toContain("<name>pdf-processing</name>")
		// Ensure XML escaping for '&'
		expect(result).toContain("<description>Extracts text &amp; tables from PDFs</description>")
		// For filesystem-based agents, location should be the absolute path to SKILL.md
		expect(result).toContain("<location>/abs/path/pdf-processing/SKILL.md</location>")
	})

	it("should return empty string when skillsManager or assigned Skill names are missing", async () => {
		await expect(getSkillsSection(undefined, ["pdf-processing"])).resolves.toBe("")
		await expect(getSkillsSection({ getSkillsByNames: vi.fn() }, undefined)).resolves.toBe("")
		await expect(getSkillsSection({ getSkillsByNames: vi.fn() }, [])).resolves.toBe("")
	})
})
