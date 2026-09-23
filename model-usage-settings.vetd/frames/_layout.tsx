import { Outlet } from "react-router";
import { SettingsSidebar } from "../components/SettingsSidebar";

export default function Layout() {
	return (
		<div className="flex h-full w-full overflow-hidden bg-surface font-sans text-surface-foreground antialiased">
			<SettingsSidebar />
			<main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-10 py-6">
				<Outlet />
			</main>
		</div>
	);
}
