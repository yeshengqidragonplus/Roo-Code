import { useEffect, useMemo, useState } from "react"

import { ModeConfig } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

const createSlug = (name: string, modes: ModeConfig[]) => {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "workgroup"
	let slug = base
	let index = 2
	while (modes.some((mode) => mode.slug === slug)) slug = `${base}-${index++}`
	return slug
}

const WorkgroupsView = () => {
	const { customModes } = useExtensionState()
	const modes = useMemo(() => customModes ?? [], [customModes])
	const coordinators = useMemo(() => modes.filter((mode) => mode.workgroup !== undefined), [modes])
	const [selectedSlug, setSelectedSlug] = useState("")
	const [name, setName] = useState("")
	const [description, setDescription] = useState("")

	const coordinator = coordinators.find((mode) => mode.slug === selectedSlug)
	const colleagues = coordinator?.workgroup?.colleagueSlugs ?? []

	useEffect(() => {
		if (!coordinator && coordinators[0]) setSelectedSlug(coordinators[0].slug)
	}, [coordinator, coordinators])

	useEffect(() => {
		setName(coordinator?.name ?? "")
		setDescription(coordinator?.description ?? "")
	}, [coordinator])

	const save = (update: Partial<ModeConfig> = {}) => {
		if (!coordinator) return
		vscode.postMessage({
			type: "updateCustomMode",
			slug: coordinator.slug,
			modeConfig: { ...coordinator, ...update },
		})
	}

	const create = () => {
		const groupName = "新工作群组"
		const slug = createSlug(groupName, modes)
		const mode: ModeConfig = {
			slug,
			name: groupName,
			description: "协调项目中的专业同事完成任务。",
			roleDefinition:
				"You are a workgroup coordinator. Delegate specialized work to configured colleagues and synthesize their concise reports.",
			whenToUse: "Use this mode to coordinate project specialists.",
			groups: ["read", "edit", "command", "mcp"],
			source: "project",
			kind: "autonomous",
			delegation: { canDelegate: true, concurrency: "serial", maxDepth: 3, maxRetries: 3, reportMode: "summary" },
			workgroup: { colleagueSlugs: [] },
		}
		vscode.postMessage({ type: "updateCustomMode", slug, modeConfig: mode })
		setSelectedSlug(slug)
	}

	const remove = () => {
		if (!coordinator) return
		vscode.postMessage({
			type: "deleteCustomMode",
			slug: coordinator.slug,
			source: coordinator.source ?? "project",
		})
		setSelectedSlug("")
	}

	return (
		<div className="p-5 max-w-3xl">
			<div className="flex items-center justify-between mb-2">
				<h2 className="m-0">工作群组</h2>
				<Button variant="primary" onClick={create}>
					新建工作群组
				</Button>
			</div>
			<p className="text-vscode-descriptionForeground mb-5">工作群组是一个协调者 Mode 与一组可委派同事的配置。</p>
			{coordinators.length === 0 ? (
				<p className="text-vscode-descriptionForeground">还没有工作群组。点击右上角创建第一个群组。</p>
			) : (
				<>
					<div className="mb-5">
						<div className="font-medium mb-2">当前群组</div>
						<Select value={selectedSlug} onValueChange={setSelectedSlug}>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{coordinators.map((mode) => (
									<SelectItem key={mode.slug} value={mode.slug}>
										{mode.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-3 mb-5">
						<div>
							<div className="font-medium mb-1">名称</div>
							<Input
								value={name}
								onChange={(event) => setName(event.target.value)}
								onBlur={() => name.trim() && save({ name: name.trim() })}
							/>
						</div>
						<div>
							<div className="font-medium mb-1">说明</div>
							<Input
								value={description}
								onChange={(event) => setDescription(event.target.value)}
								onBlur={() => save({ description: description.trim() || undefined })}
							/>
						</div>
					</div>
					<div className="font-medium mb-2">可委派同事</div>
					<div className="space-y-2">
						{modes
							.filter((mode) => mode.slug !== coordinator?.slug)
							.map((mode) => {
								const checked = colleagues.includes(mode.slug)
								return (
									<label key={mode.slug} className="flex items-start gap-2 cursor-pointer">
										<input
											type="checkbox"
											checked={checked}
											onChange={() =>
												save({
													workgroup: {
														colleagueSlugs: checked
															? colleagues.filter((slug) => slug !== mode.slug)
															: [...colleagues, mode.slug],
													},
												})
											}
										/>
										<span>
											<span className="font-medium">{mode.name}</span>
											<span className="text-vscode-descriptionForeground">
												{" "}
												— {mode.description ?? mode.slug}
											</span>
										</span>
									</label>
								)
							})}
					</div>
					<div className="flex gap-2 mt-6">
						<Button
							variant="secondary"
							onClick={() =>
								save({
									name: name.trim() || coordinator?.name,
									description: description.trim() || undefined,
								})
							}>
							保存修改
						</Button>
						<Button variant="destructive" onClick={remove}>
							删除工作群组
						</Button>
					</div>
				</>
			)}
			<div className="border-t border-vscode-descriptionForeground/20 pt-5 mt-6">
				<div className="font-medium mb-2">命令与脚本信任白名单</div>
				<p className="text-vscode-descriptionForeground mb-3">
					工作群组或开启沙箱的普通 Mode 中选择“完全信任”的命令，会以 SHA-256 指纹保存到当前项目。
				</p>
				<Button variant="secondary" onClick={() => vscode.postMessage({ type: "openCommandTrustFile" })}>
					打开项目白名单
				</Button>
			</div>
		</div>
	)
}

export default WorkgroupsView
