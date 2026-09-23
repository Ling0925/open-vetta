import { describe, expect, it } from "vitest";
import { isPrivateLanIPv4 } from "./lan-addresses.js";

describe("isPrivateLanIPv4", () => {
	it.each(["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.21"])(
		"accepts a private LAN address %s",
		(address) => {
			expect(isPrivateLanIPv4(address)).toBe(true);
		},
	);

	it.each([
		"127.0.0.1",
		"169.254.1.2",
		"172.32.0.1",
		"8.8.8.8",
		"0.0.0.0",
		"192.168.001.21",
		"192.168.1.256",
		"web.test",
	])("rejects a non-LAN or ambiguous address %s", (address) => {
		expect(isPrivateLanIPv4(address)).toBe(false);
	});
});
