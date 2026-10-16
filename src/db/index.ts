import mysql from "mysql2/promise";
import type { TaskRepository } from "./types.js";
import { MySqlTaskRepository } from "./mysql.js";
import { InMemoryTaskRepository } from "./memory.js";

export * from "./types.js";
export * from "./mysql.js";
export * from "./memory.js";

let taskRepositoryInstance: TaskRepository | null = null;

export function getTaskRepository(): TaskRepository {
    if (!taskRepositoryInstance) {
        if (!process.env.MYSQL_HOST) {
            throw new Error(
                "MYSQL_HOST environment variable must be set in .env",
            );
        }
        const pool = mysql.createPool({
            host: process.env.MYSQL_HOST,
            port: Number(process.env.MYSQL_PORT) || 3306,
            user: process.env.MYSQL_USER || "root",
            password: process.env.MYSQL_PASSWORD || "",
            database: process.env.MYSQL_DATABASE || "tasks_db",
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
        });
        taskRepositoryInstance = new MySqlTaskRepository(pool);
    }
    return taskRepositoryInstance;
}

export function setTaskRepository(repo: TaskRepository): void {
    taskRepositoryInstance = repo;
}

export async function initializeDatabase(): Promise<void> {
    const repo = getTaskRepository();
    if (repo instanceof MySqlTaskRepository) {
        const host = process.env.MYSQL_HOST;
        const port = process.env.MYSQL_PORT || "3306";
        const user = process.env.MYSQL_USER || "root";
        const database = process.env.MYSQL_DATABASE || "tasks_db";

        try {
            await repo.init();
            console.log(
                `Database connection established: MySQL (${user}@${host}:${port}/${database})`,
            );
        } catch (error) {
            console.error(
                `Failed to establish MySQL connection to ${user}@${host}:${port}/${database}:`,
                error,
            );
            throw error;
        }
    }
}
