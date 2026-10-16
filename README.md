# Codzee Task API

A production-ready, type-safe REST API built with Node.js, Express, and TypeScript. Designed for task management with multi-tenant user isolation, optimistic concurrency control via HTTP ETags, and persistent MySQL storage with transaction-level snapshot consistency.

---

## Table of Contents

- [Features](#features)
- [Architecture & Design](#architecture--design)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Configuration](#environment-configuration)
  - [Running the Application](#running-the-application)
- [API Reference](#api-reference)
  - [Authentication](#authentication)
  - [Endpoints](#endpoints)
    - [Health Check](#health-check)
    - [List Tasks](#list-tasks)
    - [Create Task](#create-task)
    - [Get Task by ID](#get-task-by-id)
    - [Update Task](#update-task)
  - [Optimistic Concurrency Control](#optimistic-concurrency-control)
  - [Pagination Headers](#pagination-headers)
  - [Error Responses](#error-responses)
- [Database Schema & Indexing](#database-schema--indexing)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [License](#license)

---

## Features

- **Multi-Tenant Ownership Isolation:** Tasks are strictly scoped to the authenticated user (`ownerId` from JWT `sub` claim). Requests for another user's task return a neutral `404 Not Found` to prevent information leakage.
- **Optimistic Concurrency Control:** Lost updates are prevented using versioning exposed via standard HTTP `ETag` and `If-Match` headers (or optional `version` in body). Stale writes return `409 Conflict`.
- **Atomic Transactional Updates:** MySQL update operations use `SELECT ... FOR UPDATE` within an InnoDB transaction to prevent race conditions and concurrent write hazards.
- **Snapshot-Consistent Pagination:** `GET /tasks` executes `COUNT(*)` and paginated `SELECT` within a single `REPEATABLE READ` transaction, ensuring total count and returned items always match. Unbounded `OFFSET` scans are short-circuited when `offset >= total`.
- **Overflow-Hardened Schema:** Primary keys (`id`) and `version` columns use MySQL `BIGINT` to prevent 32-bit integer overflow.
- **Strict Input Validation:** Zod schemas validate request bodies, URL parameters, and query parameters before processing.
- **Pluggable Data Layer:** Clean repository pattern (`TaskRepository` interface) with implementations for both MySQL (`MySqlTaskRepository`) and in-memory storage (`InMemoryTaskRepository`).

---

## Architecture & Design

```
                     ┌──────────────────────────┐
                     │       HTTP Client        │
                     └─────────────┬────────────┘
                                   │  JWT (Bearer Token)
                                   ▼
                     ┌──────────────────────────┐
                     │ Express Application      │
                     │  - JSON Body Parser      │
                     │  - Authentication Guard  │
                     │  - Zod Request Validator │
                     └─────────────┬────────────┘
                                   │
                                   ▼
                     ┌──────────────────────────┐
                     │   TaskRepository (IFace) │
                     └──────┬────────────┬──────┘
                            │            │
            (Production)    │            │    (Testing / Fallback)
                            ▼            ▼
             ┌─────────────────┐      ┌─────────────────────────┐
             │ MySqlTaskRepo   │      │ InMemoryTaskRepository  │
             │  - InnoDB Txns  │      │  - Indexed by ownerId   │
             │  - FOR UPDATE   │      │  - Concurrent safe      │
             │  - BIGINT IDs   │      └─────────────────────────┘
             └────────┬────────┘
                      │
                      ▼
             ┌─────────────────┐
             │   MySQL 8.0+    │
             │ (tasks table)   │
             └─────────────────┘
```

---

## Tech Stack

- **Runtime:** Node.js (v20+ with native ESM support)
- **Language:** TypeScript 5+ (Strict mode)
- **Web Framework:** Express 5
- **Database Driver:** `mysql2/promise` with connection pooling
- **Validation:** Zod
- **Security:** `jsonwebtoken` (HS256 with minimum 256-bit / 32-byte secret enforcement)
- **Testing:** Vitest, Supertest

---

## Getting Started

### Prerequisites

- **Node.js**: `v20.0.0` or higher
- **npm**: `v9.0.0` or higher
- **MySQL Server**: `8.0+` or MariaDB `10.5+` (local service, Docker, MAMP, or cloud instance)

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/itsSkyCodes/codzee-task-api.git
cd codzee-task-api
npm install
```

### Environment Configuration

Create a `.env` file in the project root by copying `.env.example`:

```bash
cp .env.example .env
```

Configure your environment variables:

```ini
# Server Configuration
PORT=3000

# Authentication (Minimum 32 bytes for HS256 security)
JWT_SECRET=your-secure-jwt-secret-at-least-32-bytes-long-here

# MySQL Database Configuration
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=tasks_db
```

> **Note:** Make sure the MySQL database (`tasks_db` by default) exists before starting the server. The application will automatically create the `tasks` table and indexes if they do not exist.

```sql
CREATE DATABASE IF NOT EXISTS tasks_db;
```

### Running the Application

#### Development Mode (with hot-reload via tsx):
```bash
npm run dev
```

#### Production Mode:
```bash
npm start
```

---

## API Reference

### Authentication

Protected endpoints require a valid JSON Web Token (JWT) in the `Authorization` header:

```http
Authorization: Bearer <your-jwt-token>
```

The JWT must:
1. Be signed using the **HS256** algorithm with the configured `JWT_SECRET`.
2. Contain a non-empty `sub` claim representing the user ID.
3. Contain a valid numerical `exp` claim (expiration timestamp).

---

### Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | No | Health check and liveness probe |
| `GET` | `/tasks` | Yes | List paginated tasks for authenticated user |
| `POST` | `/tasks` | Yes | Create a new task |
| `GET` | `/tasks/:id` | Yes | Retrieve a single task by ID |
| `PATCH` | `/tasks/:id` | Yes | Update a task with concurrency check |

---

#### Health Check

Verify service health and availability.

```http
GET /health
```

**Response (`200 OK`):**
```json
{
  "status": "ok"
}
```

---

#### List Tasks

Retrieve a paginated list of tasks owned by the authenticated user.

```http
GET /tasks?page=1&limit=20
Authorization: Bearer <token>
```

**Query Parameters:**
- `page` *(optional, default: `1`, max: `10000`)*: Page number (1-based index).
- `limit` *(optional, default: `20`, max: `100`)*: Number of tasks per page.

**Response Headers:**
- `X-Total-Count`: Total number of tasks owned by user.
- `X-Page`: Current page number.
- `X-Limit`: Tasks per page limit.
- `X-Total-Pages`: Total number of pages.

**Response Body (`200 OK`):**
```json
[
  {
    "id": 1,
    "title": "Complete documentation",
    "completed": false
  },
  {
    "id": 2,
    "title": "Setup CI/CD pipeline",
    "completed": true
  }
]
```

---

#### Create Task

Create a new task for the authenticated user.

```http
POST /tasks
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Review database migration"
}
```

**Request Body:**
- `title` *(required)*: Non-empty string between 1 and 200 characters.

**Response Headers:**
- `ETag`: `"<version>"` (e.g., `"1"`)

**Response Body (`201 Created`):**
```json
{
  "id": 3,
  "title": "Review database migration",
  "completed": false
}
```

---

#### Get Task by ID

Retrieve a task by its ID. Users can only access their own tasks.

```http
GET /tasks/3
Authorization: Bearer <token>
```

**Response Headers:**
- `ETag`: `"<version>"` (e.g., `"1"`)

**Response Body (`200 OK`):**
```json
{
  "id": 3,
  "title": "Review database migration",
  "completed": false
}
```

**Error Responses:**
- `404 Not Found`: Task does not exist or belongs to another user.

---

#### Update Task

Update an existing task's title and/or completed status. Optimistic concurrency control is mandatory: you must supply the current task version either via the `If-Match` header or within the JSON body.

##### Option A: Using `If-Match` Header (Recommended)
```http
PATCH /tasks/3
Authorization: Bearer <token>
If-Match: "1"
Content-Type: application/json

{
  "title": "Review database migration and indexes",
  "completed": true
}
```

##### Option B: Using Body `version`
```http
PATCH /tasks/3
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Review database migration and indexes",
  "completed": true,
  "version": 1
}
```

**Request Body Fields:**
- `title` *(optional)*: String (1-200 characters).
- `completed` *(optional)*: Boolean.
- `version` *(optional)*: Integer version (required if `If-Match` header is omitted).
*(At least one of `title` or `completed` must be provided).*

**Response Headers:**
- `ETag`: `"<new-version>"` (e.g., `"2"`)

**Response Body (`200 OK`):**
```json
{
  "id": 3,
  "title": "Review database migration and indexes",
  "completed": true
}
```

**Error Responses:**
- `400 Bad Request`: Neither `version` nor valid `If-Match` was provided, or input validation failed.
- `404 Not Found`: Task does not exist or belongs to another user.
- `409 Conflict`: Task has been modified by another request. Returns the current database version.

```json
{
  "error": "Conflict: Task has been modified by another request",
  "currentVersion": 2
}
```

---

### Optimistic Concurrency Control

To prevent lost updates in multi-client environments:

1. **Read:** Fetch the task via `GET /tasks/:id` or `POST /tasks` and inspect the `ETag` header (e.g. `ETag: "1"`).
2. **Write:** Include `If-Match: "1"` in the `PATCH /tasks/:id` request.
3. **Handle Conflict:** If another client modified the task in the meantime, the server returns `409 Conflict` with `{ currentVersion: 2 }`. The client can re-fetch and re-apply changes.

---

### Error Responses

All errors are returned in standard JSON format:

```json
{
  "error": "Invalid task data",
  "details": [
    {
      "field": "title",
      "message": "String must contain at least 1 character(s)"
    }
  ]
}
```

Common HTTP status codes:
- `400 Bad Request`: Malformed JSON, failed validation, or missing version.
- `401 Unauthorized`: Missing, invalid, or expired JWT credentials.
- `404 Not Found`: Route or resource not found.
- `409 Conflict`: Stale update detected via optimistic locking.
- `500 Internal Server Error`: Server or unhandled database exception.

---

## Database Schema & Indexing

When running against MySQL, the repository automatically creates the table using the following DDL:

```sql
CREATE TABLE IF NOT EXISTS tasks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    owner_id VARCHAR(255) NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_owner_id_id (owner_id, id)
) ENGINE=InnoDB;
```

### Key Schema Decisions:
- **`BIGINT` for ID & Version:** Avoids 32-bit integer limits (`2,147,483,647`), supporting high update volume and scale.
- **Composite Index `idx_owner_id_id (owner_id, id)`:** Optimizes queries filtering by `owner_id` and sorting by `id ASC`, enabling index-only scans for `COUNT(*)` and efficient paginated scans.
- **InnoDB Engine:** Supports atomic ACID transactions and row-level locking (`SELECT ... FOR UPDATE`).

---

## Testing

The project includes unit and integration test suites built with Vitest.

```bash
# Run all tests
npm test
```

### Test Coverage Highlights:
- **API Unit Tests (`tests/app.test.ts`):** 44 tests covering authentication, route authorization, input validation, boundary pagination, ETag concurrency, and error handling with `InMemoryTaskRepository`.
- **MySQL Repository & Integration Tests (`tests/mysql.test.ts`):** 13 tests covering SQL generation, composite indexing, parameterized pagination, transaction isolation, overflow hardening, out-of-bounds offset short-circuiting, and live MySQL concurrency testing with parallel conflicting writes (`Promise.all`).

---

## Project Structure

```
codzee-task-api/
├── src/
│   ├── app.ts            # Express application, routes, and Zod validation
│   ├── server.ts         # Server bootstrap and DB initialization
│   └── db/
│       ├── types.ts      # TaskRecord, TaskRepository interfaces, and DTOs
│       ├── mysql.ts      # MySqlTaskRepository (transactions, row locking)
│       ├── memory.ts     # InMemoryTaskRepository (for testing)
│       └── index.ts      # Repository singleton manager and database init
├── tests/
│   ├── app.test.ts       # HTTP endpoint integration and auth tests
│   └── mysql.test.ts     # MySQL repository, transactions, and live DB tests
├── .env.example          # Environment variable template
├── tsconfig.json         # TypeScript compiler configuration
├── package.json          # Project metadata and dependencies
└── README.md             # Project documentation
```

---

## License

This project is licensed under the [ISC License](LICENSE).
