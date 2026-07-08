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

describe("apiProfile field", () => {
	it("is exposed as an optional field in expertModeFields", () => {
		expect(expertModeFields).toHaveProperty("apiProfile")
	})

	it("a mode config with apiProfile validates", () => {
		const config = {
			slug: "image-analyzer",
			name: "Image Analyzer",
			roleDefinition: "You are an image analysis expert.",
			groups: ["read", "mcp"],
			apiProfile: "claude-vision",
		}
		const parsed = modeConfigSchema.parse(config)
		expect(parsed.apiProfile).toBe("claude-vision")
	})

	it("a mode config without apiProfile still validates (undefined)", () => {
		const config = {
			slug: "plain",
			name: "Plain",
			roleDefinition: "You are helpful.",
			groups: ["read"],
		}
		const parsed = modeConfigSchema.parse(config)
		expect(parsed.apiProfile).toBeUndefined()
	})
})

describe("hidden field", () => {
	it("is exposed as an optional field in expertModeFields", () => {
		expect(expertModeFields).toHaveProperty("hidden")
	})

	it("a mode config with hidden=true validates", () => {
		const config = {
			slug: "image-analyzer",
			name: "Image Analyzer",
			roleDefinition: "You are an image analysis expert.",
			groups: ["read", "mcp"],
			hidden: true,
		}
		const parsed = modeConfigSchema.parse(config)
		expect(parsed.hidden).toBe(true)
	})

	it("a mode config without hidden still validates (undefined)", () => {
		const config = {
			slug: "plain",
			name: "Plain",
			roleDefinition: "You are helpful.",
			groups: ["read"],
		}
		const parsed = modeConfigSchema.parse(config)
		expect(parsed.hidden).toBeUndefined()
	})

	it("a mode config with hidden=false validates", () => {
		const config = {
			slug: "squad-lead",
			name: "Squad Lead",
			roleDefinition: "You are a squad lead.",
			groups: ["read", "mcp"],
			hidden: false,
		}
		const parsed = modeConfigSchema.parse(config)
		expect(parsed.hidden).toBe(false)
	})
})

describe("maxRetries in delegationPolicy", () => {
	it("defaults to 3 when not specified", () => {
		const parsed = modeConfigSchema.parse({
			slug: "squad-lead",
			name: "Squad Lead",
			roleDefinition: "You are a squad lead.",
			groups: ["read", "mcp"],
			delegation: { canDelegate: true },
		})
		expect(parsed.delegation?.maxRetries).toBe(3)
	})

	it("accepts a custom value", () => {
		const parsed = modeConfigSchema.parse({
			slug: "squad-lead",
			name: "Squad Lead",
			roleDefinition: "You are a squad lead.",
			groups: ["read", "mcp"],
			delegation: { canDelegate: true, maxRetries: 5 },
		})
		expect(parsed.delegation?.maxRetries).toBe(5)
	})

	it("rejects zero or negative", () => {
		expect(() =>
			modeConfigSchema.parse({
				slug: "bad",
				name: "Bad",
				roleDefinition: "x",
				groups: ["read"],
				delegation: { maxRetries: 0 },
			}),
		).toThrow()
		expect(() =>
			modeConfigSchema.parse({
				slug: "bad",
				name: "Bad",
				roleDefinition: "x",
				groups: ["read"],
				delegation: { maxRetries: -1 },
			}),
		).toThrow()
	})

	it("rejects non-integer", () => {
		expect(() =>
			modeConfigSchema.parse({
				slug: "bad",
				name: "Bad",
				roleDefinition: "x",
				groups: ["read"],
				delegation: { maxRetries: 2.5 },
			}),
		).toThrow()
	})
})

describe("squad-lead mode config (full example)", () => {
	it("validates a complete squad-lead configuration", () => {
		const config = {
			slug: "squad-lead",
			name: "🧭 Squad Lead",
			roleDefinition: "You are a task squad organizer.",
			groups: ["read", "mcp"],
			apiProfile: "glm-text",
			delegation: {
				canDelegate: true,
				maxDepth: 3,
				maxRetries: 5,
			},
		}
		const parsed = modeConfigSchema.parse(config)
		expect(parsed.apiProfile).toBe("glm-text")
		expect(parsed.delegation?.maxRetries).toBe(5)
		expect(parsed.hidden).toBeUndefined()
	})
})

describe("squad-member mode config (full example)", () => {
	it("validates a complete squad-member configuration", () => {
		const config = {
			slug: "image-analyzer",
			name: "🌐 Image Analyzer",
			roleDefinition: "You are an image analysis expert.",
			groups: ["read", "mcp"],
			apiProfile: "claude-vision",
			hidden: true,
		}
		const parsed = modeConfigSchema.parse(config)
		expect(parsed.apiProfile).toBe("claude-vision")
		expect(parsed.hidden).toBe(true)
		expect(parsed.delegation).toBeUndefined()
	})
})
