/** Shared atomic writes and locks compatible with Pi's auth.json lock. */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export async function readText(path: string): Promise<string | undefined> {
	try { return await readFile(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function atomicWrite(path: string, content: string, mode?: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const existingMode = mode ?? await stat(path).then(s => s.mode & 0o777, error => {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return 0o600;
	});
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temp, "wx", existingMode);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally { await handle.close(); }
		await rename(temp, path);
	} finally { await rm(temp, { force: true }); }
}

/**
 * Pi uses an empty <file>.lock directory and its mtime as a heartbeat.
 * Use the same exclusion protocol without importing a host-private dependency.
 * Never steal stale locks: after a crash, ask the user to check other sessions.
 */
export async function withFileLock<T>(path: string, operation: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const lockPath = `${path}.lock`;
	const deadline = Date.now() + 5_000;
	while (true) {
		try { await mkdir(lockPath); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error(`文件正在被其他会话使用：${path}。若锁持续存在，请确认没有写入进程后检查 ${lockPath}`);
			await sleep(50);
		}
	}
	const identity = await stat(lockPath);
	let compromised: unknown;
	let heartbeat: Promise<void> = Promise.resolve();
	const owned = async () => {
		const current = await stat(lockPath);
		return current.ino === identity.ino && current.birthtimeMs === identity.birthtimeMs;
	};
	const assertOwned = async () => {
		if (compromised) throw compromised;
		if (!await owned()) throw new Error(`文件锁已变化：${path}`);
	};
	const timer = setInterval(() => {
		heartbeat = heartbeat.then(async () => {
			if (compromised) return;
			if (!await owned()) throw new Error(`文件锁已变化：${path}`);
			const now = new Date();
			await utimes(lockPath, now, now);
		}).catch(error => { compromised = error; });
	}, 1_000);
	timer.unref();
	try {
		const result = await operation(assertOwned);
		await assertOwned();
		return result;
	} finally {
		clearInterval(timer);
		await heartbeat;
		if (await owned().catch(() => false)) await rmdir(lockPath);
	}
}
