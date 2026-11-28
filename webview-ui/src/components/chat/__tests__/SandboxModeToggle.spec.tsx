import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { SandboxModeToggle } from "../SandboxModeToggle"

const state = vi.hoisted(() => ({
	autoApprovalMode: "manual",
	autoApprovalTier: undefined as string | undefined,
	autoApprovalTierEnabled: true,
	autoApprovalEnabled: false,
}))
const postMessage = vi.hoisted(() => vi.fn())

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage } }))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/components/ui/hooks/useRooPortal", () => ({ useRooPortal: () => undefined }))
vi.mock("@/components/ui", async () => {
	const React = await import("react")
	const OpenContext = React.createContext(false)
	return {
		Popover: ({ children, open }: { children: React.ReactNode; open: boolean }) => (
			<OpenContext.Provider value={open}>{children}</OpenContext.Provider>
		),
		PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
		PopoverContent: ({ children }: { children: React.ReactNode }) =>
			React.useContext(OpenContext) ? <div>{children}</div> : null,
		StandardTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	}
})

describe("SandboxModeToggle", () => {
	beforeEach(() => {
		postMessage.mockClear()
		state.autoApprovalTier = undefined
		state.autoApprovalMode = "manual"
		state.autoApprovalTierEnabled = true
		state.autoApprovalEnabled = false
	})

	it("toggles sandbox without changing the selected tier", () => {
		render(<SandboxModeToggle forced />)
		fireEvent.click(screen.getByRole("button", { name: "chat:sandboxMode.tierTooltip" }))
		expect(postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { autoApprovalTier: "sandbox", autoApprovalTierEnabled: false },
		})
	})

	it("requires an explicit risk confirmation before selecting full trust", () => {
		render(<SandboxModeToggle forced />)
		expect(screen.queryByText("chat:sandboxMode.tier.full", { exact: false })).not.toBeInTheDocument()
		fireEvent.contextMenu(screen.getByRole("button", { name: "chat:sandboxMode.tierTooltip" }))
		fireEvent.click(screen.getByText("chat:sandboxMode.tier.full", { exact: false }))
		expect(postMessage).not.toHaveBeenCalled()
		fireEvent.click(screen.getByText("chat:sandboxMode.confirmFull"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { autoApprovalTier: "full", autoApprovalTierEnabled: true },
		})
	})

	it("updates the workgroup minimum safety score", () => {
		state.autoApprovalTier = "full"
		render(<SandboxModeToggle forced />)
		fireEvent.contextMenu(screen.getByRole("button", { name: "chat:sandboxMode.tierTooltip" }))
		fireEvent.change(screen.getByLabelText("chat:sandboxMode.minimumScore"), { target: { value: "1" } })
		expect(postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { autoApprovalMinSafetyScore: 1 },
		})
	})
})
