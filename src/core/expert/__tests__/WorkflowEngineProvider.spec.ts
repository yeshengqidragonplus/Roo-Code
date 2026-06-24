import { adaptEngine, createDynamicImportProvider } from "../WorkflowEngineProvider"
import { WorkflowExpertRunner, type WorkflowExpertRunnerDeps } from "../WorkflowExpertRunner"

describe("adaptEngine", () => {
	it("normalizes a sync raw engine and coerces non-string finalResult", async () => {
		const raw = {
			start: () => ({ state: { i: 0 }, nextPrompt: "go", done: false }),
			advance: () => ({ state: { i: 1 }, done: true, finalResult: { ok: true } }),
		}
		const engine = adaptEngine(raw)

		const s0 = await engine.start({ x: 1 })
		expect(s0).toEqual({ state: { i: 0 }, nextPrompt: "go", action: undefined, done: false, finalResult: undefined })

		const s1 = await engine.advance(s0.state, "out")
		expect(s1.done).toBe(true)
		expect(s1.finalResult).toBe('{"ok":true}') // object → JSON string
	})

	it("passes through a string finalResult unchanged and preserves actions", async () => {
		const raw = {
			start: async () => ({
				state: 0,
				action: { type: "tool" as const, name: "read", params: { p: 1 } },
				done: false,
			}),
			advance: async () => ({ state: 1, done: true, finalResult: "plain" }),
		}
		const engine = adaptEngine(raw)

		const s0 = await engine.start({})
		expect(s0.action).toEqual({ type: "tool", name: "read", params: { p: 1 } })

		const s1 = await engine.advance(s0.state, "x")
		expect(s1.finalResult).toBe("plain")
	})

	it("drives a full run through WorkflowExpertRunner end-to-end", async () => {
		// A scripted raw engine standing in for the real createEngine() result.
		const steps = [
			{ state: 0, action: { type: "tool" as const, name: "read", params: {} }, done: false },
			{ state: 1, nextPrompt: "reason about it", done: false },
			{ state: 2, done: true, finalResult: "finished" },
		]
		let i = 0
		const raw = { start: () => steps[i++], advance: () => steps[i++] }

		const llmPrompts: string[] = []
		const deps: WorkflowExpertRunnerDeps = {
			runLlmTurn: async (p) => {
				llmPrompts.push(p)
				return "llm-out"
			},
			executeAction: async (a) => `did:${a.type}`,
			persistState: async () => {},
		}

		const result = await new WorkflowExpertRunner(adaptEngine(raw), deps).run()

		expect(result).toBe("finished")
		expect(llmPrompts).toEqual(["reason about it"])
	})
})

describe("createDynamicImportProvider", () => {
	it("imports the module, finds createEngine, and adapts it", async () => {
		const fakeModule = {
			createEngine: (_workflow: unknown) => ({
				start: () => ({ state: "s0", nextPrompt: "p", done: false }),
				advance: () => ({ state: "s1", done: true, finalResult: "ok" }),
			}),
		}
		const importer = vi.fn(async (_path: string) => fakeModule)

		const provider = createDynamicImportProvider("/path/to/engine.js", importer)
		const engine = await provider({ name: "wf", nodes: [], edges: [] })

		expect(importer).toHaveBeenCalledWith("/path/to/engine.js")
		const s0 = await engine.start({})
		expect(s0.nextPrompt).toBe("p")
	})

	it("supports a module that exposes createEngine on default export", async () => {
		const importer = async () => ({
			default: { createEngine: () => ({ start: () => ({ state: 0, done: true }), advance: () => ({ state: 0, done: true }) }) },
		})
		const provider = createDynamicImportProvider("x", importer)
		const engine = await provider({})
		expect((await engine.start({})).done).toBe(true)
	})

	it("throws a clear error when the module has no createEngine", async () => {
		const provider = createDynamicImportProvider("x", async () => ({ nope: true }))
		await expect(provider({})).rejects.toThrow(/createEngine/)
	})
})
