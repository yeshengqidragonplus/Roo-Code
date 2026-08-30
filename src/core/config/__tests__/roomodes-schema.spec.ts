import * as fs from "fs"
import * as path from "path"
import * as yaml from "yaml"
import { customModesSettingsSchema } from "@roo-code/types"

// Validates the real project .roomodes against the shipped schema so a config
// typo cannot silently disable every project mode (see roomodes-schema-version-skew).
describe(".roomodes schema validation", () => {
	const roomodesPath = path.join(__dirname, "..", "..", "..", "..", ".roomodes")

	it("parses and validates against customModesSettingsSchema", () => {
		const doc = yaml.parse(fs.readFileSync(roomodesPath, "utf8"))
		const parsed = customModesSettingsSchema.safeParse(doc)

		expect(parsed.success).toBe(true)
		if (!parsed.success) return

		const arthur = parsed.data.customModes.find((m) => m.slug === "arthur")
		const zhangu = parsed.data.customModes.find((m) => m.slug === "zhangu-game-studio")

		// Expert mode: no delegation block, group content stripped from the prompt.
		expect(arthur?.delegation).toBeUndefined()
		expect(arthur?.hidden).toBe(true)
		expect(arthur?.roleDefinition).not.toContain("委派")
		expect(arthur?.roleDefinition).not.toContain("最终负责人")
		expect(arthur?.roleDefinition).toContain("Roslyn")

		// Workgroup: lead placeholder + instructions carry the lead identity.
		expect(zhangu?.workgroup?.leadModeSlug).toBe("arthur")
		expect(zhangu?.workgroup?.instructions).toContain("主程")
		expect(zhangu?.workgroup?.instructions).toContain("web-researcher")
		expect(zhangu?.workgroup?.colleagueSlugs).toContain("arthur")
		expect(zhangu?.roleDefinition).not.toContain("协调者")
	})
})
