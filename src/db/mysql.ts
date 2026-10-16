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
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                title VARCHAR(200) NOT NULL,
                completed BOOLEAN NOT NULL DEFAULT FALSE,
                owner_id VARCHAR(255) NOT NULL,
                version BIGINT NOT NULL DEFAULT 1,
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
        page?: number;
        limit?: number;
    }): Promise<{ tasks: TaskRecord[]; total: number }> {
        const connection = await this.pool.getConnection();

        try {
            await connection.beginTransaction();

            // Use index idx_owner_id_id for count within consistent snapshot
            const [countRows] = await connection.execute<mysql.RowDataPacket[]>(
                `SELECT COUNT(*) AS total FROM tasks WHERE owner_id = ?`,
                [options.ownerId],
            );
            const total = Number(countRows[0]?.total ?? 0);

            let tasks: TaskRecord[] = [];

            if (options.limit !== undefined) {
                const page = options.page ?? 1;
                const offset = (page - 1) * options.limit;

                // Optimization & safety: avoid unbounded OFFSET scan if offset is beyond total rows
                if (offset < total) {
                    const [rows] = await connection.query<mysql.RowDataPacket[]>(
                        `SELECT id, title, completed, owner_id AS ownerId, version
                         FROM tasks
                         WHERE owner_id = ?
                         ORDER BY id ASC
                         LIMIT ? OFFSET ?`,
                        [options.ownerId, options.limit, offset],
                    );

                    tasks = rows.map((row) => ({
                        id: Number(row.id),
                        title: String(row.title),
                        completed: Boolean(row.completed),
                        ownerId: String(row.ownerId),
                        version: Number(row.version),
                    }));
                }
            } else {
                const [rows] = await connection.query<mysql.RowDataPacket[]>(
                    `SELECT id, title, completed, owner_id AS ownerId, version
                     FROM tasks
                     WHERE owner_id = ?
                     ORDER BY id ASC`,
                    [options.ownerId],
                );

                tasks = rows.map((row) => ({
                    id: Number(row.id),
                    title: String(row.title),
                    completed: Boolean(row.completed),
                    ownerId: String(row.ownerId),
                    version: Number(row.version),
                }));
            }

            await connection.commit();

            return { tasks, total };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async update(
        id: number,
        ownerId: string,
        updates: { title?: string | undefined; completed?: boolean | undefined; version?: number | undefined },
    ): Promise<TaskUpdateResult> {
        const connection = await this.pool.getConnection();

        try {
            await connection.beginTransaction();

            // Lock row using FOR UPDATE to prevent concurrent modifications and mis-reporting
            const [rows] = await connection.execute<mysql.RowDataPacket[]>(
                `SELECT id, title, completed, owner_id AS ownerId, version
                 FROM tasks
                 WHERE id = ? AND owner_id = ?
                 FOR UPDATE`,
                [id, ownerId],
            );

            const row = rows[0];
            if (!row) {
                await connection.rollback();
                return { status: "NOT_FOUND" };
            }

            const currentVersion = Number(row.version);

            // Optimistic concurrency check when version is provided
            if (updates.version !== undefined && currentVersion !== updates.version) {
                await connection.rollback();
                return {
                    status: "CONFLICT",
                    currentVersion,
                };
            }

            const nextTitle = updates.title !== undefined ? updates.title : String(row.title);
            const nextCompleted = updates.completed !== undefined ? updates.completed : Boolean(row.completed);
            const nextVersion = currentVersion + 1;

            await connection.execute(
                `UPDATE tasks
                 SET title = ?, completed = ?, version = ?
                 WHERE id = ? AND owner_id = ?`,
                [nextTitle, nextCompleted, nextVersion, id, ownerId],
            );

            await connection.commit();

            return {
                status: "SUCCESS",
                task: {
                    id,
                    title: nextTitle,
                    completed: nextCompleted,
                    ownerId,
                    version: nextVersion,
                },
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}
