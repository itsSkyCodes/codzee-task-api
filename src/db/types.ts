export interface TaskRecord {
    id: number;
    title: string;
    completed: boolean;
    ownerId: string;
    version: number;
    createdAt?: Date;
    updatedAt?: Date;
}

export type TaskUpdateResult =
    | { status: "SUCCESS"; task: TaskRecord }
    | { status: "NOT_FOUND" }
    | { status: "CONFLICT"; currentVersion?: number };

export interface TaskRepository {
    create(data: { title: string; ownerId: string }): Promise<TaskRecord>;
    findById(id: number, ownerId: string): Promise<TaskRecord | null>;
    findMany(options: {
        ownerId: string;
        page: number;
        limit: number;
    }): Promise<{ tasks: TaskRecord[]; total: number }>;
    update(
        id: number,
        ownerId: string,
        updates: { title?: string | undefined; completed?: boolean | undefined; version: number },
    ): Promise<TaskUpdateResult>;
    reset(): Promise<void>;
}
