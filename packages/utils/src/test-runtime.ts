const BUN_TEST_ENTRY_PATTERN = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/** True when the process is an explicitly marked test child or Bun is running a test entrypoint. */
export function isBunTestRuntime(): boolean {
	return Bun.env.PI_TEST_RUNTIME === "1" || isBunTestEntrypoint();
}

/** True when Bun is running a test entrypoint, ignoring the `PI_TEST_RUNTIME` marker. */
export function isBunTestEntrypoint(): boolean {
	const hasTestEnvironment = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	return hasTestEnvironment && BUN_TEST_ENTRY_PATTERN.test(Bun.main);
}
