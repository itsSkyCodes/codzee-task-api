import mysql, { type Pool } from "mysql2/promise";
import type { TaskRecord, TaskRepository, TaskUpdateResult } from "./types.js";

export class MySqlTaskRepository implements TaskRepository {
    private pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    async init(): Promise<void> {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS tasks (
                id INT AUTO_INCREMENT PRIMARY KEY,
                title VARCHAR(200) NOT NULL,
                completed BOOLEAN NOT NULL DEFAULT FALSE,
                owner_id VARCHAR(255) NOT NULL,
                version INT NOT NULL DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_owner_id_id (owner_id, id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
    }

    async create(data: { title: string; ownerId: string }): Promise<TaskRecord> {
        const [result] = await this.pool.execute<mysql.ResultSetHeader>(
            `INSERT INTO tasks (title, owner_id, completed, version) VALUES (?, ?, FALSE, 1)`,
            [data.title, data.ownerId],
        );
        return {
            id: result.insertId,
            title: data.title,
            completed: false,
            ownerId: data.ownerId,
            version: 1,
        };
    }

    async findById(id: number, ownerId: string): Promise<TaskRecord | null> {
        const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
            `SELECT id, title, completed, owner_id AS ownerId, version
             FROM tasks
             WHERE id = ? AND owner_id = ?`,
            [id, ownerId],
        );
        const row = rows[0];
        if (!row) {
            return null;
        }
        return {
            id: Number(row.id),
            title: String(row.title),
            completed: Boolean(row.completed),
            ownerId: String(row.ownerId),
            version: Number(row.version),
        };
    }

    async findMany(options: {
        ownerId: string;
        page: number;
        limit: number;
    }): Promise<{ tasks: TaskRecord[]; total: number }> {
        const offset = (options.page - 1) * options.limit;

        // Use index idx_owner_id_id for both count and range scan
        const [countRows] = await this.pool.execute<mysql.RowDataPacket[]>(
            `SELECT COUNT(*) AS total FROM tasks WHERE owner_id = ?`,
            [options.ownerId],
        );
        const total = Number(countRows[0]?.total ?? 0);

        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
            `SELECT id, title, completed, owner_id AS ownerId, version
             FROM tasks
             WHERE owner_id = ?
             ORDER BY id ASC
             LIMIT ? OFFSET ?`,
            [options.ownerId, options.limit, offset],
        );

        const tasks: TaskRecord[] = rows.map((row) => ({
            id: Number(row.id),
            title: String(row.title),
            completed: Boolean(row.completed),
            ownerId: String(row.ownerId),
            version: Number(row.version),
        }));

        return { tasks, total };
    }

    async update(
        id: number,
        ownerId: string,
        updates: { title?: string | undefined; completed?: boolean | undefined; version: number },
    ): Promise<TaskUpdateResult> {
        const setClauses: string[] = ["version = version + 1"];
        const params: any[] = [];

        if (updates.title !== undefined) {
            setClauses.push("title = ?");
            params.push(updates.title);
        }
        if (updates.completed !== undefined) {
            setClauses.push("completed = ?");
            params.push(updates.completed);
        }

        params.push(id, ownerId, updates.version);

        const [result] = await this.pool.execute<mysql.ResultSetHeader>(
            `UPDATE tasks
             SET ${setClauses.join(", ")}
             WHERE id = ? AND owner_id = ? AND version = ?`,
            params,
        );

        if (result.affectedRows === 0) {
            // Check whether the task exists to distinguish 404 from 409
            const [checkRows] = await this.pool.execute<mysql.RowDataPacket[]>(
                `SELECT version FROM tasks WHERE id = ? AND owner_id = ?`,
                [id, ownerId],
            );
            if (checkRows.length === 0) {
                return { status: "NOT_FOUND" };
            }
            return {
                status: "CONFLICT",
                currentVersion: Number(checkRows[0]?.version),
            };
        }

        const updated = await this.findById(id, ownerId);
        if (!updated) {
            return { status: "NOT_FOUND" };
        }
        return { status: "SUCCESS", task: updated };
    }

    async reset(): Promise<void> {
        await this.pool.query(`TRUNCATE TABLE tasks`);
    }
}
