/**
 * Minimal structured logger. The /observatory launcher redirects the server's
 * stdout/stderr to ~/.pi/agent/observatory/server.log, so every line stays
 * greppable and timestamped.
 */
type Level = "info" | "warn" | "error";

function write(level: Level, message: string): void {
	const line = `${new Date().toISOString()} [observatory] ${level} ${message}\n`;
	if (level === "error") process.stderr.write(line);
	else process.stdout.write(line);
}

export const log = {
	info: (message: string): void => write("info", message),
	warn: (message: string): void => write("warn", message),
	error: (message: string): void => write("error", message),
};
