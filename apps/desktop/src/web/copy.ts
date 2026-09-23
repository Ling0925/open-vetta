export interface WebCopy {
	title: string;
	subtitle: string;
	pairTitle: string;
	pairHint: string;
	pairCode: string;
	pairAction: string;
	pairing: string;
	pairingFailed: string;
	refresh: string;
	logout: string;
	projectsTitle: string;
	projectsHint: string;
	current: string;
	archived: string;
	noProjects: string;
	path: string;
	readOnly: string;
	waiting: string;
	synced: string;
	offline: string;
	reconnecting: string;
	revoked: string;
	error: string;
	invalidCode: string;
}

const zh: WebCopy = {
	title: "Vetta Web",
	subtitle: "只读项目目录",
	pairTitle: "连接这台 Desktop",
	pairHint: "在 Desktop 设置中生成一次性配对码，然后在此输入。配对码不会写入 URL 或浏览器存储。",
	pairCode: "配对码",
	pairAction: "连接",
	pairing: "正在连接…",
	pairingFailed: "配对失败，请检查配对码是否过期或重新生成。",
	refresh: "刷新",
	logout: "退出网页授权",
	projectsTitle: "项目",
	projectsHint: "网页当前只显示项目名称和宿主路径，不读取文件、不修改项目，也不能运行任务。",
	current: "当前项目",
	archived: "已归档",
	noProjects: "暂无项目",
	path: "宿主路径",
	readOnly: "只读",
	waiting: "正在等待 Desktop 的变化…",
	synced: "已同步",
	offline: "连接已断开。",
	reconnecting: "正在自动重连…",
	revoked: "网页授权已撤销，请重新配对。",
	error: "暂时无法读取项目，请稍后重试。",
	invalidCode: "请输入配对码。",
};

const en: WebCopy = {
	title: "Vetta Web",
	subtitle: "Read-only project directory",
	pairTitle: "Connect to this Desktop",
	pairHint:
		"Generate a one-time pairing code in Desktop settings, then enter it here. The code is not stored in the URL or browser storage.",
	pairCode: "Pairing code",
	pairAction: "Connect",
	pairing: "Connecting…",
	pairingFailed: "Pairing failed. Check that the code is valid and try again.",
	refresh: "Refresh",
	logout: "Sign out of web access",
	projectsTitle: "Projects",
	projectsHint:
		"Web access currently shows project names and host paths only. It cannot read files, change projects, or run tasks.",
	current: "Current projects",
	archived: "Archived",
	noProjects: "No projects",
	path: "Host path",
	readOnly: "Read-only",
	waiting: "Waiting for changes from Desktop…",
	synced: "Synced",
	offline: "The connection was lost.",
	reconnecting: "Reconnecting automatically…",
	revoked: "Web access was revoked. Pair this browser again.",
	error: "Projects are temporarily unavailable. Try again.",
	invalidCode: "Enter a pairing code.",
};

export function getWebCopy(): WebCopy {
	return navigator.language.toLowerCase().startsWith("zh") ? zh : en;
}
