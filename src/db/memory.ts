import type { TaskRecord, TaskRepository, TaskUpdateResult } from "./types.js";

export class InMemoryTaskRepository implements TaskRepository {
    private tasks: Map<number, TaskRecord> = new Map();
    // Composite index mapping ownerId -> array of task IDs (sorted by id ASC)
    private ownerIndex: Map<string, number[]> = new Map();
    private nextId = 1;

    async create(data: { title: string; ownerId: string }): Promise<TaskRecord> {
        const id = this.nextId++;
        const record: TaskRecord = {
            id,
            title: data.title,
            completed: false,
            ownerId: data.ownerId,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        this.tasks.set(id, record);

        let ownerTasks = this.ownerIndex.get(data.ownerId);
        if (!ownerTasks) {
            ownerTasks = [];
            this.ownerIndex.set(data.ownerId, ownerTasks);
        }
        ownerTasks.push(id);

        return { ...record };
    }

    async findById(id: number, ownerId: string): Promise<TaskRecord | null> {
        const record = this.tasks.get(id);
        if (!record || record.ownerId !== ownerId) {
            return null;
        }
        return { ...record };
    }

    async findMany(options: {
        ownerId: string;
        page: number;
        limit: number;
    }): Promise<{ tasks: TaskRecord[]; total: number }> {
        const taskIds = this.ownerIndex.get(options.ownerId) ?? [];
        const total = taskIds.length;

        const offset = (options.page - 1) * options.limit;
        const selectedIds = taskIds.slice(offset, offset + options.limit);

        const tasks: TaskRecord[] = [];
        for (const id of selectedIds) {
            const task = this.tasks.get(id);
            if (task) {
                tasks.push({ ...task });
            }
        }

        return { tasks, total };
    }

    async update(
        id: number,
        ownerId: string,
        updates: { title?: string | undefined; completed?: boolean | undefined; version: number },
    ): Promise<TaskUpdateResult> {
        const record = this.tasks.get(id);

        if (!record || record.ownerId !== ownerId) {
            return { status: "NOT_FOUND" };
        }

        // Optimistic concurrency control check
        if (record.version !== updates.version) {
            return {
                status: "CONFLICT",
                currentVersion: record.version,
            };
        }

        if (updates.title !== undefined) {
            record.title = updates.title;
        }
        if (updates.completed !== undefined) {
            record.completed = updates.completed;
        }
        record.version += 1;
        record.updatedAt = new Date();

        return { status: "SUCCESS", task: { ...record } };
    }

    async reset(): Promise<void> {
        this.tasks.clear();
        this.ownerIndex.clear();
        this.nextId = 1;
    }
}
