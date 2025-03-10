import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { parseArgs } from "@std/cli";
import { z } from "zod";
import { createClient, InStatement, ResultSet, Row } from "@libsql/client";
import { stringify as toCsv } from "@std/csv";
import * as log from "@std/log";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

const VERSION = "0.4.0";
const SCHEMA_PROMPT_NAME = "libsql-schema";
const QUERY_PROMPT_NAME = "libsql-query";
const ALL_TABLES = "all-tables";
const FETCH_ALL_TABLES_SQL = "SELECT * FROM sqlite_master WHERE type = 'table'";

interface SqliteMaster extends Row {
  type: string;
  name: string;
  tbl_name: string;
  rootpage: number;
  sql: string;
}

const args = parseArgs(Deno.args);
const argsSchema = z.object({
  "auth-token": z.string().nullish(),
  "log-file": z.string().nullish(),
  "debug": z.boolean().nullish(),
  "_": z.array(z.string().regex(/^(https?|libsql):\/\//)).nonempty(),
});

argsSchema.parse(args);

const dbUrl = args._[0] as string;
const authToken = args["auth-token"];
const debug = args["debug"];
const logLevel = debug ? "DEBUG" : "WARN";

log.setup({
  handlers: {
    file: new log.FileHandler(logLevel, {
      filename: await getLogFilePath(),
      bufferSize: 0,
      formatter: log.formatters.jsonFormatter,
    }),
  },
  loggers: {
    default: {
      level: logLevel,
      handlers: ["file"],
    },
  },
});

const logger = log.getLogger();

const server = new Server(
  {
    name: "context-server/libsql",
    version: VERSION,
  },
  {
    capabilities: {
      resources: {},
      prompts: {},
      tools: {},
    },
  },
);

async function getLogFilePath() {
  const os = Deno.build.os;
  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");

  if (!homeDir) {
    throw new Error("HOME or USERPROFILE environment variable not set");
  }

  let logDir = join(homeDir, ".local", "share", "mcp-server-libsql");

  if (os === "windows") {
    logDir = join(homeDir, "AppData", "Local", "mcp-server-libsql");
  } else if (os !== "darwin" && os !== "linux") {
    throw new Error(`Unsupported OS: ${os}`);
  }

  await ensureDir(logDir);

  return join(logDir, "mcp-server-libsql.log");
}

function executeSql(inStmt: InStatement): Promise<ResultSet> {
  logger.debug("executeSql", inStmt);
  const db = createClient({ url: dbUrl, authToken });
  return db.execute(inStmt);
}

async function fetchAllFromTable(
  tableName: string,
  page: number = 1,
  limit: number = 25,
  outputFormat: "json" | "csv" = "csv",
): Promise<string> {
  const tablesResultSet = await executeSql(FETCH_ALL_TABLES_SQL);
  const sqliteMasterRows = tablesResultSet.rows as SqliteMaster[];
  const validTableNames = sqliteMasterRows.map((row) => row.tbl_name);

  if (!validTableNames.includes(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }

  const queryResultSet = await executeSql({
    sql: `SELECT * FROM ${tableName} LIMIT ? OFFSET ?`,
    args: [limit, (page - 1) * limit],
  });

  if (queryResultSet.rows.length === 0) {
    return `No rows found in table ${tableName}`;
  }

  return outputFormat === "csv"
    ? toCsv(queryResultSet.rows, { columns: queryResultSet.columns })
    : JSON.stringify(queryResultSet.rows);
}

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  logger.debug("ListResourcesRequestSchema", request);

  const rs = await executeSql(FETCH_ALL_TABLES_SQL);
  const rows = rs.rows as SqliteMaster[];
  const tables = rows.map((row) => row.tbl_name);

  return {
    resources: tables.map((table) => ({
      uri: new URL(`${table}/schema`, dbUrl).href,
      name: `${table} table schema`,
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  logger.debug("ReadResourceRequestSchema", request);
  const resourceUrl = new URL(request.params.uri);
  const pathComponents = resourceUrl.pathname.split("/");
  const schema = pathComponents.pop();
  const tableName = pathComponents.pop()?.trim();

  if (schema !== "schema") {
    throw new Error("Invalid resource URI");
  }

  if (tableName === undefined) {
    throw new Error("No table name provided");
  }

  const rs = await executeSql({
    sql: "SELECT * FROM sqlite_master WHERE type = 'table' AND tbl_name = ?",
    args: [tableName],
  });

  if (rs.rows.length === 0) {
    throw new Error(`Table '${tableName}' not found`);
  }

  const rows = rs.rows as SqliteMaster[];

  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "text/plain",
        text: rows[0].sql,
      },
    ],
  };
});

server.setRequestHandler(CompleteRequestSchema, async (request) => {
  logger.debug("CompleteRequestSchema", request);
  if (
    request.params.ref.name === SCHEMA_PROMPT_NAME ||
    request.params.ref.name === QUERY_PROMPT_NAME
  ) {
    const tableNameQuery = request.params.argument.value;
    const alreadyHasArg = /\S*\s/.test(tableNameQuery);

    if (alreadyHasArg) {
      return { completion: { values: [] } };
    }

    const rs = await executeSql(FETCH_ALL_TABLES_SQL);
    const rows = rs.rows as SqliteMaster[];
    const tables = rows.map((row) => row.tbl_name);

    return {
      completion: {
        values: [ALL_TABLES, ...tables],
      },
    };
  }

  throw new Error("unknown prompt");
});

server.setRequestHandler(ListPromptsRequestSchema, (request) => {
  logger.debug("ListPromptsRequestSchema", request);
  return {
    prompts: [
      {
        name: SCHEMA_PROMPT_NAME,
        description:
          "Retrieve the schema for a given table in the libSQL database",
        arguments: [{
          name: "tableName",
          description: "the table to describe",
          required: true,
        }],
      },
      {
        name: QUERY_PROMPT_NAME,
        description: "Query all rows from a table",
        arguments: [{
          name: "tableName",
          description: "the table to query",
          required: true,
        }],
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  logger.debug("GetPromptRequestSchema", request);
  if (request.params.name === SCHEMA_PROMPT_NAME) {
    const tableName = request.params.arguments?.tableName;

    if (typeof tableName !== "string" || tableName.length === 0) {
      throw new Error(`Invalid tableName: ${tableName}`);
    }

    let schema: string;
    if (tableName === ALL_TABLES) {
      const rs = await executeSql(FETCH_ALL_TABLES_SQL);
      const rows = rs.rows as SqliteMaster[];
      schema = rows.map((row) => row.sql).join("\n\n");
    } else {
      const rs = await executeSql({
        sql: "SELECT * FROM sqlite_master WHERE type='table' AND tbl_name = ?",
        args: [tableName],
      });
      const rows = rs.rows as SqliteMaster[];
      schema = rows.map((row) => row.sql).join("\n\n");
    }

    return {
      description: tableName === ALL_TABLES
        ? "all table schemas"
        : `${tableName} schema`,
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "```sql\n" + schema + "\n```",
        },
      }],
    };
  }

  if (request.params.name === QUERY_PROMPT_NAME) {
    const tableName = request.params.arguments?.tableName;

    if (typeof tableName !== "string" || tableName.length === 0) {
      throw new Error(`Invalid tableName: ${tableName}`);
    }

    if (tableName === ALL_TABLES) {
      const rs = await executeSql(FETCH_ALL_TABLES_SQL);
      const rows = rs.rows as SqliteMaster[];
      const tables = rows.map((row) => row.tbl_name);

      const allTablesData = tables.filter((table) => table?.trim()).map(
        (tableName) => {
          return fetchAllFromTable(tableName);
        },
      );

      const result = await Promise.all(allTablesData);
      const data = result.join("\n\n");

      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: data,
          },
        }],
      };
    } else {
      const data = await fetchAllFromTable(tableName);

      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: data,
          },
        }],
      };
    }
  }

  throw new Error(`Prompt '${request.params.name}' not implemented`);
});

server.setRequestHandler(ListToolsRequestSchema, (request) => {
  logger.debug("ListToolsRequestSchema", request);
  return {
    tools: [
      {
        name: "query",
        description: "Run a read-only SQL query",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string" },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  logger.debug("CallToolRequestSchema", request);
  if (request.params.name === "query") {
    const sql = request.params.arguments?.sql as string;
    const res = await executeSql(sql);
    return { content: [{ type: "string", text: JSON.stringify(res.rows) }] };
  }
  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
await server.connect(transport);
