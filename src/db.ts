import { Pool } from "pg";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://agent_admin:mysecretpassword@127.0.0.1:5432/agent_db",
});