import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import request from "supertest";
import jwt from "jsonwebtoken";
import { app } from "../src/app.js";
import { MySqlTaskRepository } from "../src/db/mysql.js";
import { getTaskRepository, setTaskRepository } from "../src/db/index.js";

try {
    process.loadEnvFile?.();
} catch {
    // Ignore if .env is missing
}

const testJwtSecret =
    process.env.JWT_SECRET ||
    "test-secret-for-jwt-tests-at-least-32-bytes";
process.env.JWT_SECRET = testJwtSecret;

let isRealMySqlAvailable = false;
let realPool: mysql.Pool | null = null;

if (process.env.MYSQL_HOST) {
    try {
        const candidatePool = mysql.createPool({
            host: process.env.MYSQL_HOST,
            port: Number(process.env.MYSQL_PORT) || 3306,
            user: process.env.MYSQL_USER || "root",
            password: process.env.MYSQL_PASSWORD || "",
            database: process.env.MYSQL_DATABASE || "tasks_db",
            connectTimeout: 2000,
            waitForConnections: true,
            connectionLimit: 5,
        });
        const conn = await candidatePool.getConnection();
        conn.release();
        realPool = candidatePool;
        isRealMySqlAvailable = true;
    } catch {
        isRealMySqlAvailable = false;
        realPool = null;
    }
}

describe("MySqlTaskRepository query and index handling", () => {
    it("defines the composite index on (owner_id, id) in schema initialization", async () => {
        const executedQueries: string[] = [];
        const mockPool = {
            query: vi.fn(async (sql: string) => {
                executedQueries.push(sql);
                return [[]];
            }),
            execute: vi.fn(),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        await repo.init();

        expect(executedQueries.length).toBe(1);
        expect(executedQueries[0]).toContain("id BIGINT AUTO_INCREMENT PRIMARY KEY");
        expect(executedQueries[0]).toContain("version BIGINT NOT NULL DEFAULT 1");
        expect(executedQueries[0]).toContain("INDEX idx_owner_id_id (owner_id, id)");
        expect(executedQueries[0]).toContain("ENGINE=InnoDB");
    });

    it("uses indexed parameterized query with LIMIT and OFFSET for pagination inside a transaction", async () => {
        let executeSql = "";
        let executeParams: any[] = [];
        let querySql = "";
        let queryParams: any[] = [];
        const beginTransaction = vi.fn();
        const commit = vi.fn();
        const release = vi.fn();

        const mockConnection = {
            beginTransaction,
            commit,
            rollback: vi.fn(),
            release,
            execute: vi.fn(async (sql: string, params: any[]) => {
                executeSql = sql;
                executeParams = params;
                return [[{ total: 42 }]];
            }),
            query: vi.fn(async (sql: string, params: any[]) => {
                querySql = sql;
                queryParams = params;
                return [
                    [
                        { id: 1, title: "Task 1", completed: 0, ownerId: "alice", version: 1 },
                        { id: 2, title: "Task 2", completed: 1, ownerId: "alice", version: 2 },
                    ],
                ];
            }),
        };

        const mockPool = {
            getConnection: vi.fn(async () => mockConnection),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        const result = await repo.findMany({
            ownerId: "alice",
            page: 2,
            limit: 10,
        });

        expect(beginTransaction).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();

        // Verifies count query uses parameterized owner_id
        expect(executeSql).toContain("SELECT COUNT(*) AS total FROM tasks WHERE owner_id = ?");
        expect(executeParams).toEqual(["alice"]);

        // Verifies paginated query uses parameterized owner_id, ORDER BY id ASC, LIMIT and OFFSET
        expect(querySql).toContain("ORDER BY id ASC");
        expect(querySql).toContain("LIMIT ? OFFSET ?");
        expect(queryParams).toEqual(["alice", 10, 10]); // page 2 with limit 10 -> offset 10

        expect(result.total).toBe(42);
        expect(result.tasks).toHaveLength(2);
        expect(result.tasks[0]?.title).toBe("Task 1");
        expect(result.tasks[0]?.completed).toBe(false);
    });

    it("queries all records without LIMIT/OFFSET when pagination is omitted within a transaction", async () => {
        let querySql = "";
        let queryParams: any[] = [];
        const beginTransaction = vi.fn();
        const commit = vi.fn();
        const release = vi.fn();

        const mockConnection = {
            beginTransaction,
            commit,
            rollback: vi.fn(),
            release,
            execute: vi.fn(async () => [[{ total: 5 }]]),
            query: vi.fn(async (sql: string, params: any[]) => {
                querySql = sql;
                queryParams = params;
                return [[{ id: 1, title: "T1", completed: 0, ownerId: "bob", version: 1 }]];
            }),
        };

        const mockPool = {
            getConnection: vi.fn(async () => mockConnection),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        const result = await repo.findMany({ ownerId: "bob" });

        expect(beginTransaction).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();

        expect(querySql).toContain("ORDER BY id ASC");
        expect(querySql).not.toContain("LIMIT");
        expect(queryParams).toEqual(["bob"]);
        expect(result.tasks).toHaveLength(1);
    });

    it("short-circuits and skips SELECT query when offset exceeds total count", async () => {
        const query = vi.fn();
        const mockConnection = {
            beginTransaction: vi.fn(),
            commit: vi.fn(),
            rollback: vi.fn(),
            release: vi.fn(),
            execute: vi.fn(async () => [[{ total: 5 }]]),
            query,
        };

        const mockPool = {
            getConnection: vi.fn(async () => mockConnection),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        // page 10 with limit 10 -> offset 90 >= total 5
        const result = await repo.findMany({
            ownerId: "bob",
            page: 10,
            limit: 10,
        });

        expect(query).not.toHaveBeenCalled();
        expect(result.total).toBe(5);
        expect(result.tasks).toHaveLength(0);
    });

    it("executes atomic conditional update within a transaction using FOR UPDATE", async () => {
        let selectSql = "";
        let updateSql = "";
        let updateParams: any[] = [];
        const beginTransaction = vi.fn();
        const commit = vi.fn();
        const rollback = vi.fn();
        const release = vi.fn();

        const mockConnection = {
            beginTransaction,
            commit,
            rollback,
            release,
            execute: vi.fn(async (sql: string, params: any[]) => {
                if (sql.includes("FOR UPDATE")) {
                    selectSql = sql;
                    return [[{ id: 5, title: "Old Title", completed: 0, ownerId: "bob", version: 2 }]];
                }
                if (sql.startsWith("UPDATE")) {
                    updateSql = sql;
                    updateParams = params;
                    return [{ affectedRows: 1 }];
                }
                return [[]];
            }),
        };

        const mockPool = {
            getConnection: vi.fn(async () => mockConnection),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        const result = await repo.update(5, "bob", {
            title: "New Title",
            completed: true,
            version: 2,
        });

        expect(beginTransaction).toHaveBeenCalledOnce();
        expect(selectSql).toContain("FOR UPDATE");
        expect(updateSql).toContain("UPDATE tasks");
        expect(updateParams).toEqual(["New Title", true, 3, 5, "bob"]);
        expect(commit).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();

        expect(result.status).toBe("SUCCESS");
        if (result.status === "SUCCESS") {
            expect(result.task.version).toBe(3);
            expect(result.task.title).toBe("New Title");
            expect(result.task.completed).toBe(true);
        }
    });

    it("detects conflict and rolls back when version does not match", async () => {
        const rollback = vi.fn();
        const commit = vi.fn();
        const release = vi.fn();

        const mockConnection = {
            beginTransaction: vi.fn(),
            commit,
            rollback,
            release,
            execute: vi.fn(async (sql: string) => {
                if (sql.includes("FOR UPDATE")) {
                    return [[{ id: 10, title: "Title", completed: 0, ownerId: "alice", version: 5 }]];
                }
                return [[]];
            }),
        };

        const mockPool = {
            getConnection: vi.fn(async () => mockConnection),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        const result = await repo.update(10, "alice", {
            title: "Stale update",
            version: 3,
        });

        expect(rollback).toHaveBeenCalledOnce();
        expect(commit).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        expect(result.status).toBe("CONFLICT");
        if (result.status === "CONFLICT") {
            expect(result.currentVersion).toBe(5);
        }
    });

    it("returns NOT_FOUND and rolls back when task does not exist", async () => {
        const rollback = vi.fn();
        const commit = vi.fn();
        const release = vi.fn();

        const mockConnection = {
            beginTransaction: vi.fn(),
            commit,
            rollback,
            release,
            execute: vi.fn(async () => [[]]),
        };

        const mockPool = {
            getConnection: vi.fn(async () => mockConnection),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        const result = await repo.update(999, "alice", {
            title: "Missing task",
            version: 1,
        });

        expect(rollback).toHaveBeenCalledOnce();
        expect(commit).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        expect(result.status).toBe("NOT_FOUND");
    });

    it("updates successfully even when MySQL driver returns affectedRows = 0 (changed rows vs matched rows)", async () => {
        let updateExecuted = false;
        const mockConnection = {
            beginTransaction: vi.fn(),
            commit: vi.fn(),
            rollback: vi.fn(),
            release: vi.fn(),
            execute: vi.fn(async (sql: string) => {
                if (sql.includes("FOR UPDATE")) {
                    return [
                        [
                            {
                                id: 42,
                                title: "Same Title",
                                completed: 0,
                                ownerId: "carol",
                                version: 1,
                            },
                        ],
                    ];
                }
                if (sql.startsWith("UPDATE")) {
                    updateExecuted = true;
                    // MySQL default behavior when updated fields match existing values: affectedRows (changed) = 0
                    return [{ affectedRows: 0 }];
                }
                return [[]];
            }),
        };

        const mockPool = {
            getConnection: vi.fn(async () => mockConnection),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        const result = await repo.update(42, "carol", {
            title: "Same Title",
            version: 1,
        });

        expect(updateExecuted).toBe(true);
        expect(result.status).toBe("SUCCESS");
        if (result.status === "SUCCESS") {
            expect(result.task.id).toBe(42);
            expect(result.task.version).toBe(2);
            expect(result.task.title).toBe("Same Title");
        }
    });

    it("throws an error when MYSQL_HOST is not configured and no repository instance is set", () => {
        const hadHost = Object.prototype.hasOwnProperty.call(process.env, "MYSQL_HOST");
        const originalHost = process.env.MYSQL_HOST;
        let previousRepo: any = null;
        try {
            previousRepo = getTaskRepository();
        } catch {
            // In case it wasn't initialized yet
        }

        try {
            delete process.env.MYSQL_HOST;
            setTaskRepository(null);

            expect(() => getTaskRepository()).toThrow(
                "MYSQL_HOST environment variable must be set in .env",
            );
        } finally {
            if (hadHost) {
                process.env.MYSQL_HOST = originalHost;
            } else {
                delete process.env.MYSQL_HOST;
            }
            setTaskRepository(previousRepo);
        }
    });
});

describe.runIf(isRealMySqlAvailable)(
    "MySqlTaskRepository real database integration",
    () => {
        let repo: MySqlTaskRepository;
        let createdTaskId: number;
        const testOwner = `integ-user-${Date.now()}`;
        const token = jwt.sign({ sub: testOwner }, testJwtSecret, {
            algorithm: "HS256",
            expiresIn: "1h",
        });

        beforeAll(async () => {
            repo = new MySqlTaskRepository(realPool!);
            await repo.init();
        });

        afterAll(async () => {
            if (realPool) {
                try {
                    await realPool.query("DELETE FROM tasks WHERE owner_id = ?", [
                        testOwner,
                    ]);
                } catch {
                    // Ignore cleanup errors
                }
                await realPool.end();
            }
        });

        it("creates a task and verifies initial version is 1", async () => {
            const created = await repo.create({
                title: "Integration Task",
                ownerId: testOwner,
            });

            expect(created.id).toBeGreaterThan(0);
            expect(created.version).toBe(1);
            expect(created.title).toBe("Integration Task");
            createdTaskId = created.id;
        });

        it("updates task with identical values and increments version (exercises MySQL changed rows vs matched rows)", async () => {
            const result = await repo.update(createdTaskId, testOwner, {
                title: "Integration Task",
                version: 1,
            });

            expect(result.status).toBe("SUCCESS");
            if (result.status === "SUCCESS") {
                expect(result.task.version).toBe(2);
                expect(result.task.title).toBe("Integration Task");
            }
        });

        it("rejects stale version update with CONFLICT", async () => {
            const result = await repo.update(createdTaskId, testOwner, {
                title: "Stale update attempt",
                version: 1, // Current is 2
            });

            expect(result.status).toBe("CONFLICT");
            if (result.status === "CONFLICT") {
                expect(result.currentVersion).toBe(2);
            }
        });

        it("handles concurrent writes against real MySQL using transaction locking (one succeeds, one conflicts)", async () => {
            // Both writers attempt to update from version: 2 concurrently
            const [res1, res2] = await Promise.all([
                repo.update(createdTaskId, testOwner, {
                    title: "Concurrent Writer 1",
                    version: 2,
                }),
                repo.update(createdTaskId, testOwner, {
                    title: "Concurrent Writer 2",
                    version: 2,
                }),
            ]);

            const statuses = [res1.status, res2.status];
            expect(statuses).toContain("SUCCESS");
            expect(statuses).toContain("CONFLICT");

            const conflictRes = res1.status === "CONFLICT" ? res1 : res2;
            if (conflictRes.status === "CONFLICT") {
                expect(conflictRes.currentVersion).toBe(3);
            }

            const successRes = res1.status === "SUCCESS" ? res1 : res2;
            if (successRes.status === "SUCCESS") {
                expect(successRes.task.version).toBe(3);
            }
        });

        it("exercises HTTP PATCH route with real MySQL repository and ETag/If-Match concurrency", async () => {
            let previousRepo: any = null;
            try {
                previousRepo = getTaskRepository();
            } catch {
                // No previous repo
            }

            try {
                setTaskRepository(repo);

                // Fetch current state via GET
                const getRes = await request(app)
                    .get(`/tasks/${createdTaskId}`)
                    .set("Authorization", `Bearer ${token}`);
                expect(getRes.status).toBe(200);
                expect(getRes.headers.etag).toBe('"3"');

                // Successful patch with matching If-Match header
                const patchRes1 = await request(app)
                    .patch(`/tasks/${createdTaskId}`)
                    .set("Authorization", `Bearer ${token}`)
                    .set("If-Match", '"3"')
                    .send({ title: "HTTP patched title" });

                expect(patchRes1.status).toBe(200);
                expect(patchRes1.headers.etag).toBe('"4"');
                expect(patchRes1.body.title).toBe("HTTP patched title");

                // Stale patch with previous If-Match header
                const patchRes2 = await request(app)
                    .patch(`/tasks/${createdTaskId}`)
                    .set("Authorization", `Bearer ${token}`)
                    .set("If-Match", '"3"')
                    .send({ title: "Stale HTTP patch" });

                expect(patchRes2.status).toBe(409);
                expect(patchRes2.body.currentVersion).toBe(4);
            } finally {
                setTaskRepository(previousRepo);
            }
        });
    },
);
