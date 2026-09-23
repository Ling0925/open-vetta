import { networkInterfaces } from "node:os";

export function isPrivateLanIPv4(address: string): boolean {
	if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) return false;
	const parts = address.split(".").map(Number);
	if (parts.some((part) => part > 255) || address !== parts.join(".")) return false;
	const [first, second] = parts;
	return (
		first === 10 ||
		(first === 172 && second !== undefined && second >= 16 && second <= 31) ||
		(first === 192 && second === 168)
	);
}

export function getLanIPv4Addresses(): readonly string[] {
	const addresses = new Set<string>();
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal && isPrivateLanIPv4(entry.address))
				addresses.add(entry.address);
		}
	}
	return [...addresses];
}
