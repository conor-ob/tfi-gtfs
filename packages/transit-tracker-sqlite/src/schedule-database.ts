import { DatabaseSync, type StatementSync } from "node:sqlite";

/** Opens a published Schedule file for reading */
export function openSchedule(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * Holds the open Schedule file behind the repositories, so it can be swapped
 * for a newer one. `node:sqlite` is synchronous, so no query is in flight
 * across a swap.
 */
export class ScheduleDatabase {
  private database: DatabaseSync | null;
  // Statements belong to one handle, so they're dropped on a swap
  private statements = new Map<string, StatementSync>();

  constructor(database: DatabaseSync | null = null) {
    this.database = database;
  }

  /** Serves `database` from now on and returns the handle it replaces */
  swap(database: DatabaseSync): DatabaseSync | null {
    const previous = this.database;
    this.database = database;
    this.statements = new Map();
    return previous;
  }

  /** A statement on the current handle, prepared once per handle */
  prepare(sql: string): StatementSync {
    if (!this.database) throw new Error("No Schedule is open");
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  close(): void {
    this.database?.close();
    this.database = null;
    this.statements = new Map();
  }
}
