import { describe, expect, it, vi } from "vitest";
import { MySqlTaskRepository } from "../src/db/mysql.js";
import { getTaskRepository, setTaskRepository } from "../src/db/index.js";

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
        expect(executedQueries[0]).toContain("INDEX idx_owner_id_id (owner_id, id)");
        expect(executedQueries[0]).toContain("ENGINE=InnoDB");
    });

    it("uses indexed parameterized query with LIMIT and OFFSET for pagination", async () => {
        let executeSql = "";
        let executeParams: any[] = [];
        let querySql = "";
        let queryParams: any[] = [];

        const mockPool = {
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

        const repo = new MySqlTaskRepository(mockPool as any);
        const result = await repo.findMany({
            ownerId: "alice",
            page: 2,
            limit: 10,
        });

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

    it("executes atomic conditional update with optimistic concurrency version check", async () => {
        let updateSql = "";
        let updateParams: any[] = [];

        const mockPool = {
            execute: vi.fn(async (sql: string, params: any[]) => {
                if (sql.startsWith("UPDATE")) {
                    updateSql = sql;
                    updateParams = params;
                    return [{ affectedRows: 1 }];
                }
                if (sql.startsWith("SELECT")) {
                    return [[{ id: 5, title: "New Title", completed: 1, ownerId: "bob", version: 3 }]];
                }
                return [[]];
            }),
            query: vi.fn(),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        const result = await repo.update(5, "bob", {
            title: "New Title",
            completed: true,
            version: 2,
        });

        expect(updateSql).toContain("version = version + 1");
        expect(updateSql).toContain("WHERE id = ? AND owner_id = ? AND version = ?");
        expect(updateParams).toEqual(["New Title", true, 5, "bob", 2]);

        expect(result.status).toBe("SUCCESS");
        if (result.status === "SUCCESS") {
            expect(result.task.version).toBe(3);
        }
    });

    it("detects conflict when affectedRows is 0 and task exists with another version", async () => {
        const mockPool = {
            execute: vi.fn(async (sql: string) => {
                if (sql.startsWith("UPDATE")) {
                    return [{ affectedRows: 0 }];
                }
                if (sql.startsWith("SELECT version")) {
                    return [[{ version: 5 }]];
                }
                return [[]];
            }),
            query: vi.fn(),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        const result = await repo.update(10, "alice", {
            title: "Stale update",
            version: 3,
        });

        expect(result.status).toBe("CONFLICT");
        if (result.status === "CONFLICT") {
            expect(result.currentVersion).toBe(5);
        }
    });

    it("returns NOT_FOUND when affectedRows is 0 and task does not exist", async () => {
        const mockPool = {
            execute: vi.fn(async (sql: string) => {
                if (sql.startsWith("UPDATE")) {
                    return [{ affectedRows: 0 }];
                }
                if (sql.startsWith("SELECT version")) {
                    return [[]];
                }
                return [[]];
            }),
            query: vi.fn(),
        };

        const repo = new MySqlTaskRepository(mockPool as any);
        const result = await repo.update(999, "alice", {
            title: "Missing task",
            version: 1,
        });

        expect(result.status).toBe("NOT_FOUND");
    });

    it("throws an error when MYSQL_HOST is not configured and no repository instance is set", () => {
        const originalHost = process.env.MYSQL_HOST;
        delete process.env.MYSQL_HOST;
        setTaskRepository(null as any);

        try {
            expect(() => getTaskRepository()).toThrow(
                "MYSQL_HOST environment variable must be set in .env",
            );
        } finally {
            if (originalHost !== undefined) {
                process.env.MYSQL_HOST = originalHost;
            }
        }
    });
});
