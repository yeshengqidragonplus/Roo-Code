import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock vscode module — openImage/saveImage use window.showErrorMessage etc.
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
	},
	workspace: {
		fs: {
			writeFile: vi.fn(),
			delete: vi.fn(),
		},
	},
	env: {
		clipboard: {
			writeText: vi.fn(),
		},
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
	},
}))

import { openImage, registerWebviewImageUri, resolveWebviewImageUri } from "../image-handler"
import * as vscode from "vscode"

describe("image-handler webview URI mapping", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("resolveWebviewImageUri returns undefined for unregistered URIs", () => {
		expect(resolveWebviewImageUri("https://unknown.vscode-cdn.net/foo.png")).toBeUndefined()
	})

	it("resolveWebviewImageUri returns the registered file path", () => {
		registerWebviewImageUri("https://foo.vscode-cdn.net/img/abc.png", "D:\\storage\\tasks\\t1\\images\\abc.png")
		expect(resolveWebviewImageUri("https://foo.vscode-cdn.net/img/abc.png")).toBe(
			"D:\\storage\\tasks\\t1\\images\\abc.png",
		)
	})

	it("openImage resolves a registered webview URI to its file and opens it directly", async () => {
		const realPath = "D:\\storage\\tasks\\t1\\images\\abc.png"
		registerWebviewImageUri("https://foo.vscode-cdn.net/img/abc.png", realPath)

		await openImage("https://foo.vscode-cdn.net/img/abc.png")

		// Should open the real file, NOT show the invalid-data-URI error.
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("vscode.open", expect.anything())
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("openImage still rejects unregistered https URIs with the invalid data URI error", async () => {
		await openImage("https://random.example.com/image.png")
		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})

	it("openImage still handles plain data URIs (legacy path unchanged)", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png").toString("base64")}`
		await openImage(dataUrl)
		// Writes a temp file then opens it — no error expected.
		expect(vscode.workspace.fs.writeFile).toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})
})
