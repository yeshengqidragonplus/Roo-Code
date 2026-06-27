import { describe, it, expect } from "vitest"
import {
	expertKindSchema,
	toolPolicySchema,
	expertModeFields,
	validateExpertConfig,
	type ExpertConfig,
} from "../expert.js"
import { modeConfigSchema } from "../mode.js"

describe("toolPolicySchema", () => {
	it("accepts an empty object (default fail-safe: nothing allowed)", () => {
		expect(toolPolicySchema.parse({})).toEqual({})
	})

	it("accepts allowedTools as a list of exact tool names", () => {
		const parsed = toolPolicySchema.parse({
			allowedTools: ["read_file", "list_files", "crawler_a"],
		})
		expect(parsed.allowedTools).toEqual(["read_file", "list_files", "crawler_a"])
	})

	it("accepts allowedCategories from the fixed enum", () => {
		const parsed = toolPolicySchema.parse({ allowedCategories: ["read", "mcp"] })
		expect(parsed.allowedCategories).toEqual(["read", "mcp"])
	})

	it("accepts both allowedTools and allowedCategories together", () => {
		const parsed = toolPolicySchema.parse({
			allowedTools: ["crawler_a"],
			allowedCategories: ["mcp"],
		})
		expect(parsed.allowedTools).toEqual(["crawler_a"])
		expect(parsed.allowedCategories).toEqual(["mcp"])
	})

	it("rejects an invalid category", () => {
		expect(() => toolPolicySchema.parse({ allowedCategories: ["nuclear"] })).toThrow()
	})

	it("rejects non-string tool names", () => {
		expect(() => toolPolicySchema.parse({ allowedTools: [123] })).toThrow()
	})

	it("the schema itself is required; optionality is applied at the field level", () => {
		// toolPolicySchema is a plain object schema; expertModeFields wraps it as
		// .optional(), so a mode config may omit toolPolicy, but parsing undefined
		// directly into the object schema is an error (not optional here).
		expect(() => toolPolicySchema.parse(undefined)).toThrow()
	})
})

describe("expertModeFields includes toolPolicy", () => {
	it("exposes toolPolicy as an optional field", () => {
		expect(expertModeFields).toHaveProperty("toolPolicy")
	})

	it("a mode config with toolPolicy validates", () => {
		const config = {
			slug: "crawler-flow",
			name: "Crawler Flow",
			roleDefinition: "You are a workflow expert.",
			groups: ["read"],
			kind: "workflow",
			workflow: { workflowId: "crawl" },
			toolPolicy: { allowedTools: ["crawler_a", "crawler_b"], allowedCategories: ["mcp"] },
		}
		const parsed = modeConfigSchema.parse(config)
		expect(parsed.toolPolicy?.allowedTools).toEqual(["crawler_a", "crawler_b"])
		expect(parsed.toolPolicy?.allowedCategories).toEqual(["mcp"])
	})

	it("a mode config without toolPolicy still validates (default empty)", () => {
		const config = {
			slug: "plain",
			name: "Plain",
			roleDefinition: "You are helpful.",
			groups: ["read"],
		}
		const parsed = modeConfigSchema.parse(config)
		expect(parsed.toolPolicy).toBeUndefined()
	})
})

describe("expertKindSchema", () => {
	it("accepts autonomous and workflow", () => {
		expect(expertKindSchema.parse("autonomous")).toBe("autonomous")
		expect(expertKindSchema.parse("workflow")).toBe("workflow")
	})

	it("rejects other kinds", () => {
		expect(() => expertKindSchema.parse("hybrid")).toThrow()
	})
})

describe("validateExpertConfig", () => {
	// Minimal partial configs are cast through `unknown` to ExpertConfig since the
	// validator only inspects kind/workflow — we deliberately avoid populating
	// every required ModeConfig field here.
	it("ok for autonomous expert without workflow binding", () => {
		expect(validateExpertConfig({ slug: "a", kind: "autonomous" } as unknown as ExpertConfig)).toEqual({
			ok: true,
		})
	})

	it("fails for workflow expert without workflow binding", () => {
		const res = validateExpertConfig({ slug: "a", kind: "workflow" } as unknown as ExpertConfig)
		expect(res.ok).toBe(false)
		expect(res.ok === false && res.error).toContain("workflow")
	})

	it("ok for workflow expert with workflow binding", () => {
		expect(
			validateExpertConfig({
				slug: "a",
				kind: "workflow",
				workflow: { workflowId: "w" },
			} as unknown as ExpertConfig),
		).toEqual({ ok: true })
	})
})
